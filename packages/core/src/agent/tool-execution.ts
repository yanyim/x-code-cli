// @x-code-cli/core — 工具执行与分发
import fs from 'node:fs/promises'
import path from 'node:path'

import type { ModelMessage } from 'ai'

import { aggregatePostToolUse, aggregatePreToolUse } from '../hooks/bus.js'
import { classifyDecision } from '../mcp/permissions.js'
import { checkPermission } from '../permissions/index.js'
import { truncateToolResult } from '../tools/index.js'
import { clearProgressReporter, reportProgress } from '../tools/progress.js'
import { getShellProvider } from '../tools/shell-provider.js'
import type { AgentCallbacks, AgentOptions, LanguageModel } from '../types/index.js'
import { debugLog } from '../utils.js'
import { foldShellErrorNoise } from '../utils/shell-error.js'
import { computeEditDiff } from './diff.js'
import { checkForLoop, recordToolCall } from './loop-guard.js'
import type { LoopState } from './loop-state.js'
import { isToolErrorString, toolErrorFromUnknown, toolErrorString, toolResultMessage } from './messages.js'
import { handleEnterPlanMode, handleExitPlanMode, handleTodoWrite } from './plan-tools.js'
import { runSubAgent } from './sub-agents/runner.js'

/** 检测来自任何来源的 AbortError。保留为本地函数（与 loop.ts 中的 helper 重复），
 *  因为提取成共享工具函数要新建一个只有六行的模块。两处逻辑相同。 */
function isAbortError(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true
  if (err instanceof Error) {
    if (err.name === 'AbortError') return true
    if (/aborted|AbortError/i.test(err.message)) return true
  }
  return false
}

/** 计算子串出现次数，不创建中间数组。 */
function countOccurrences(content: string, search: string): number {
  let count = 0
  let pos = 0
  while ((pos = content.indexOf(search, pos)) !== -1) {
    count++
    pos += search.length
  }
  return count
}

/** 执行写工具（writeFile / edit）。
 *
 *  除了返回给模型看的结果字符串，还会触发 callbacks.onFileEdit（如已定义），
 *  传入结构化的 patch，让 UI 在工具条目下渲染彩色 diff。diff payload 是纯 UI
 *  旁路——它不会进入 state.messages，模型只看到短结果字符串。 */
async function executeWriteTool(
  toolName: string,
  input: Record<string, unknown>,
  toolCallId: string,
  callbacks: AgentCallbacks,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (toolName === 'writeFile') {
    const filePath = input.filePath as string
    const content = input.content as string
    reportProgress(toolCallId, `Writing ${filePath}`)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    // 写入之前先读旧内容，以便做 diff。读失败视为"文件不存在"——
    // 覆盖常见的 ENOENT 路径以及权限 / EISDIR 边界情况（反正写入也会报错）。
    let oldContent: string | null = null
    try {
      oldContent = await fs.readFile(filePath, { encoding: 'utf-8', signal })
    } catch {
      oldContent = null
    }
    await fs.writeFile(filePath, content, { encoding: 'utf-8', signal })
    const isNew = oldContent === null
    const parts = content.split('\n')
    const lineCount = content.endsWith('\n') ? parts.length - 1 : parts.length

    const payload = computeEditDiff(filePath, oldContent, content)
    if (payload && callbacks.onFileEdit) callbacks.onFileEdit(toolCallId, payload)

    if (isNew) {
      return `File created: ${filePath} (${lineCount} lines)`
    }
    return `File written: ${filePath} (${lineCount} lines)`
  }

  if (toolName === 'edit') {
    const filePath = input.filePath as string
    const oldString = input.oldString as string
    const newString = input.newString as string
    const replaceAll = (input.replaceAll as boolean) ?? false

    reportProgress(toolCallId, `Editing ${filePath}`)
    const content = await fs.readFile(filePath, { encoding: 'utf-8', signal })
    if (!replaceAll) {
      const count = countOccurrences(content, oldString)
      if (count === 0) return toolErrorString(`old_string not found in ${filePath}`)
      if (count > 1)
        return toolErrorString(
          `old_string is not unique in ${filePath} (found ${count} occurrences). Provide more context or set replaceAll: true.`,
        )
    }

    const newContent = replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString)
    await fs.writeFile(filePath, newContent, { encoding: 'utf-8', signal })

    const payload = computeEditDiff(filePath, content, newContent)
    if (payload && callbacks.onFileEdit) callbacks.onFileEdit(toolCallId, payload)

    return `File edited: ${filePath}`
  }

  return toolErrorString('unknown write tool')
}

/** 执行 shell 命令，支持流式输出。 */
async function executeShell(
  command: string,
  timeout: number,
  signal: AbortSignal | undefined,
  callbacks: AgentCallbacks,
  toolCallId: string,
): Promise<{ output: string; isError: boolean }> {
  const proc = getShellProvider().spawn(command, { timeout, signal })

  reportProgress(toolCallId, 'Running command...')

  // 将实时进度消息节流到最多每 50ms 一次。
  // 原因：PowerShell Format-Table 等表格渲染命令在约 1ms 的突发中发出多行，
  // 每行作为单独的 data 事件。不节流的话每毫秒触发 5-10 次 reportProgress，
  // 每次都变成 setState → ChatInput render → 延迟 stdout write。延迟队列
  // 能吸收大部分突发到一帧中，但如果延迟触发定时器恰好在 tool-result commit
  // 到达前约 1ms 触发，用户会看到明显的"进度文字闪烁，然后结果块滚入"现象。
  // 在源头节流把风暴降到 ≤20 次/秒——快到感觉实时，慢到大幅降低延迟触发
  // 和即将到来的 tool-result commit 冲突的概率。
  // 模型仍通过 result 字段看到完整输出；这里只节流实时进度显示，不影响
  // 到达 LLM 的内容。
  let lastProgressTime = 0
  const PROGRESS_THROTTLE_MS = 50

  const onChunk = (chunk: Buffer) => {
    const s = chunk.toString()
    callbacks.onShellOutput(s)
    const now = Date.now()
    if (now - lastProgressTime < PROGRESS_THROTTLE_MS) return
    // 取 chunk 的最后一个非空行作为进度消息。长时间运行的命令（tsc、
    // 测试套件）流式输出很多行；显示最新的一行是自然的"正在做什么"信号。
    const lines = s.split(/\r?\n/).filter((l) => l.trim().length > 0)
    const last = lines[lines.length - 1]
    if (last) {
      lastProgressTime = now
      const trimmed = last.length > 120 ? last.slice(0, 117) + '...' : last
      reportProgress(toolCallId, trimmed)
    }
  }

  proc.stdout?.on('data', onChunk)
  proc.stderr?.on('data', onChunk)

  const result = await proc
  // 在多行错误块到达模型之前，把它们折叠成一行。Windows 上引号错误的命令
  // 每次尝试发出 5-10 行；在失败重试的循环中这些堆栈积累得比真正的诊断信号
  // 还快。execa 的 stdout/stderr 类型是 string | unknown[] | Uint8Array——
  // 我们用默认字符串模式 spawn，所以类型断言安全，但保留防御性回退。
  const toStr = (v: unknown): string => (typeof v === 'string' ? v : '')
  let stdout = foldShellErrorNoise(toStr(result.stdout))
  let stderr = foldShellErrorNoise(toStr(result.stderr))

  // 当 execa 因超出 maxBuffer 杀死子进程时，部分输出仍在 stdout/stderr 中。
  // 显示清晰的截断通知，让模型不会静默丢失上下文。
  const isMaxBuffer = result.isMaxBuffer ?? false
  if (isMaxBuffer) {
    const INLINE_CAP = 30_000
    if (stdout.length > INLINE_CAP)
      stdout = stdout.slice(0, INLINE_CAP) + '\n... [stdout truncated — exceeded buffer limit]'
    if (stderr.length > INLINE_CAP)
      stderr = stderr.slice(0, INLINE_CAP) + '\n... [stderr truncated — exceeded buffer limit]'
  }

  const output = [stdout, stderr].filter(Boolean).join('\n').trim()
  if (result.exitCode !== 0 || isMaxBuffer) {
    const suffix = isMaxBuffer ? ' (output exceeded buffer limit)' : ''
    const text = output ? `${output}\nExit code ${result.exitCode}${suffix}` : `Exit code ${result.exitCode}${suffix}`
    return { output: text, isError: true }
  }
  return { output: output || 'Done', isError: false }
}

/** 把工具结果推入 state 并通知 UI。 */
function pushToolResult(
  state: LoopState,
  callbacks: AgentCallbacks,
  toolCallId: string,
  toolName: string,
  output: string,
  isError = false,
): void {
  state.messages.push(toolResultMessage(toolCallId, toolName, output))
  // 清除手动分发工具（shell、writeFile、edit、askUser）的进度报告器。
  // 自动执行的工具走 SDK 流的 tool-result 事件，在那里已清除——
  // 这种情况下这个调用是空操作，因为报告器已经不存在了。
  clearProgressReporter(toolCallId)
  callbacks.onToolResult(toolCallId, output, isError)
}

type ToolCall = { toolName: string; toolCallId: string; input: Record<string, unknown> }

/** 传给每个工具处理器的上下文——省去在每个调用点重新列举五个相同的参数。 */
interface HandlerCtx {
  toolName: string
  input: Record<string, unknown>
  toolCallId: string
  state: LoopState
  options: AgentOptions
  callbacks: AgentCallbacks
  parentModel: LanguageModel
}

/** 在 pushToolResult 外包装一层 PostToolUse hook 发射。只有两个"真正的"
 *  成功结果调用点使用它——错误 / 中断 / 权限拒绝路径仍直接调用 pushToolResult，
 *  因为对合成的拒绝发射 PostToolUse 会让 hook 作者困惑。旁路处理器
 * （askUser / task / MCP resources）目前也直接 push；后续可能提升到这里。 */
async function pushSuccessfulToolResult(ctx: HandlerCtx, output: string, isError: boolean): Promise<void> {
  let effectiveOutput = output
  if (ctx.options.hookBus?.has('PostToolUse')) {
    try {
      const decisions = await ctx.options.hookBus.emit(
        {
          name: 'PostToolUse',
          session: { cwd: process.cwd(), modelId: ctx.options.modelId },
          tool: { name: ctx.toolName, args: ctx.input, callId: ctx.toolCallId, output, isError },
        },
        { signal: ctx.options.abortSignal },
      )
      const effect = aggregatePostToolUse(decisions)
      if (effect.output !== undefined) effectiveOutput = effect.output
    } catch (err) {
      if (ctx.options.abortSignal?.aborted) return
      debugLog('agent.hook-post-tool-error', String(err))
    }
  }
  pushToolResult(ctx.state, ctx.callbacks, ctx.toolCallId, ctx.toolName, effectiveOutput, isError)
}

type ToolHandler = (ctx: HandlerCtx) => Promise<void>

/** ── askUser ──
 *  刻意绕过 loop guard。模型两次问用户同一个澄清问题几乎总是有意的
 *  （例如用户回答含糊）；拦截它会静默破坏 UX。 */
async function handleAskUser(ctx: HandlerCtx): Promise<void> {
  const { input, toolCallId, toolName, state, callbacks } = ctx
  const question = input.question as string
  const optionsList = input.options as { label: string; description: string }[]
  const answer = await callbacks.onAskUser(question, optionsList)
  pushToolResult(state, callbacks, toolCallId, toolName, `User answered: ${answer}`)
}

/** ── task（子 agent 分发）── */
async function handleTask(ctx: HandlerCtx): Promise<void> {
  const { input, toolCallId, toolName, state, options, callbacks, parentModel } = ctx
  const agentName = input.subagent_type as string
  const description = input.description as string
  const taskPrompt = input.prompt as string

  reportProgress(toolCallId, `Task: ${description} (${agentName})`)

  const result = await runSubAgent(
    {
      parentState: state,
      parentOptions: options,
      callbacks,
      toolCallId,
      agentName,
      description,
      prompt: taskPrompt,
      knowledgeContext: state.knowledgeContext ?? '',
      isGitRepo: state.isGitRepo ?? false,
    },
    parentModel,
  )

  const statsLine = `<task_stats tool_calls="${result.toolCallCount}" tokens="${result.tokenUsage.totalTokens}" duration_ms="${result.durationMs}" />`
  pushToolResult(state, callbacks, toolCallId, toolName, `${result.resultText}\n${statsLine}`)
}

/** ── listMcpResources ──
 *  纯读取内存中的注册表；无副作用，不需要 loop-guard 或权限检查。
 *  server 过滤参数可选。 */
async function handleListMcpResources(ctx: HandlerCtx): Promise<void> {
  const { input, toolCallId, toolName, state, options, callbacks } = ctx
  const registry = options.mcpRegistry
  if (!registry) {
    pushToolResult(state, callbacks, toolCallId, toolName, toolErrorString('MCP not configured'), true)
    return
  }
  const filter = (input.server as string | undefined)?.trim() || undefined
  const items = registry.listResources().filter((r) => !filter || r.serverName === filter)
  if (items.length === 0) {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      filter ? `No resources on server "${filter}".` : 'No resources from any connected MCP server.',
    )
    return
  }
  const lines = items.map((r) => {
    const mime = r.mimeType ? ` (${r.mimeType})` : ''
    const desc = r.description ? `\n    ${r.description}` : ''
    return `${r.uri}\t[${r.serverName}] ${r.name}${mime}${desc}`
  })
  pushToolResult(state, callbacks, toolCallId, toolName, lines.join('\n'))
}

/** ── readMcpResource ──
 *  转发到所属 server 的 client。错误 / 中止处理与 MCP 工具调用一致。 */
async function handleReadMcpResource(ctx: HandlerCtx): Promise<void> {
  const { input, toolCallId, toolName, state, options, callbacks } = ctx
  const registry = options.mcpRegistry
  if (!registry) {
    pushToolResult(state, callbacks, toolCallId, toolName, toolErrorString('MCP not configured'), true)
    return
  }
  const uri = (input.uri as string | undefined) ?? ''
  if (!uri) {
    pushToolResult(state, callbacks, toolCallId, toolName, toolErrorString('Missing `uri` argument'), true)
    return
  }
  const client = registry.resourceServer(uri)
  if (!client) {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      toolErrorString(`Resource URI not known: ${uri} — call listMcpResources first`),
      true,
    )
    return
  }
  reportProgress(toolCallId, `Reading ${uri}`)
  try {
    const result = await client.readResource(uri, options.abortSignal)
    pushToolResult(state, callbacks, toolCallId, toolName, truncateToolResult(result.text))
  } catch (err) {
    if (isAbortError(err, options.abortSignal)) {
      pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
      return
    }
    pushToolResult(state, callbacks, toolCallId, toolName, toolErrorFromUnknown(err), true)
  }
}

/** 绕过 loop guard 和 writeFile/edit/shell 权限 + 执行管线的手动工具。
 *  每个处理器拥有自己的 pushToolResult 调用。添加新的旁路工具只需在这里加一行。 */
const BYPASS_LOOP_GUARD_HANDLERS: Record<string, ToolHandler> = {
  askUser: handleAskUser,
  task: handleTask,
  todoWrite: ({ input, toolCallId, state, callbacks }) =>
    handleTodoWrite(input, toolCallId, state, callbacks, pushToolResult),
  enterPlanMode: ({ input, toolCallId, state, options, callbacks }) =>
    handleEnterPlanMode(input, toolCallId, state, options, callbacks, pushToolResult),
  exitPlanMode: ({ input, toolCallId, state, callbacks }) =>
    handleExitPlanMode(input, toolCallId, state, callbacks, pushToolResult),
  listMcpResources: handleListMcpResources,
  readMcpResource: handleReadMcpResource,
}

/** 对非旁路工具运行 loop-guard 机制。如果工具被拦截返回 true（调用方应停止分发）。
 *
 *  自动执行的工具永远不会到这里——processToolCalls 在前面就跳过了它们，
 *  因为它们的结果已经通过 SDK 的 response.messages 在 state.messages 中了，
 *  在这里再跑 loop-guard 会在那上面叠加合成结果，或注入一个破坏严格供应商
 *  要求的 assistant→tool 排序的迭代内 user 消息。
 *
 *  `deferred` 收集必须在迭代的所有 tool_results 之后才落地的消息——
 *  迭代中推送会产生 `assistant → tool A → user → tool B` 的模式，
 *  DeepSeek 会对此 400。 */
async function applyLoopGuard(ctx: HandlerCtx, deferred: ModelMessage[]): Promise<boolean> {
  const { toolName, input, toolCallId, state, callbacks } = ctx
  const loopCheck = checkForLoop(state, toolName, input, toolCallId)

  if (loopCheck.kind === 'ok') {
    recordToolCall(state, toolName, input, loopCheck.hash)
    return false
  }

  recordToolCall(state, toolName, input, loopCheck.hash)
  const guardMessage = `[loop-guard] ${loopCheck.message}`
  // 手动工具——用合成结果短路。工具体从不运行；无副作用，无权限提示。
  pushToolResult(state, callbacks, toolCallId, toolName, guardMessage, true)

  if (loopCheck.kind === 'hard-block') {
    const answer = await callbacks
      .onAskUser(`The model keeps calling ${toolName} with identical arguments. How do you want to proceed?`, [
        { label: 'Pause', description: 'Pause the turn — you can type a new instruction.' },
        { label: 'Continue', description: 'Let the model keep trying; the loop guard stays armed.' },
      ])
      .catch(() => 'Pause')
    if (answer.toLowerCase().startsWith('pause')) {
      // 清空 recent-calls 窗口，让 guard 不会在下一轮模型在用户指导下
      // 合法重试同一参数时立即再触发。
      state.recentToolCalls = []
      // 延迟到迭代之后，让 user 角色消息落在本轮消息的末尾，而非工具结果之间。
      deferred.push({
        role: 'user',
        content: '[loop-guard] User paused the loop. Wait for further instructions rather than calling more tools.',
      })
    }
  }
  return true
}

/** writeFile/edit/shell 的权限门。返回 true 表示应继续执行，
 *  false 表示被阻止 / 拒绝 / 中止。 */
async function checkWriteOrShellPermission(ctx: HandlerCtx): Promise<boolean> {
  const { toolName, input, toolCallId, state, options, callbacks } = ctx
  if (toolName !== 'writeFile' && toolName !== 'edit' && toolName !== 'shell') return true

  const approved = await checkPermission(
    { toolCallId, toolName, input },
    options.trustMode,
    callbacks.onAskPermission,
    state.permissionMode,
    process.cwd(),
  )
  if (options.abortSignal?.aborted) {
    pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
    return false
  }
  if (!approved) {
    pushToolResult(state, callbacks, toolCallId, toolName, 'Permission denied by user.')
    return false
  }
  return true
}

/** 运行 writeFile/edit/shell 的底层有副作用工具体。
 *  自动执行的工具因 AI SDK 已产生结果而提前返回。
 *  返回执行后的 { output, isError } 对，或 null（自动执行工具无需推送）。 */
async function executeWriteOrShell(ctx: HandlerCtx): Promise<{ output: string; isError: boolean } | null> {
  const { toolName, input, toolCallId, state, options, callbacks } = ctx
  try {
    if (toolName === 'writeFile' || toolName === 'edit') {
      const output = await executeWriteTool(toolName, input, toolCallId, callbacks, options.abortSignal)
      // executeWriteTool 对带内失败（未找到匹配、匹配不唯一）返回 "Error: ..."
      // 字符串而不是抛异常——把它们标记为错误结果，让回滚行变红。
      const isError = isToolErrorString(output)
      if (!isError) state.filesModified.add(input.filePath as string)
      return { output, isError }
    }
    if (toolName === 'shell') {
      const timeout = (input.timeout as number) ?? 30000
      const shellResult = await executeShell(
        input.command as string,
        timeout,
        options.abortSignal,
        callbacks,
        toolCallId,
      )
      return { output: shellResult.output, isError: shellResult.isError }
    }
    // 自动执行的工具（readFile / glob / grep 等）已被 AI SDK 执行，返回 null
    return null
  } catch (err) {
    return { output: toolErrorFromUnknown(err), isError: true }
  }
}

/** 处理单个工具调用。调用完成时返回。`parentModel` 是当前循环的 LanguageModel
 *  实例——task 工具需要传给子 agent 作为 fallback。`deferred` 是每轮的延迟
 *  消息队列，向下传给 applyLoopGuard；在此收集的消息在 processToolCalls 的
 *  整个迭代结束后刷出。 */
async function handleToolCall(
  tc: ToolCall,
  state: LoopState,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  parentModel: LanguageModel,
  deferred: ModelMessage[],
): Promise<void> {
  const ctx: HandlerCtx = {
    toolName: tc.toolName,
    input: tc.input,
    toolCallId: tc.toolCallId,
    state,
    options,
    callbacks,
    parentModel,
  }

  // ── 插件 hook：PreToolUse ──
  // 在旁路处理器路由和 MCP 分发之前触发，这样 hook 能看到模型尝试的每个工具
  //（包括 askUser、task 和 MCP 工具）。deny 变成合成的 tool_result，模型能看到，
  // 保持 state.messages 有效。modify 可以改写 input 记录（原地修改 ctx.input，
  // 下游处理器和 loop guard 看到修改后的参数）。
  if (ctx.options.hookBus?.has('PreToolUse')) {
    try {
      const decisions = await ctx.options.hookBus.emit(
        {
          name: 'PreToolUse',
          session: { cwd: process.cwd(), modelId: ctx.options.modelId },
          tool: { name: ctx.toolName, args: ctx.input, callId: ctx.toolCallId },
        },
        { signal: ctx.options.abortSignal },
      )
      const effect = aggregatePreToolUse(decisions)
      if (effect.decision === 'deny') {
        const reason = effect.reason ?? 'blocked by plugin hook'
        pushToolResult(
          state,
          callbacks,
          ctx.toolCallId,
          ctx.toolName,
          toolErrorString(`Tool denied by plugin hook: ${reason}`),
          true,
        )
        return
      }
      if (effect.args && typeof effect.args === 'object' && !Array.isArray(effect.args)) {
        ctx.input = effect.args as Record<string, unknown>
      }
    } catch (err) {
      if (ctx.options.abortSignal?.aborted) return
      debugLog('agent.hook-pre-tool-error', String(err))
    }
  }

  const bypassHandler = BYPASS_LOOP_GUARD_HANDLERS[ctx.toolName]
  if (bypassHandler) {
    await bypassHandler(ctx)
    return
  }

  // MCP 工具走独立的权限路径（per-tool ask + always-allow 文件），而非
  // writeFile/edit/shell 的规则。它们仍通过 loop-guard，防止模型在失败的
  // MCP 调用上无限旋转。
  //
  // 路由通过注册表查找而非名称模式——MCP 工具名是 <server>__<tool>
  //（无特殊前缀），所以唯一权威的"这是 MCP 吗？"答案是"它在 MCP 注册表中吗？"。
  if (ctx.options.mcpRegistry?.get(ctx.toolName)) {
    await handleMcpToolCall(ctx, deferred)
    return
  }

  if (await applyLoopGuard(ctx, deferred)) return
  if (!(await checkWriteOrShellPermission(ctx))) return

  const result = await executeWriteOrShell(ctx)
  if (result == null) return

  await pushSuccessfulToolResult(ctx, truncateToolResult(result.output), result.isError)
}

/** MCP 工具调用的分发。与 writeFile/edit/shell 管线平行——相同的 loop-guard、
 *  相同的中止处理，但使用独立的工具权限存储和 MCP 注册表的 callTool。 */
async function handleMcpToolCall(ctx: HandlerCtx, deferred: ModelMessage[]): Promise<void> {
  const { toolName, input, toolCallId, state, options, callbacks } = ctx
  const registry = options.mcpRegistry
  const permissions = options.mcpPermissionStore

  if (!registry) {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      toolErrorString(`MCP not configured; tool ${toolName} unavailable`),
      true,
    )
    return
  }

  const entry = registry.get(toolName)
  if (!entry) {
    pushToolResult(state, callbacks, toolCallId, toolName, toolErrorString(`MCP tool not found: ${toolName}`), true)
    return
  }

  // loop-guard 优先：即使被 mode 拒绝的调用也算作模型在"尝试"某事，
  // 我们也想捕捉拒绝循环。
  if (await applyLoopGuard(ctx, deferred)) return

  // plan mode：MCP 工具是不透明的（我们不知道它是否写入），
  // 所以唯一安全的立场是"不允许"。模型会看到拒绝作为工具结果，
  // 如果确实需要外部工具来继续，应该调用 exitPlanMode。
  if (state.permissionMode === 'plan') {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      'MCP tools are disabled in plan mode. Call exitPlanMode first if you need this tool.',
      true,
    )
    return
  }

  // 权限门控。trustMode 跳过一切；否则查询存储（会话 + 持久化的 always-allow），
  // 回退到询问用户。
  let approved = options.trustMode
  if (!approved && permissions) approved = await permissions.isApproved(toolName)

  if (!approved) {
    let decision: 'yes' | 'always' | 'no'
    try {
      decision = await callbacks.onAskPermission({ toolCallId, toolName, input })
    } catch (err) {
      if (isAbortError(err, options.abortSignal)) {
        pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
        return
      }
      throw err
    }
    if (options.abortSignal?.aborted) {
      pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
      return
    }
    const choice = classifyDecision(decision)
    if (choice === 'deny') {
      pushToolResult(state, callbacks, toolCallId, toolName, 'Permission denied by user.')
      return
    }
    if (permissions) {
      if (choice === 'allow-always') await permissions.approvePermanently(toolName)
      else permissions.approveForSession(toolName)
    }
  }

  // 执行。abortSignal 一路穿透到 SDK 请求，Esc 立即取消进行中的 MCP 调用。
  reportProgress(toolCallId, `Calling ${entry.serverName}/${entry.rawName}`)
  try {
    const result = await registry.callTool(toolName, ctx.input, options.abortSignal)
    await pushSuccessfulToolResult(ctx, truncateToolResult(result.text), result.isError)
  } catch (err) {
    if (isAbortError(err, options.abortSignal)) {
      pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
      return
    }
    pushToolResult(state, callbacks, toolCallId, toolName, toolErrorFromUnknown(err), true)
  }
}

/** 收集 AI SDK 本轮实际提交到 assistant 消息中的所有 toolCallId。
 *
 *  SDK 的 result.toolCalls promise 与 response.messages 独立——当 zod 验证
 *  在流中途拒绝了格式错误的 tool input 时，SDK 发出 tool-error chunk 并把
 *  该 tool_call 从 response.messages 中排除，但它仍可能出现在 toolCalls 中。
 *  执行这种"幽灵"调用会产生两个坏结果：
 *    1. write/edit/shell 会为模型从未正式提交的调用触发真实副作用。
 *    2. 推入的 tool_result 会成为 state.messages 中的孤儿（前面没有包含
 *       该 id 的 assistant tool_call），下一次 API 请求会 400：
 *       "tool must be a response to a preceding message with tool_calls"。
 *  返回集合让 processToolCalls 在任何处理器运行前过滤 SDK 的列表。
 *
 *  从 state.messages 末尾向前遍历，收集遇到的每个 assistant 消息中的
 *  tool-call id，直到遇到非 assistant/tool 边界——覆盖某些供应商产生的
 *  多 assistant 轮次结构，同时在遇到前一个 user 消息时停止，避免旧轮次
 *  的 id 泄漏进来。 */
function collectActiveAssistantToolCallIds(state: LoopState): Set<string> {
  const ids = new Set<string>()
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i]
    if (!msg) continue
    if (msg.role === 'user') break
    if (msg.role !== 'assistant') continue
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string; toolCallId?: string }>) {
      if (part?.type === 'tool-call' && typeof part.toolCallId === 'string') {
        ids.add(part.toolCallId)
      }
    }
  }
  return ids
}

/** 收集当前轮 state.messages 窗口中已有 tool-result 消息的 tool_call_id。
 *  在 processToolCalls 运行前，有两个不同的上游路径会在这里放入结果：
 *    1. AI SDK 自动执行的工具（readFile / glob / grep / listDir / webFetch /
 *       webSearch）——结果在 response.messages 中，由 collectTurnResponse 在
 *       我们迭代之前推入。
 *    2. AI SDK 对不可用工具的自动拒绝——当子 agent 的 toolFilter 排除了模型
 *       仍发出 tool-call 的工具（如 general-purpose agent 调用 writeFile）时，
 *       SDK 合成 error-text tool-result，避免 assistant 消息留下孤立的 tool-call。
 *  两种情况下在此重新运行工具都是错误的：
 *    - 情况 1：工具已执行；再跑一次会重复副作用（重新获取网页、重新触发 saveKnowledge）。
 *    - 情况 2：工具在本 agent 的 filter 下本不该运行，但 executeWriteTool
 *      按名称分派，会愉快地执行 writeFile，产生真实副作用并推入 DeepSeek
 *      下一轮会 400 的重复 tool-result。
 *  与 collectActiveAssistantToolCallIds 相同的轮次边界逻辑——从 messages
 *  末尾向前遍历，遇到第一个 user 消息停止。 */
function collectFulfilledToolCallIds(state: LoopState): Set<string> {
  const ids = new Set<string>()
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i]
    if (!msg) continue
    if (msg.role === 'user') break
    if (msg.role !== 'tool') continue
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string; toolCallId?: string }>) {
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') {
        ids.add(part.toolCallId)
      }
    }
  }
  return ids
}

/** 把连续的 `task` 工具调用归为一个批次，以便并行分发；其他工具各自形成
 *  单元素批次，一个一个串行执行。`task` 工具派生的子 agent 是 processToolCalls
 *  手动执行的工具中唯一真正隔离的：
 *    - 每个 runSubAgent 构建新的 LoopState（自己的 messages、自己的
 *      recentToolCalls、自己的 todos、自己的权限模式）
 *    - parentState.tokenUsage 通过子 agent 完成后的累加更新，所以并发更新
 *      不会被撕裂（单线程事件循环 + 纯 += 写入）
 *    - 并发子 agent 的权限弹窗在父 UI 的 permissionResolversRef 上自然排队
 *  其他所有手动工具都修改共享状态，必须保持串行：
 *    - writeFile / edit 修改文件系统和 state.filesModified
 *    - shell 向父 UI 流式输出 stdout/stderr——并发 shell 的交错字节会扰乱
 *      实时指示器
 *    - askUser / 权限弹窗持有 UI；同时跑两个会竞争弹窗状态机
 *    - todoWrite / enterPlanMode / exitPlanMode 修改下一轮读取的 LoopState 字段
 *  自动执行的工具（readFile / glob / grep / listDir / webFetch / webSearch）
 *  不会出现在这里——processToolCalls 运行时 SDK 已经执行了它们，
 *  skip-fulfilled 预处理把它们短路掉了。 */
export function partitionToolCalls(calls: ToolCall[]): ToolCall[][] {
  const batches: ToolCall[][] = []
  let i = 0
  while (i < calls.length) {
    let end = i + 1
    if (calls[i]!.toolName === 'task') {
      while (end < calls.length && calls[end]!.toolName === 'task') {
        end++
      }
    }
    batches.push(calls.slice(i, end))
    i = end
  }
  return batches
}

/** 处理单次模型轮次的所有工具调用。
 *
 *  连续的 task 工具调用通过 Promise.all 并行分发；其他工具逐个串行执行。
 *  关于为什么只有子 agent 可以并行的完整理由，见 partitionToolCalls。
 *
 *  `parentModel` 穿透传递，以便 task 工具传给 runSubAgent。 */
export async function processToolCalls(
  toolCalls: ToolCall[],
  state: LoopState,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  parentModel: LanguageModel,
): Promise<void> {
  const activeIds = collectActiveAssistantToolCallIds(state)
  const fulfilledIds = collectFulfilledToolCallIds(state)
  // 每轮的延迟消息队列——消息必须在我们推送的所有 tool-result 之后落地。
  // 在两个 tool-result 之间推送 role: 'user' 消息会产生 DeepSeek 严格排序
  // 拒绝的形状——我们在这里收集，循环结束时刷出。
  const deferred: ModelMessage[] = []

  // 预处理：丢弃幽灵调用，处理已 fulfilled 的调用。存活的进入 liveCalls，
  // 这是我们实际分发的列表。在分区前做这件事，让并行批次分发保持简单——
  // 批次中的每个条目都是需要运行的真实调用。
  const liveCalls: ToolCall[] = []
  for (const tc of toolCalls) {
    // 跳过 SDK 在流中途拒绝的幽灵调用——完整理由见 collectActiveAssistantToolCallIds。
    // 也不 pushToolResult：assistant 消息中没有匹配的 tool_call，任何我们发出的
    // 结果都是孤儿，下一轮 sanitizer 也会丢掉。双保险：如果这个检查漏了，
    // sanitizer 的反向孤儿分支仍会清理。
    if (activeIds.size > 0 && !activeIds.has(tc.toolCallId)) {
      debugLog(
        'tool-exec.skip-ghost',
        `${tc.toolName} ${tc.toolCallId} — not in assistant tool_calls, likely SDK tool-error reject`,
      )
      continue
    }

    // 跳过已 fulfilled 的调用——见 collectFulfilledToolCallIds。
    // 仍在 loop-guard 窗口中记录调用，这样对同一自动执行工具的失控模式
    // 可以在未来的轮次被熔断；如果 guard 触发，延迟 user-role nudge
    // 到迭代之后。
    if (fulfilledIds.has(tc.toolCallId)) {
      debugLog('tool-exec.skip-fulfilled', `${tc.toolName} ${tc.toolCallId} — tool-result already in state.messages`)
      const loopCheck = checkForLoop(state, tc.toolName, tc.input, tc.toolCallId)
      recordToolCall(state, tc.toolName, tc.input, loopCheck.hash)
      if (loopCheck.kind !== 'ok') {
        deferred.push({ role: 'user', content: `[loop-guard] ${loopCheck.message}` })
      }
      continue
    }

    liveCalls.push(tc)
  }

  // 按批次分发。大小为 1 的批次在功能上等同于普通 `await handleToolCall(...)`——
  // 单个 promise 上的 Promise.all 解析方式相同——所以并行路径统一处理两种情况。
  const batches = partitionToolCalls(liveCalls)
  let dispatched = 0
  for (const batch of batches) {
    // 用户按了 Esc / Ctrl+C。当前运行的工具（如有）已通过 shell provider 的
    // cancelSignal 被 SIGKILL。对于剩余的每个 tool_call，仍需推送合成的
    // tool_result——没有匹配结果的孤儿 tool_call 会导致用户输入下一条 prompt
    // 时下一次 API 请求以 "tool_use without tool_result" 失败。
    if (options.abortSignal?.aborted) {
      for (let j = dispatched; j < liveCalls.length; j++) {
        pushToolResult(
          state,
          callbacks,
          liveCalls[j]!.toolCallId,
          liveCalls[j]!.toolName,
          '[Tool execution interrupted by user]',
          true,
        )
      }
      break
    }

    await Promise.all(batch.map((tc) => handleToolCall(tc, state, options, callbacks, parentModel, deferred)))
    dispatched += batch.length
  }

  // 在本轮所有 tool_results 之后刷出延迟消息——它们位于 state.messages 的
  // 最末尾，下一轮 runTurn 把它们视为最近的上下文，但不会破坏 SDK 会
  // 重放给供应商的 assistant→tool 排序。
  if (deferred.length > 0) state.messages.push(...deferred)
}
