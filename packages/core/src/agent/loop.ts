// @x-code-cli/core — Agent Loop（编排：流式输出、工具调用、权限控制）
//
// 上下文压缩逻辑在 `./compression.ts`；本文件只编排每轮的流式请求 + 工具分发循环。
import fs from 'node:fs/promises'
import path from 'node:path'

import { streamText } from 'ai'
import type { LanguageModel, UserContent } from 'ai'

import { aggregateUserPromptSubmit } from '../hooks/bus.js'
import type { HookEvent } from '../hooks/types.js'
import { buildKnowledgeContext } from '../knowledge/loader.js'
import { listMcpResources, readMcpResource } from '../mcp/resources.js'
import { bridgeMcpTool, toSystemPromptEntries } from '../mcp/tool-bridge.js'
import { applyCacheControl } from '../providers/cache-control.js'
import { getThinkingProviderOptions, mergeThinkingOptions } from '../providers/thinking.js'
import { createActivateSkillTool } from '../tools/activate-skill.js'
import { toolRegistry, truncateToolResult } from '../tools/index.js'
import { clearProgressReporter, setProgressReporter } from '../tools/progress.js'
import { createTaskTool } from '../tools/task.js'
import type { AgentCallbacks, AgentOptions } from '../types/index.js'
import { debugLog } from '../utils.js'
import { classifyApiError, isContextTooLongError } from './api-errors.js'
import { checkAndCompressContext, handleContextTooLong } from './compression.js'
import { getCompressionThreshold, getMaxOutputTokens } from './context-window.js'
import { createLoopState } from './loop-state.js'
import type { LoopState } from './loop-state.js'
import { runMemoryExtractor } from './memory-extractor.js'
import { generateTaskSlug, makePlanFilePath } from './plan-storage.js'
import { downgradeBinaryPartsForProvider, ensureReasoningContentParts } from './provider-compat.js'
import { appendHeader, appendUsage, flushPendingMessages } from './session-store.js'
import { drainStreamResult } from './stream-utils.js'
import type { StreamResult } from './stream-utils.js'
import { buildSystemPrompt } from './system-prompt.js'
import { processToolCalls } from './tool-execution.js'
import { repairOrphanToolCalls, truncateToolResultsInMessages } from './tool-result-sanitize.js'

/** 把注入的上下文块拼接到 UserContent 载荷前面。
 *  UserPromptSubmit hook 的 `modify` 决策使用：插件可以在模型看到用户
 *  真实 prompt 之前注入上下文（如当前 sprint 信息）。
 *  拼入用户消息体内而不是插入第二条 user 消息——某些供应商拒绝连续两条
 *  role==='user' 消息（Claude 拒绝 user 角色交替两次）。 */
function prependContext(userMessage: UserContent, context: string): UserContent {
  const block = `<plugin_context>\n${context}\n</plugin_context>\n\n`
  if (typeof userMessage === 'string') return block + userMessage
  return [{ type: 'text', text: block }, ...userMessage]
}

/** 从 UserContent 载荷中提取纯文本，用于 slug 化。
 *  UserContent 可以是字符串或多部分数组（buildUserContent 消化 @path
 *  引用后的 text/image/file parts）；只关心文本片段——image/file parts
 *  对人类可读的文件名没有贡献。 */
function userContentToText(content: UserContent): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(
        (p): p is { type: 'text'; text: string } =>
          p?.type === 'text' && typeof (p as { text?: unknown }).text === 'string',
      )
      .map((p) => p.text)
      .join(' ')
  }
  return ''
}

export type { LoopState } from './loop-state.js'
// 为 CLI 的 resume / manual-compact 路径重新导出（见 use-agent.ts）。
export { compressMessages } from './compression.js'

/** agentLoop 的返回值。
 *
 *  - `state` 是长期存活的会话状态（messages / tokenUsage 等）。
 *    主交互 CLI 把它存在 loopStateRef 中，下次用户提交时作为 existingState 回传。
 *  - `turnCount` 是本次调用跑了多少轮 streamText。不在 state 上——放在上面
 *    意味着跨提交累积计数，而实际上每次进 agentLoop 都从 0 开始。
 *    sub-agent runner 和 --print 模式是真正的消费方；主交互 loop 忽略它。 */
export interface AgentLoopResult {
  state: LoopState
  turnCount: number
}

/** 消费 streamText 输出，通过回调把 chunk 分发到 UI。
 *  reasoning-delta chunk（思考模式模型——DeepSeek-reasoner、o1 等）刻意忽略：
 *  那是模型内部思维链，不是用户可见的输出。最终用户看到的答案
 *  作为普通 text-delta chunk 到达。 */
async function streamChunksToUI(result: StreamResult, callbacks: AgentCallbacks): Promise<void> {
  for await (const chunk of result.fullStream) {
    if (chunk.type === 'error') {
      // AI SDK 不会在 fullStream 迭代中因请求失败而抛异常——它把这个 chunk
      // 排入队列然后关闭流（stream-text.ts:1910）。如果不 re-throw，循环正常结束，
      // 然后 `await result.response` 以 NoOutputGeneratedError 拒绝——用户看到
      // 那条通用消息而不是真实的供应商错误（如"余额不足"）。
      // 抛出原始包装错误，让外层 try/catch 传给 classifyApiError。
      throw chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error))
    }
    if (chunk.type === 'text-delta') {
      const text = chunk.text ?? ''
      debugLog('stream.text-delta', text)
      callbacks.onTextDelta(text)
    } else if (chunk.type === 'tool-call') {
      debugLog('stream.tool-call', `${chunk.toolName ?? ''} ${JSON.stringify(chunk.input ?? {})}`)
      const toolCallId = chunk.toolCallId ?? ''
      // 在工具开始执行之前注册进度旁路通道——AI SDK 会在本事件之后立即同步
      // 调用 execute(input, { toolCallId })，那些工具调用 reportProgress
      // (toolCallId, ...) 来流式反馈状态更新。
      if (toolCallId) {
        setProgressReporter(toolCallId, (msg) => callbacks.onToolProgress(toolCallId, msg))
      }
      callbacks.onToolCall(toolCallId, chunk.toolName ?? '', (chunk.input ?? {}) as Record<string, unknown>)
    } else if (chunk.type === 'tool-result') {
      // 通知 UI 自动执行工具的结果（readFile, glob, grep 等）
      const raw = typeof chunk.output === 'string' ? chunk.output : JSON.stringify(chunk.output ?? '')
      debugLog('stream.tool-result', `${chunk.toolCallId ?? ''} ${raw}`)
      if (chunk.toolCallId) clearProgressReporter(chunk.toolCallId)
      callbacks.onToolResult(chunk.toolCallId ?? '', truncateToolResult(raw))
    } else {
      debugLog('stream.other-chunk', chunk.type)
    }
    // reasoning-delta / reasoning-start / reasoning-end：刻意不进 UI，
    // 但在 debug 模式下通过 stream.other-chunk 记录。
  }
}

/** 从已完成的流中取出 response + usage，合并进 state。 */
async function collectTurnResponse(
  result: StreamResult,
  state: LoopState,
  modelId: string,
  callbacks: AgentCallbacks,
): Promise<string> {
  const response = await result.response
  // 关键：自动执行的工具（readFile / grep / glob / listDir / webFetch / webSearch）
  // 的结果通过 response.messages 回流，绕过了手动 pushToolResult 路径。
  // 如果不在这里跑一遍截断，读一个 800 行文件或匹配 2000 次的 grep 会把
  // 全文灌入 state.messages，然后跟着每轮请求一起送出去。已知最严重的案例：
  // 累积失败 shell 堆栈 + 未截断文件读取构建了 9M token 的上下文。
  // 在此截断，确保持久化的消息和循环中其他地方使用的按工具预算一致。
  truncateToolResultsInMessages(response.messages)
  state.messages.push(...response.messages)
  ensureReasoningContentParts(state.messages, modelId)

  const usage = await result.usage
  if (usage) {
    state.tokenUsage.inputTokens += usage.inputTokens ?? 0
    state.tokenUsage.outputTokens += usage.outputTokens ?? 0
    // AI SDK v6 把供应商缓存字段标准化到 inputTokenDetails：
    //   cacheReadTokens  ← Anthropic cache_read_input_tokens / OpenAI cached_tokens
    //   cacheWriteTokens ← Anthropic cache_creation_input_tokens（其他供应商：0）
    // 两者都是 inputTokens 的子集，不计入 total 以避免重复计数。
    state.tokenUsage.cacheReadTokens += usage.inputTokenDetails?.cacheReadTokens ?? 0
    state.tokenUsage.cacheCreationTokens += usage.inputTokenDetails?.cacheWriteTokens ?? 0
    state.tokenUsage.totalTokens = state.tokenUsage.inputTokens + state.tokenUsage.outputTokens
    // 从本次响应快照当前上下文窗口占用——覆写，不累积。
    // 包含 input + output，因为所有主流供应商（Anthropic、OpenAI、Google、
    // DeepSeek、Moonshot、Alibaba、xAI）都把上下文窗口定义为 input + output
    // 的共享预算池：input + output ≤ context_window 是架构约束（单一 KV-cache 容量）。
    // AI SDK 的 inputTokens 已包含 cache_read + cache_write，所以这是
    // "模型看到的完整 prompt + 它刚写的输出"——直接与 getContextWindow(modelId)
    // 在底部状态栏的 "N / M · X%" 指示器中比较。
    // 上面的累计计数器仍然用于 /usage 账单汇总。
    state.tokenUsage.currentContextTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
    if (usage.inputTokens != null) state.lastInputTokens = usage.inputTokens
    callbacks.onUsageUpdate(state.tokenUsage)
    // 在 jsonl transcript 内持久化一个用量快照。每轮一次：
    // 选择器的尾部扫描只需要最新条目，但每轮都写确保崩溃进程不会丢失
    // 最终计数。Fire-and-forget——绝不阻塞循环。
    void appendUsage(state, modelId)
  }

  return result.finishReason
}

type TurnOutcome =
  /** 轮次正常完成；finishReason 决定下一步做什么 */
  | { kind: 'done'; finishReason: string; result: StreamResult }
  /** 不可恢复错误（已通过 callbacks 报告）；调用方应 break 循环 */
  | { kind: 'error' }
  /** 上下文溢出并已压缩；调用方应重试本轮 */
  | { kind: 'retry' }
  /** 用户中止请求（Esc / Ctrl+C）。不报告到 onError——
   *  UI 显示 `[Request interrupted by user]` 通知代替 */
  | { kind: 'aborted' }

/** 检测 streamText / fetch 的 AbortError——SDK 表示我们取消了请求。
 *  同时接受 abortSignal 已 aborted 时出现的任何错误——某些供应商把底层
 *  AbortError 包装进自己的错误类，但会先把 signal 置为 aborted。 */
function isAbortError(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true
  if (err instanceof Error) {
    if (err.name === 'AbortError') return true
    if (/aborted|AbortError/i.test(err.message)) return true
  }
  return false
}

/** 构建本轮有效的工具集，应用：
 *  1. 静态工具注册表（始终包含）
 *  2. task 工具（当 subAgentRegistry 存在时）
 *  3. options.toolFilter 的 allow/deny 过滤（用于子 agent 循环）
 *
 *  每个会话计算一次并缓存——工具集在会话内稳定
 *  （注册表不变、过滤规则不变）。 */
function buildTools(options: AgentOptions) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = { ...toolRegistry }

  if (options.subAgentRegistry) {
    tools.task = createTaskTool(options.subAgentRegistry)
  }

  if (options.skillRegistry && options.skillRegistry.names().length > 0) {
    tools.activateSkill = createActivateSkillTool(options.skillRegistry)
  }

  // MCP 工具：注册时不带 execute 函数，AI SDK 会把它们留在 result.toolCalls
  // 中，由 processToolCalls 手动走权限 / loop-guard / abortSignal 管线分发。
  if (options.mcpRegistry) {
    // 两个通用的 MCP 内建工具。只在 MCP 激活时注册——没有 MCP 上下文的模型
    // 看不到它们，就不会开始幻觉资源 URI。
    tools.listMcpResources = listMcpResources
    tools.readMcpResource = readMcpResource
    for (const entry of options.mcpRegistry.list()) {
      tools[entry.callableName] = bridgeMcpTool(entry)
    }
  }

  const filter = options.toolFilter
  if (filter) {
    if (filter.allow) {
      const allowSet = new Set(filter.allow)
      for (const name of Object.keys(tools)) {
        if (!allowSet.has(name)) delete tools[name]
      }
    }
    if (filter.deny) {
      for (const name of filter.deny) {
        delete tools[name]
      }
    }
  }

  return tools
}

/** 运行一轮 agent turn：流式输出到 UI，收集响应。对错误有弹性。 */
async function runTurn(
  state: LoopState,
  model: LanguageModel,
  options: AgentOptions,
  systemPrompt: string,
  callbacks: AgentCallbacks,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  effectiveTools: Record<string, any>,
  /** 当前轮次编号——仅用于诊断，传入以便 debug 日志能标记每次 finish 是外层循环的第几轮。 */
  turn: number,
): Promise<TurnOutcome> {
  // 每次 API 调用前的防御性扫描：如果上一轮在 state.messages 中留下了
  // 没有 tool_result 配对的 assistant tool_call（模型输出了格式错误的
  // tool input → SDK 以 tool-error 拒绝且未生成结果；或轮次中途出错），
  // 追加一条合成的错误结果，使请求体格式正确。供应商严格要求 tool_call ↔
  // tool_result 配对，违反会以令人困惑的错误（如 "tool must be a response
  // to a preceding message with tool_calls"）拒绝整个请求。
  // 幂等——每轮都跑很廉价且万无一失。
  repairOrphanToolCalls(state.messages)

  // 纯文本供应商（DeepSeek、自定义端点）遇到残留的 image/file parts 会 400。
  // 在流开始前把那些 parts 就地改写为 OCR 文本。多模态供应商在 helper 内部
  // 基于能力标记短路跳过。
  await downgradeBinaryPartsForProvider(state.messages, options.modelId)

  // 按供应商的 prompt 缓存策略：Anthropic 在 system prompt + 最后一个工具定义 +
  // 最后两条消息上打 cache_control 断点（共 4 个，API 上限）；OpenAI 设一个
  // 以 sessionId 为键的稳定 promptCacheKey；OpenAI 兼容供应商依赖 LoopState
  // 中的系统提示词缓存保持前缀字节级稳定。
  const cached = applyCacheControl({
    system: systemPrompt,
    messages: state.messages,
    tools: effectiveTools,
    modelId: options.modelId,
    sessionId: state.sessionId,
  })

  // 扩展思考 / reasoning 开关。用户侧的 `/thinking on|off` 命令（App.tsx）
  // 切换 options.thinking；我们把这个标志翻译成供应商特定的参数
  //（Anthropic thinking.type、Google thinkingConfig、阿里 enableThinking 等）
  // 并合并到已有的 per-call providerOptions 中。没有 thinking 概念的模型
  //（gpt-4.1、grok-3、glm-4-plus）获得空条目——SDK 静默忽略不相关的 key。
  // undefined 时默认关闭，这样缺少该字段的旧配置不会在启动时用质量/延迟变化
  // 惊吓用户。
  const thinkingOptions = getThinkingProviderOptions(options.modelId, options.thinking ?? false)
  const mergedProviderOptions = mergeThinkingOptions(cached.providerOptions, thinkingOptions)

  let result: StreamResult
  try {
    result = streamText({
      model,
      system: cached.system,
      messages: cached.messages,
      tools: cached.tools ?? effectiveTools,
      maxRetries: 3,
      abortSignal: options.abortSignal,
      // 显式上限，防止供应商默认值静默截断长回复。大多数供应商钳制过高的值，
      // 但有些直接以 HTTP 400 拒绝。getMaxOutputTokens 按模型设上限；
      // 未知模型走模块级默认值。
      maxOutputTokens: getMaxOutputTokens(options.modelId),
      // AI SDK 把 providerOptions 类型化为 SharedV3ProviderOptions（嵌套 JSONObject）。
      // 我们的 cache-control helper 返回更宽松的 Record<string, unknown> 形状，
      // 因为供应商特定的字段集变化太快，无法保持严格联合类型同步。
      // 运行时契约是窄 JSON，我们在唯一调用点做类型断言。
      providerOptions: mergedProviderOptions as Parameters<typeof streamText>[0]['providerOptions'],
      // 抑制 SDK 的默认 onError（console.error(error)），它会通过 util.inspect
      // 把完整的 RetryError 对象（堆栈 + 嵌套 APICallError 数组 + 供应商响应体）
      // 倾泻到 stderr。我们已通过 classifyApiError + callbacks.onError 在下面的
      // try/catch 中分类并展示一行用户友好的消息。原始转储吓人且不可操作。
      // 保留 debug 出口。
      onError: ({ error }) => {
        if (process.env.DEBUG_STDOUT) debugLog('stream.onError', String(error))
      },
    }) as unknown as StreamResult
  } catch (err) {
    if (isAbortError(err, options.abortSignal)) return { kind: 'aborted' }
    callbacks.onError(new Error(classifyApiError(err).message))
    return { kind: 'error' }
  }

  // 在 await 流之前，预先给 SDK 暴露的所有同级 promise（response/usage/
  // finishReason/toolCalls）挂上 .catch(noop) 处理器。请求失败时 SDK 在
  // 同一个 tick 内拒绝所有这些 promise——如果我们等 fullStream 抛错后再处理，
  // Node 的未处理 rejection 扫描可能先运行并终止进程。提前挂 catch 是幂等的：
  // 后续 `await result.response` 仍然会拒绝并正常通过我们的错误路径传播。
  drainStreamResult(result)

  try {
    await streamChunksToUI(result, callbacks)
  } catch (err) {
    // 静默排空所有待处理的 AI SDK promise，防止未处理 rejection 警告
    //（NoOutputGeneratedError）泄露到 stderr。
    drainStreamResult(result)

    if (isAbortError(err, options.abortSignal)) return { kind: 'aborted' }
    if (isContextTooLongError(err)) {
      const compressed = await handleContextTooLong(state, model, callbacks, {
        hookBus: options.hookBus,
        modelId: options.modelId,
        cwd: process.cwd(),
        abortSignal: options.abortSignal,
      })
      // 压缩自己做 LLM 往返（2-5s）且不接受 abort signal。
      // 如果用户在它运行期间 Esc 了，下一轮 runTurn 会再发一个 streamText，
      // SDK 立刻在已 aborted 的 signal 上拒绝——白费设置。在这里直接退出。
      if (options.abortSignal?.aborted) return { kind: 'aborted' }
      if (compressed) return { kind: 'retry' }
    }
    callbacks.onError(new Error(classifyApiError(err).message))
    return { kind: 'error' }
  }

  try {
    const finishReason = await collectTurnResponse(result, state, options.modelId, callbacks)
    debugLog(
      'turn.finish',
      `reason=${finishReason} turn=${turn} input=${state.lastInputTokens} total=${state.tokenUsage.totalTokens}`,
    )
    return { kind: 'done', finishReason, result }
  } catch (err) {
    drainStreamResult(result)
    if (isAbortError(err, options.abortSignal)) return { kind: 'aborted' }
    callbacks.onError(new Error(classifyApiError(err).message))
    return { kind: 'error' }
  }
}

/** Agent Loop 主入口。 */
export async function agentLoop(
  userMessage: UserContent,
  model: LanguageModel,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  existingState?: LoopState,
): Promise<AgentLoopResult> {
  const state = existingState ?? createLoopState(options.permissionMode ?? 'default')

  // ── 插件 hook：SessionStart ──
  // SessionStart 过去在 agentLoop 首次调用时在这里触发。现在改为从
  // packages/cli/src/index.ts 的 CLI 启动路径触发，这样 hook 可以在用户
  // 交互之前做会话级初始化——没有任何用户消息就结束的会话（如只跑斜杠命令后退出）
  // 也能触发该事件。子 agent 始终传入 existingState，所以永远不会走到这个分支；
  // 直接调用 agentLoop 的库消费者需要在会话边界自行触发 SessionStart。

  // ── 插件 hook：UserPromptSubmit ──
  // 在消息推入 state.messages 之前运行，这样 deny 决策不会在 transcript 中
  // 留下残留。modify + context 会把注入文本拼入用户消息体内而不是插入第二条
  // user 消息——连续两条 user 消息会扰乱某些供应商的 tool-call 排序。
  let effectiveUserMessage = userMessage
  if (options.hookBus?.has('UserPromptSubmit')) {
    const promptText = userContentToText(userMessage)
    try {
      const decisions = await options.hookBus.emit(
        { name: 'UserPromptSubmit', session: { cwd: process.cwd(), modelId: options.modelId }, prompt: promptText },
        { signal: options.abortSignal },
      )
      const effect = aggregateUserPromptSubmit(decisions)
      if (effect.decision === 'deny') {
        const reason = effect.reason ?? 'blocked by plugin hook'
        const notice = `[Prompt blocked by plugin hook: ${reason}]`
        callbacks.onTextDelta(notice)
        // Push BOTH the user's original message and a synthetic assistant
        // response — keeps state.messages valid as alternating user /
        // assistant turns the next submit can build on.
        state.messages.push({ role: 'user', content: userMessage })
        state.messages.push({ role: 'assistant', content: notice })
        return { state, turnCount: 0 }
      }
      if (effect.context) {
        effectiveUserMessage = prependContext(userMessage, effect.context)
      }
    } catch (err) {
      if (options.abortSignal?.aborted) {
        return { state, turnCount: 0 }
      }
      debugLog('agent.hook-user-prompt-error', String(err))
    }
  }

  state.messages.push({ role: 'user', content: effectiveUserMessage })

  // 每次 agentLoop 调用的轮次计数器。作用域限定在本次调用——
  // 重新进入函数（下次用户提交）时从 0 重新开始。
  // 这是"Reached maximum turns" bug 的结构性修复：过去计数器在 state 上，
  // 跨整个 CLI 会话累积，导致长任务后下一次提交立刻触发上限。
  let turn = 0

  // 每个会话只在首轮派生一次 task-slug。驱动会话文件名
  //（`<slug>-<sessionId>.usage.json`）和 plan 文件名。只设一次——
  // 中途改了会让之前轮次已写入的文件变成孤儿。
  //
  // 非首条消息（中日韩、纯 emoji）会触发一次孤立的 generateText 往返，
  // 把任务摘要成 2-4 个英文词；ASCII 消息短路走本地 slugify（无网络）。
  // 和下面的 knowledge / git-stat 并行启动，让网络往返和磁盘 I/O 重叠，
  // 不给首轮增加串行延迟。slug 在任何 session-usage 写入或 plan 文件创建
  // 之前被 await（远在第一个 runTurn 之前），所以路径永远不会用过时的
  // 空 slug 写入。
  const taskText = userContentToText(userMessage)
  // 剥离 <activated_skill> XML 块，让 session slug 和 firstPrompt
  // 反映用户的真实意图而不是注入的 skill 内容。
  const taskTextForMeta = taskText.replace(/<activated_skill\b[^>]*>[\s\S]*?<\/activated_skill>/gi, '').trim()
  const taskSlugPromise: Promise<string> = state.taskSlug
    ? Promise.resolve(state.taskSlug)
    : generateTaskSlug(taskTextForMeta || taskText, model, options.modelId, options.abortSignal)

  // 会话延续由 UI 显式处理：如果用户接受恢复提示，待处理工作会直接嵌入
  // 他们的首条用户消息。自动注入到每个系统提示词会让模型把简单的打招呼
  // 也当成"继续探索"，所以我们不再那样做了。
  const fullKnowledgeContext = await buildKnowledgeContext()

  // 一次性探测是否为 git 仓库——廉价的 stat，避免每轮磁盘请求
  const isGitRepo = await fs
    .stat(path.join(process.cwd(), '.git'))
    .then(() => true)
    .catch(() => false)

  // 把知识上下文和 git 状态缓存到 state 上，供子 agent 使用
  state.knowledgeContext = fullKnowledgeContext
  state.isGitRepo = isGitRepo

  // 现在 resolve slug——必须在任何 persistUsageSnapshot（每轮）或下面的
  // plan 文件写入之前设置。generateTaskSlug 失败时返回 ''，此时会话/plan
  // 文件退回该 helper 存在之前的纯时间戳命名。
  state.taskSlug = await taskSlugPromise

  // 惰性 plan 文件路径派生。每个 plan-mode 会话只派生一次（第一个处于
  // plan mode 且没有路径的轮次）。每轮 plan-mode 都重新派生会覆盖模型
  // 一直在编辑的文件路径，所以 !currentPlanPath 守卫很关键。
  // 传入会话级 slug，让非 ASCII 任务文本也能获得可读文件名。
  if (state.permissionMode === 'plan' && !state.currentPlanPath) {
    state.currentPlanPath = makePlanFilePath(taskText, { slug: state.taskSlug })
  }

  // 把会话头部写入 jsonl 文件（恢复时幂等——头行已存在则跳过）。
  // 必须在 taskSlug resolve 之后，因为文件名是 `<slug>-<id>.jsonl`。
  // Fire-and-forget——FS 错误不阻塞循环。
  void appendHeader(state, options.modelId, taskTextForMeta || taskText)

  const compressionThreshold = getCompressionThreshold(options.modelId)

  // 每个会话构建一次有效工具集——包含 subAgentRegistry 存在时的 task 工具，
  // 并对子 agent 循环应用 toolFilter。会话生命周期内稳定。
  const effectiveTools = buildTools(options)

  // `length` finish 时的自动续写。推理模型可能在用户可见回复完成前耗尽输出
  // token 预算——旧行为是截断到半句然后报错，用户看起来像坏掉了。
  // 现在改为推送一条短"续写"提示然后继续循环，加上上限确保病态的超长回复
  // 最终仍会终止。
  const MAX_CONTINUATIONS = 3
  let continuationAttempts = 0
  // 追踪循环是否以干净的 `stop` finish reason 退出——这是退出后
  // 应该跑记忆提取器的唯一情况。
  let completedNormally = false

  // 没有 maxTurns → 跑到模型说停或用户中止为止。
  // 这是交互模式的默认行为。--print 和子 agent 传入具体值。
  while (options.maxTurns === undefined || turn < options.maxTurns) {
    turn++

    // 把上一轮（或首轮的初始用户消息）的未持久化消息刷入 jsonl。
    // 基于差异：只追加 state.messages.slice(persistedMessageCount)，
    // 没变化时是空操作。必须在 checkAndCompressContext 之前——如果压缩触发，
    // 它会原地改写数组并写自己的 boundary + re-flush，这假设压缩前的尾部
    // 已经在磁盘上了。
    void flushPendingMessages(state)

    await checkAndCompressContext(state, model, compressionThreshold, callbacks, {
      hookBus: options.hookBus,
      modelId: options.modelId,
      cwd: process.cwd(),
      abortSignal: options.abortSignal,
    })

    // 每个会话只构建一次系统提示词并在轮次间复用。
    // 稳定的字节级前缀是 OpenAI 兼容供应商（DeepSeek、Moonshot、Alibaba、
    // 智谱、xAI）自动前缀缓存的前提。如果这个字符串在轮次间变化——
    // 例如 buildSystemPrompt 内插了新的时间戳——每次请求都缓存不命中。
    //
    // plan-mode 叠加层也折叠进这份字节级稳定缓存。tool-execution 在
    // permissionMode 切换时把缓存置 null，所以每种模式的提示词在模式激活
    // 期间保持缓存友好。只有边界轮次付出缓存不命中的代价。
    if (!state.systemPromptCache) {
      // Names actually going into the system prompt — used to verify that
      // disabled skills are filtered out (registry.list() drops them) and
      // that the names you see match the registry's enabled set. Fires
      // once per session because the prompt is built once and cached.
      // 系统提示词中实际包含的 skill 名称——用于验证被禁用的 skill
      // 已过滤掉（registry.list() 会排除它们），以及确认 UI 看到的
      // 名称与注册表的启用集一致。每个会话只触发一次。
      if (options.skillRegistry) {
        const enabled = options.skillRegistry.list().map((s) => s.name)
        const disabled = options.skillRegistry
          .listAll()
          .filter((s) => s.disabled)
          .map((s) => s.name)
        debugLog('agent.skills.system-prompt', `enabled=[${enabled.join(',')}] disabled=[${disabled.join(',')}]`)
      }
      state.systemPromptCache = buildSystemPrompt({
        knowledgeContext: fullKnowledgeContext,
        modelId: options.modelId,
        isGitRepo,
        planMode: state.permissionMode === 'plan',
        planFilePath: state.currentPlanPath ?? undefined,
        // 传入 MCP 工具，让系统提示词包含 `## MCP Tools` 段落。
        // 空 / 缺失 registry → buildSystemPrompt 的占位符解析为 ""，
        // 提示词字节等同于无 MCP 时的形状，保持无 MCP 配置会话的
        // 前缀缓存命中。
        mcpTools: options.mcpRegistry ? toSystemPromptEntries(options.mcpRegistry.list()) : undefined,
        skills: options.skillRegistry ? options.skillRegistry.list() : undefined,
      })
    }
    const systemPrompt = state.systemPromptCache

    const outcome = await runTurn(state, model, options, systemPrompt, callbacks, effectiveTools, turn)

    // ── 插件 hook：TurnComplete ──
    // 无论 finish reason 如何都触发（包括 error / abort），这样通知 / 审计
    // hook 能看到每一轮，而不仅是干净的 stop。
    // 并行 + 尽力而为：hook 失败和中止不能阻塞下面的 outcome 分发。
    if (options.hookBus?.has('TurnComplete')) {
      const event: HookEvent = {
        name: 'TurnComplete',
        session: { cwd: process.cwd(), modelId: options.modelId },
        turn,
        tokenUsage: {
          inputTokens: state.tokenUsage.inputTokens,
          outputTokens: state.tokenUsage.outputTokens,
          totalTokens: state.tokenUsage.totalTokens,
        },
      }
      void options.hookBus
        .emit(event, { signal: options.abortSignal })
        .catch((err) => debugLog('agent.hook-turn-complete-error', String(err)))
    }

    if (outcome.kind === 'error') break
    if (outcome.kind === 'aborted') break
    if (outcome.kind === 'retry') {
      // 被动压缩恢复的失败尝试不计入轮次配额。
      turn--
      continue
    }

    if (outcome.finishReason === 'tool-calls') {
      // 任何成功的工具轮次说明模型在做实质性进展——重置连续截断计数器。
      continuationAttempts = 0
      let toolCalls: Awaited<StreamResult['toolCalls']>
      try {
        toolCalls = await outcome.result.toolCalls
      } catch (err) {
        if (isAbortError(err, options.abortSignal)) break
        callbacks.onError(new Error(classifyApiError(err).message))
        break
      }
      await processToolCalls(toolCalls, state, options, callbacks, model)
      // processToolCalls 在 abort 时用合成结果短路；跳过下一个 streamText
      // 调用，它只会抛 AbortError。
      if (options.abortSignal?.aborted) break
      continue
    }

    if (outcome.finishReason === 'length') {
      if (continuationAttempts < MAX_CONTINUATIONS) {
        continuationAttempts++
        debugLog('turn.length-continuation', `attempt=${continuationAttempts}/${MAX_CONTINUATIONS} turn=${turn}`)
        // 提示模型精确从中断处继续。这条消息进入 state.messages 但不进入
        // UI messages，用户看到的是一条连续的流式输出，最多有一次短暂停顿。
        state.messages.push({
          role: 'user',
          content:
            'Output token limit hit. Resume directly — no apology, no recap. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.',
        })
        continue
      }
      callbacks.onError(
        new Error(
          `Response still truncated after ${MAX_CONTINUATIONS} continuation attempts — ask a narrower question.`,
        ),
      )
      break
    }

    if (outcome.finishReason === 'content-filter') {
      callbacks.onError(new Error('Response stopped by the provider content filter.'))
    } else if (outcome.finishReason === 'stop') {
      completedNormally = true
    }

    break
  }

  // 只在以下条件同时满足时报告 "max turns reached"：
  //   1. 确实设置了上限（交互模式没有上限——没有上限可"达到"），且
  //   2. 达到了上限，且
  //   3. 模型没有在同一轮干净地结束——!completedNormally 守卫处理
  //      'stop' 恰好落在 maxTurns-th 轮的边界情况。
  if (options.maxTurns !== undefined && turn >= options.maxTurns && !completedNormally) {
    callbacks.onError(new Error(`Reached maximum turns (${options.maxTurns}). Stopping agent loop.`))
  }

  // 最终刷盘——捕获通过 'stop'/'error' 退出时最后一轮的内容
  //（下一轮的循环顶部刷盘在那些情况下永远不会运行）。
  // Abort 路径：useAgent.abort() 在 agentLoop 返回后才推送
  // `[Request interrupted by user]` 通知，所以它自己负责刷盘——见 use-agent.ts。
  void flushPendingMessages(state)

  // 轮次后记忆提取器：只在干净的 `stop` finish 时运行（无错误、无中止、
  // 无 content-filter、无 length 上限放弃）。Fire-and-forget——用户可以
  // 立即输入下一条 prompt，同时一个 generateText + Output.object 调用在后台
  // 扫描 transcript 寻找值得持久化的知识。写入直接到 AutoMemory（静默路径），
  // 所以 ChatInput frame 不会在用户回复已完成后渲染一个工具行。
  if (completedNormally && !options.abortSignal?.aborted) {
    void runMemoryExtractor({
      parentState: state,
      parentModel: model,
      abortSignal: options.abortSignal,
      onWrite: callbacks.onMemoryWrite,
    })
  }

  return { state, turnCount: turn }
}

/** 把内存中的消息同步到会话 jsonl。在退出 / 清理路径调用，确保进程被杀
 *  时不丢最后一轮。每轮的追加已在 agentLoop 中完成——这是剩余内容的安全网排空。
 *  容忍半初始化的 state（还没 taskSlug 等）；没有内容可写时
 *  flushPendingMessages 是空操作。`model` 参数保留用于 API 兼容性
 * （旧版实现用它在退出时生成总结），但这里未使用——总结现在骑在
 *  compact-boundary 行上，不再在退出时单独调用。 */
export async function saveSession(state: LoopState, _model: LanguageModel): Promise<void> {
  await flushPendingMessages(state)
}
