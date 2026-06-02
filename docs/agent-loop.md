# Agent Loop 代码详解

本文是对 X-Code CLI 中 agent loop 的代码级详解。代码集中在 `packages/core/src/agent/` 目录，核心入口是 `loop.ts` 中的 `agentLoop()` 函数。

相关源码：
- `packages/core/src/agent/loop.ts` — agentLoop / runTurn / streamChunksToUI / collectTurnResponse
- `packages/core/src/agent/loop-state.ts` — LoopState 全部 15 个字段 + createLoopState
- `packages/core/src/agent/tool-execution.ts` — processToolCalls 派发逻辑
- `packages/core/src/agent/tool-result-sanitize.ts` — repairOrphanToolCalls + truncateToolResultsInMessages
- `packages/core/src/agent/compression.ts` — checkAndCompressContext / handleContextTooLong
- `packages/core/src/types/index.ts` — AgentOptions / AgentCallbacks

---

## 一、从整体架构看 Agent Loop 的位置

X-Code CLI 分两个包：`core` 和 `cli`。`core` 是纯 agent 引擎（无 React / Ink 依赖），`cli` 是终端 UI。Agent Loop 是 `core` 的心脏——它接收用户消息、驱动模型推理、执行工具、把结果喂回模型，直到模型主动结束或用户取消。

```
用户输入 (cli)
    │
    ▼
agentLoop (core)  ◄── LoopState（跨提交复用）
    │
    ├─ runTurn × N
    │   ├─ 6 步预处理
    │   ├─ streamText → 流式 chunk → UI callbacks
    │   └─ collectTurnResponse → messages / tokenUsage
    │
    ├─ finishReason 分支
    │   ├─ 'tool-calls' → processToolCalls → 下一轮
    │   ├─ 'length'    → 自动续写（最多 3 次）
    │   └─ 'stop'      → 退出循环
    │
    └─ 退出：记忆提取 / jsonl 刷盘
```

---

## 二、LoopState：跨轮共享的会话容器

`LoopState` 定义在 `packages/core/src/agent/loop-state.ts`，是整个 agent loop 的状态载体。同一 CLI 会话内的多次用户提交共享同一个 `LoopState` 实例。

### 2.1 完整字段定义

```typescript
// packages/core/src/agent/loop-state.ts:11-80
export interface LoopState {
  messages: ModelMessage[]        // 对话历史
  tokenUsage: TokenUsage          // 累计 token 计数
  lastInputTokens: number         // 最近一次 API 响应的 input token 数（驱动压缩）
  sessionId: string               // 会话 ID，格式 YYYYMMDD-HHMMSS-mmm
  startedAt: string               // ISO 时间戳
  filesModified: Set<string>      // 本次会话修改过的文件路径
  recentToolCalls: Array<{ toolName: string; hash: string }>  // doom-loop 检测窗口
  systemPromptCache: string | null   // 字节稳定的系统提示词缓存
  permissionMode: PermissionMode     // 当前权限模式
  currentPlanPath: string | null     // plan 文件路径
  taskSlug: string                   // 会话文件名用的短标识
  todos: TodoItem[]                  // 模型维护的待办列表
  persistedMessageCount: number      // jsonl 持久化游标
  knowledgeContext?: string          // 缓存的知识上下文
  isGitRepo?: boolean               // 缓存的 git 仓库标记
}
```

`★ Insight ─────────────────────────────────────`
**turn 计数器不在 LoopState 上。** 它是 `agentLoop` 内部的局部变量。曾经放在 `LoopState` 上导致过一个 bug：用户跑完一个长任务（累计 100 轮）后，下一次提交时 `turn >= maxTurns` 立即成立，循环一次都不进就报 "Reached maximum turns"。降级为局部变量后，每次进 `agentLoop` 都从 0 重新计。
`─────────────────────────────────────────────────`

### 2.2 createLoopState：工厂函数

```typescript
// packages/core/src/agent/loop-state.ts:92-122
export function createLoopState(initialMode: PermissionMode = 'default'): LoopState {
  return {
    messages: [],
    tokenUsage: {
      inputTokens: 0, outputTokens: 0, totalTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0,
      currentContextTokens: 0,
    },
    lastInputTokens: 0,
    sessionId: generateSessionId(),   // 本地时间生成，无网络依赖
    startedAt: new Date().toISOString(),
    filesModified: new Set(),
    recentToolCalls: [],
    systemPromptCache: null,          // 首轮按需构建
    permissionMode: initialMode,
    currentPlanPath: null,
    taskSlug: '',
    todos: [],
    persistedMessageCount: 0,
  }
}
```

会话 ID 使用本地时间格式 `YYYYMMDD-HHMMSS-mmm`（毫秒尾部保证唯一），取代了之前 `Date.now().toString(36)` 的不可读格式。

### 2.3 跨提交复用机制

UI 层（`use-agent.ts`）持有 `loopStateRef`，每次用户提交时把上次的 `state` 作为 `existingState` 传回来：

```typescript
// packages/core/src/agent/loop.ts:382
const state = existingState ?? createLoopState(options.permissionMode ?? 'default')
```

```
第一次 submit  → existingState = undefined  → createLoopState()
第二次 submit  → existingState = 上次的 state  → 复用 messages / tokenUsage
第三次 submit  → existingState = 上次的 state  → 继续累积
```

---

## 三、AgentCallbacks：Loop 与 UI 的解耦层

`AgentCallbacks` 定义在 `packages/core/src/types/index.ts:124-179`，是 `core` 包与 UI 之间的桥接接口。Agent loop 不直接操作任何 UI 组件，而是通过这组回调通知状态变化。

### 3.1 核心回调

```typescript
export interface AgentCallbacks {
  onTextDelta: (text: string) => void          // 流式文本片段
  onToolCall: (toolCallId, toolName, input) => void   // 工具调用开始
  onToolProgress: (toolCallId, message) => void        // 工具执行进度
  onToolResult: (toolCallId, result, isError?) => void // 工具执行完成
  onAskPermission: (toolCall) => Promise<'yes'|'always'|'no'>  // 权限弹窗
  onAskUser: (question, options) => Promise<string>            // 用户交互
  onShellOutput: (chunk: string) => void       // shell 实时输出
  onUsageUpdate: (usage: TokenUsage) => void   // token 用量更新
  onContextCompressed: (summary: string) => void // 上下文压缩通知
  onError: (error: Error) => void              // 错误通知
  // ... 可选回调：onFileEdit / onSubAgentEvent / onMemoryWrite
}
```

`★ Insight ─────────────────────────────────────`
**这个解耦带来三个直接收益：**
1. `core` 包零 UI 依赖——可以独立测试、移植到 VSCode 插件或 Web 版
2. 测试时用 `vi.fn()` 假回调即可验证 loop 行为，不需要启动 Ink 渲染
3. `onAskPermission` 返回 `Promise`，天然支持"挂起等用户"的异步交互模式——UI 把"等用户在 Yes/No 三选一"转成 Promise，loop 用 `await` 等待
`─────────────────────────────────────────────────`

---

## 四、agentLoop 主函数：完整的控制流

`agentLoop` 是导出的主入口，定义在 `loop.ts:375-703`。按执行顺序分为五个阶段：

### 4.1 阶段一：状态初始化 + Hook 拦截

```typescript
// packages/core/src/agent/loop.ts:382
const state = existingState ?? createLoopState(options.permissionMode ?? 'default')
```

接着运行 `UserPromptSubmit` hook——在消息推入 `state.messages` 之前执行，这样 `deny` 决策不会在对话历史中留下残留：

```typescript
// packages/core/src/agent/loop.ts:403-431
if (options.hookBus?.has('UserPromptSubmit')) {
  const decisions = await options.hookBus.emit(...)
  const effect = aggregateUserPromptSubmit(decisions)
  if (effect.decision === 'deny') {
    // 推入用户消息 + 合成助手回复，保持 messages 交替有效
    state.messages.push({ role: 'user', content: userMessage })
    state.messages.push({ role: 'assistant', content: notice })
    return { state, turnCount: 0 }
  }
  if (effect.context) {
    effectiveUserMessage = prependContext(userMessage, effect.context)
  }
}
```

`prependContext` 把注入的上下文拼入用户消息体内，而不是插入第二条 user 消息——因为某些供应商拒绝连续两条 `role: 'user'` 消息。

### 4.2 阶段二：会话级初始化（首轮并行）

四项初始化在首轮并行启动，整轮复用：

```typescript
// packages/core/src/agent/loop.ts:457-510
const taskSlugPromise = state.taskSlug
  ? Promise.resolve(state.taskSlug)
  : generateTaskSlug(taskTextForMeta, model, options.modelId, options.abortSignal)

const fullKnowledgeContext = await buildKnowledgeContext()  // AGENTS.md 链 + 自动记忆
const isGitRepo = await fs.stat(path.join(cwd, '.git')).then(() => true).catch(() => false)

state.knowledgeContext = fullKnowledgeContext
state.isGitRepo = isGitRepo
state.taskSlug = await taskSlugPromise  // 等所有并行项完成
```

| 步骤 | 何时执行 | 作用 |
|------|---------|------|
| `generateTaskSlug` | 首轮，与其他项并行 | 纯英文走本地 slugify（0 次 LLM）；中日韩/emoji 走一次孤立 `generateText` 拿英文短词 |
| `buildKnowledgeContext` | 首轮 | 读 AGENTS.md 链 + 自动记忆，整个会话不再变 |
| `isGitRepo` 探测 | 首轮 | 一次 `fs.stat`，结果缓存进 state |
| `appendHeader` | 首轮，fire-and-forget | 往 jsonl 第一行写会话元数据 |

`★ Insight ─────────────────────────────────────`
**`taskSlug` 一旦设置永不更新。** 中途改了会让本会话的 jsonl / plan 文件名错位，留下孤儿文件。即使后续提问与首条无关，slug 也不重新生成。
`─────────────────────────────────────────────────`

### 4.3 阶段三：主循环

```typescript
// packages/core/src/agent/loop.ts:525-666
let turn = 0
const MAX_CONTINUATIONS = 3
let continuationAttempts = 0
let completedNormally = false

while (options.maxTurns === undefined || turn < options.maxTurns) {
  turn++
  void flushPendingMessages(state)                 // 增量写入 jsonl
  await checkAndCompressContext(state, ...)        // 主动压缩
  // systemPromptCache 首轮构建，后续整会话复用
  if (!state.systemPromptCache) {
    state.systemPromptCache = buildSystemPrompt({ ... })
  }
  const outcome = await runTurn(state, ...)        // 核心：跑一轮

  // 按 outcome 分支处理...
}
```

系统提示词的缓存策略至关重要：

```typescript
// packages/core/src/agent/loop.ts:556-583
if (!state.systemPromptCache) {
  state.systemPromptCache = buildSystemPrompt({
    knowledgeContext: fullKnowledgeContext,
    modelId: options.modelId,
    isGitRepo,
    planMode: state.permissionMode === 'plan',
    planFilePath: state.currentPlanPath ?? undefined,
    mcpTools: options.mcpRegistry ? toSystemPromptEntries(...) : undefined,
    skills: options.skillRegistry ? options.skillRegistry.list() : undefined,
  })
}
```

`★ Insight ─────────────────────────────────────`
**`systemPromptCache` 必须字节级稳定。** OpenAI 兼容供应商（DeepSeek / Moonshot / Alibaba / 智谱 / xAI）自动缓存稳定前缀。任何"拼一下当前时间 / 上一轮 token 数"的改动，都会让缓存命中率打回 0——错误不报，只是账单悄悄涨几倍。`permissionMode` 切换时，`plan-tools.ts` 会将其置 `null`，强制下一轮重建。
`─────────────────────────────────────────────────`

### 4.4 阶段四：finishReason 分支

`runTurn` 返回 `TurnOutcome`，agentLoop 按 `kind` 和 `finishReason` 分支处理：

```typescript
// packages/core/src/agent/loop.ts:174-183
type TurnOutcome =
  | { kind: 'done'; finishReason: string; result: StreamResult }  // 正常完成
  | { kind: 'error' }       // 不可恢复错误
  | { kind: 'retry' }       // 上下文超限，已压缩，本轮重试
  | { kind: 'aborted' }     // 用户 Esc 取消
```

分支处理逻辑：

```typescript
// packages/core/src/agent/loop.ts:609-664
if (outcome.kind === 'error') break
if (outcome.kind === 'aborted') break
if (outcome.kind === 'retry') { turn--; continue }  // 不计入轮次配额

if (outcome.finishReason === 'tool-calls') {
  continuationAttempts = 0
  await processToolCalls(toolCalls, state, options, callbacks, model)
  continue
}
if (outcome.finishReason === 'length') {
  // 自动续写，最多 3 次
  state.messages.push({ role: 'user', content: 'Output token limit hit. Resume directly...' })
  continue
}
if (outcome.finishReason === 'content-filter') {
  callbacks.onError(new Error('Response stopped by the provider content filter.'))
}
// 'stop' / 'error' / 'other' → break
```

| finishReason | 含义 | 处理 |
|---|---|---|
| `'stop'` | 模型主动结束 | `completedNormally = true`，break |
| `'tool-calls'` | 模型要求继续调工具 | 重置续写计数，跑 `processToolCalls`，continue |
| `'length'` | 输出被 max_tokens 截断 | 追加续写 nudge，最多 3 次 |
| `'content-filter'` | 供应商内容审核拦截 | `onError` + break |

`★ Insight ─────────────────────────────────────`
**`aborted` 单独一种而不归为 `error`** 是明确的设计：用户主动取消不是出错，UI 显示"已中断"而不是"出错了"。`onError` 只在真正的不可恢复错误（401 / 网络异常）触发。
`─────────────────────────────────────────────────`

### 4.5 阶段五：退出尾声

```typescript
// packages/core/src/agent/loop.ts:674-701
// 检查是否达到 maxTurns 上限
if (options.maxTurns !== undefined && turn >= options.maxTurns && !completedNormally) {
  callbacks.onError(new Error(`Reached maximum turns (${options.maxTurns})...`))
}

void flushPendingMessages(state)  // 最终刷盘

// 正常退出时后台跑记忆提取器
if (completedNormally && !options.abortSignal?.aborted) {
  void runMemoryExtractor({ parentState: state, parentModel: model, ... })
}

return { state, turnCount: turn }
```

`completedNormally` 只在 `finishReason === 'stop'` 时置 true，决定是否跑 `runMemoryExtractor`——后台异步任务，从对话中提炼可复用记忆写入 `auto.md`。

---

## 五、runTurn：单轮的完整执行路径

`runTurn` 是 agent loop 的核心执行单元（`loop.ts:247-372`）。每次调用代表一轮完整的"模型推理 + 工具执行"。

### 5.1 流前 6 步预处理

这是 50 行 demo 和生产级实现差距最大的地方：

```typescript
// packages/core/src/agent/loop.ts:268-344
async function runTurn(state, model, options, systemPrompt, callbacks, effectiveTools, turn) {
  // ① 修复 orphan tool_call（防御性扫描）
  repairOrphanToolCalls(state.messages)

  // ② 纯文本供应商把图像/文件 part 降级为 OCR 文本
  await downgradeBinaryPartsForProvider(state.messages, options.modelId)

  // ③ 供应商特定的缓存策略
  const cached = applyCacheControl({
    system: systemPrompt, messages: state.messages,
    tools: effectiveTools, modelId: options.modelId, sessionId: state.sessionId,
  })

  // ④ thinking 模式参数适配
  const thinkingOptions = getThinkingProviderOptions(options.modelId, options.thinking ?? false)
  const mergedProviderOptions = mergeThinkingOptions(cached.providerOptions, thinkingOptions)

  // ⑤ 发起流式请求
  result = streamText({
    model, system: cached.system, messages: cached.messages,
    tools: cached.tools ?? effectiveTools,
    maxRetries: 3,
    abortSignal: options.abortSignal,
    maxOutputTokens: getMaxOutputTokens(options.modelId),   // ⑤ 按 modelId 查表设上限
    providerOptions: mergedProviderOptions,
    onError: ({ error }) => { /* 抑制 SDK 默认的 console.error */ },
  })

  // ⑥ 预先 catch 同源 promise，避免未处理 rejection
  drainStreamResult(result)
  // ...
}
```

| 步骤 | 函数 | 解决什么问题 |
|------|------|-------------|
| ① | `repairOrphanToolCalls` | 修复没有配对 tool_result 的 tool_call / 反向孤儿 |
| ② | `downgradeBinaryPartsForProvider` | DeepSeek 等纯文本供应商见到 image part 会 400，需 OCR 降级 |
| ③ | `applyCacheControl` | Anthropic 打 4 个 `cache_control` 断点；OpenAI 设 `promptCacheKey` |
| ④ | `getThinkingProviderOptions` + `mergeThinkingOptions` | 把 `/thinking on|off` 翻译成各家专有参数 |
| ⑤ | `getMaxOutputTokens` | 不同模型输出上限不同，传太大会被某些供应商 400 |
| ⑥ | `drainStreamResult` | SDK 暴露多个共享同一流的 promise，任一失败导致全部 reject |

`★ Insight ─────────────────────────────────────`
**步骤 ⑥ 是容易被忽视的陷阱。** AI SDK 的 `result` 暴露 `.response` / `.usage` / `.finishReason` / `.toolCalls` 多个 promise，底层共享同一个流。如果流抛错时还没 await 这些 promise，Node 的未处理 rejection 会直接终止进程。`drainStreamResult` 在 await 流之前给所有 sibling promise 挂上 `.catch(noop)`，后续 `await result.response` 仍正常 reject 和传播。
`─────────────────────────────────────────────────`

### 5.2 流式 chunk 分流：streamChunksToUI

```typescript
// packages/core/src/agent/loop.ts:87-126
async function streamChunksToUI(result: StreamResult, callbacks: AgentCallbacks): Promise<void> {
  for await (const chunk of result.fullStream) {
    if (chunk.type === 'error') throw chunk.error  // 重抛，让外层 try/catch 分类
    if (chunk.type === 'text-delta') callbacks.onTextDelta(chunk.text ?? '')
    else if (chunk.type === 'tool-call') {
      if (toolCallId) setProgressReporter(toolCallId, (msg) => callbacks.onToolProgress(toolCallId, msg))
      callbacks.onToolCall(toolCallId, chunk.toolName ?? '', chunk.input)
    }
    else if (chunk.type === 'tool-result') {
      clearProgressReporter(chunk.toolCallId)
      callbacks.onToolResult(chunk.toolCallId, truncateToolResult(raw))
    }
    // reasoning-delta：刻意丢弃不进 UI
  }
}
```

关键点：
- `tool-call` chunk 到达时注册进度通道——AI SDK 对带 `execute` 的工具会同步执行，工具内部调用 `reportProgress` 就能实时反馈
- `tool-result` chunk 也会截断——`truncateToolResult` 按 2000 行 / 50 KB 的双预算裁剪
- `reasoning-delta`（思考模式模型的内部推理）刻意不进 UI——最终用户看到的答案在 `text-delta` 里

### 5.3 收集响应：collectTurnResponse

```typescript
// packages/core/src/agent/loop.ts:126-175
async function collectTurnResponse(result, state, modelId, callbacks): Promise<string> {
  const response = await result.response

  // 关键：自动执行工具的结果走 response.messages 回流，绕过了手动截断路径
  // 必须在这里兜底截断
  truncateToolResultsInMessages(response.messages)
  state.messages.push(...response.messages)
  ensureReasoningContentParts(state.messages, modelId)  // DeepSeek V4 兼容

  const usage = await result.usage
  if (usage) {
    state.tokenUsage.inputTokens += usage.inputTokens ?? 0
    state.tokenUsage.outputTokens += usage.outputTokens ?? 0
    state.tokenUsage.cacheReadTokens += usage.inputTokenDetails?.cacheReadTokens ?? 0
    state.tokenUsage.cacheCreationTokens += usage.inputTokenDetails?.cacheWriteTokens ?? 0
    state.tokenUsage.totalTokens = state.tokenUsage.inputTokens + state.tokenUsage.outputTokens
    // 快照当前上下文占用——覆写，不累积
    state.tokenUsage.currentContextTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
    state.lastInputTokens = usage.inputTokens ?? 0
    callbacks.onUsageUpdate(state.tokenUsage)
  }

  return result.finishReason
}
```

`★ Insight ─────────────────────────────────────`
**`truncateToolResultsInMessages` 是必做的兜底。** 带有 `execute` 的工具（readFile / glob / grep 等）由 AI SDK 自动执行，结果通过 `response.messages` 回流——这条路径绕过了 `pushToolResult` 的截断逻辑。如果不在 `collectTurnResponse` 里跑一遍截断，读一个 800 行文件会把全文送进后续每轮请求。已知最严重案例是累积到 9M token 的上下文。
`─────────────────────────────────────────────────`

---

## 六、工具执行的两条路径

### 6.1 路径一：AI SDK 自动执行（读类工具）

`readFile` / `glob` / `grep` / `listDir` / `webSearch` / `webFetch` 在工具定义时带有 `execute` 函数。AI SDK 收到 `tool-call` chunk 后立即在内部执行，结果通过 `response.messages` 自动回流。`agentLoop` 不需要手动干预——但 `collectTurnResponse` 中的 `truncateToolResultsInMessages` 兜底截断是必须的。

### 6.2 路径二：processToolCalls 手动分发

`writeFile` / `edit` / `shell` / `askUser` / `todoWrite` / `enterPlanMode` / `exitPlanMode` / `task` / MCP 工具走手动分发。

#### processToolCalls 总控

```typescript
// packages/core/src/agent/tool-execution.ts:746-838
export async function processToolCalls(toolCalls, state, options, callbacks, parentModel) {
  const activeIds = collectActiveAssistantToolCallIds(state)    // 有效的 tool_call ID
  const fulfilledIds = collectFulfilledToolCallIds(state)       // 已有结果的 ID
  const deferred: ModelMessage[] = []                           // 延迟消息队列

  // 前置过滤：跳过 ghost 调用和已 fulfilled 调用
  const liveCalls = toolCalls.filter(tc => {
    if (!activeIds.has(tc.toolCallId)) return false   // SDK 中途拒绝的"幽灵"调用
    if (fulfilledIds.has(tc.toolCallId)) { /* 记入 loop-guard 窗口 */ return false }
    return true
  })

  // 分批：连续 task 调用归为一批并行，其他各自单元素批串行
  const batches = partitionToolCalls(liveCalls)
  for (const batch of batches) {
    if (options.abortSignal?.aborted) { /* 补推合成 tool_result */ break }
    await Promise.all(batch.map(tc => handleToolCall(tc, ...)))
  }

  // 刷出延迟消息
  if (deferred.length > 0) state.messages.push(...deferred)
}
```

#### handleToolCall 的三步分发

```typescript
// packages/core/src/agent/tool-execution.ts:472-556
async function handleToolCall(tc, state, options, callbacks, parentModel, deferred) {
  // PreToolUse hook（可 deny / modify args）

  // 旁路：不走 loop guard 的工具
  const bypassHandler = BYPASS_LOOP_GUARD_HANDLERS[ctx.toolName]
  if (bypassHandler) { await bypassHandler(ctx); return }

  // MCP 工具走独立权限路径
  if (ctx.options.mcpRegistry?.get(ctx.toolName)) {
    await handleMcpToolCall(ctx, deferred); return
  }

  // ① loop guard 检测（重复调用拦截）
  if (await applyLoopGuard(ctx, deferred)) return

  // ② 权限检查（writeFile / edit / shell 才生效）
  if (!(await checkWriteOrShellPermission(ctx))) return

  // ③ 实际执行 + 推送结果
  const result = await executeWriteOrShell(ctx)
  if (result == null) return   // auto-executed 工具返回 null
  await pushSuccessfulToolResult(ctx, truncateToolResult(result.output), result.isError)
}
```

旁路工具列表（`BYPASS_LOOP_GUARD_HANDLERS`，`tool-execution.ts:354-366`）：

| 工具 | 为什么旁路 |
|------|-----------|
| `askUser` | 重复提问是刻意的（用户回答含糊时） |
| `task` | 子 agent 独立 LoopState，隔离安全 |
| `todoWrite` | 纯状态更新，无副作用 |
| `enterPlanMode` / `exitPlanMode` | 模式切换 |
| `listMcpResources` / `readMcpResource` | 纯读取 |

#### partitionToolCalls：并行分批策略

```typescript
// packages/core/src/agent/tool-execution.ts:724-738
export function partitionToolCalls(calls: ToolCall[]): ToolCall[][] {
  const batches: ToolCall[][] = []
  let i = 0
  while (i < calls.length) {
    let end = i + 1
    if (calls[i]!.toolName === 'task') {
      while (end < calls.length && calls[end]!.toolName === 'task') end++
    }
    batches.push(calls.slice(i, end))
    i = end
  }
  return batches
}
```

只有 `task`（子 agent）可以并行——它们各自有独立 `LoopState`、独立的消息数组、additive 的 token 累计。其他工具必须串行：`writeFile`/`edit` 修改文件系统、`shell` 向 UI 流输出、`askUser` 持有 UI 弹窗。

`★ Insight ─────────────────────────────────────`
**延迟消息队列（deferred）解决 DeepSeek 的严格消息顺序要求。** DeepSeek 拒绝 `assistant → tool A → user → tool B` 的消息序列。loop guard 的用户干预消息如果立刻推入，就会产生这种模式。`deferred` 收集这些消息，在整个批处理完成后一次性 push 到 `state.messages` 尾部。
`─────────────────────────────────────────────────`

---

## 七、上下文压缩：proactive 和 reactive 两条路径

### 7.1 proactive：checkAndCompressContext

每轮 `runTurn` 之前主动检查（`compression.ts:69-141`）：

```typescript
export async function checkAndCompressContext(state, model, threshold, callbacks, hookCtx?) {
  const needsCompression = state.lastInputTokens > threshold
    || estimateTokenCount(state.messages) > threshold
  if (!needsCompression || state.messages.length <= KEEP_RECENT) return

  // 第一阶段：轻量裁剪（O(n)，不调 LLM）
  const light = lightCompactMessages(state.messages)
  if (light.dropped > 0) {
    state.messages = light.messages
    if (!stillOverThreshold) { void markBoundaryAndReflush(state); return }
  }

  // 第二阶段：LLM 总结
  state.messages = await compressMessages(state.messages, model)
  state.lastInputTokens = 0
  void markBoundaryAndReflush(state, summaryText)
}
```

### 7.2 reactive：handleContextTooLong

当 proactive 估算偏低、API 真报了 context too long 时触发（`compression.ts:143-170`）：

```typescript
export async function handleContextTooLong(state, model, callbacks, hookCtx?): Promise<boolean> {
  if (state.messages.length <= KEEP_RECENT) return false
  state.messages = await compressMessages(state.messages, model)
  state.lastInputTokens = 0
  void markBoundaryAndReflush(state)
  return true  // 告诉调用方重试本轮
}
```

调用方（`runTurn`）收到 `retry` 后：

```typescript
// packages/core/src/agent/loop.ts:611-615
if (outcome.kind === 'retry') {
  turn--        // 不计入轮次配额
  continue      // 重跑本轮
}
```

`★ Insight ─────────────────────────────────────`
**两条路径共享同一套原语但触发时机不同。** proactive 基于估算默默运行，大多数时候用户无感知；reactive 只在少数场景触发、触发后也是悄悄重试。这就是用户大多数时候察觉不到压缩在发生的原因。
`─────────────────────────────────────────────────`

---

## 八、Orphan Tool Call 修复

`repairOrphanToolCalls`（`tool-result-sanitize.ts:68-188`）是一个防御性扫描，在每轮 `runTurn` 开头执行。它解决两类问题：

### 8.1 正向孤儿（tool_call 无配对 tool_result）

模型偶尔输出格式错误的 tool input，SDK 验证失败后不推送 tool_result。`repairOrphanToolCalls` 为这些孤儿合成错误结果：

```typescript
// tool-result-sanitize.ts:153-187
const orphanParts = []
for (const id of expected) {
  if (fulfilled.has(id)) continue
  orphanParts.push({
    type: 'tool-result', toolCallId: id, toolName: toolNameById.get(id) ?? 'unknown',
    output: { type: 'text', value: 'Error: Tool input failed validation...' }
  })
}
// 合并到最后一条 tool 消息，或新建一条
```

### 8.2 反向孤儿（tool_result 无配对 tool_call）

`processToolCalls` 可能推送了一个 tool_result，但对应的 tool_call 已被 SDK 从 `response.messages` 中剔除。扫描时反向遍历，删除这些孤儿：

```typescript
// tool-result-sanitize.ts:87-129
for (let i = messages.length - 1; i >= 0; i--) {
  // 删除 tool_result 中没有配对 tool_call 的部分
  // 如果整个 tool 消息变空：
  //   - 两侧都是 assistant → 替换为 user 文本占位（避免 assistant 相邻）
  //   - 否则直接 splice 删除
}
```

---

## 九、buildTools：工具集的组装

```typescript
// packages/core/src/agent/loop.ts:204-246
function buildTools(options: AgentOptions) {
  const tools = { ...toolRegistry }                         // 13 个静态工具

  if (options.subAgentRegistry) tools.task = createTaskTool(...)    // 子 agent 工具
  if (options.skillRegistry?.names().length) tools.activateSkill = ...  // 技能激活工具
  if (options.mcpRegistry) {
    tools.listMcpResources = listMcpResources               // MCP 内建工具
    tools.readMcpResource = readMcpResource
    for (const entry of options.mcpRegistry.list()) {
      tools[entry.callableName] = bridgeMcpTool(entry)      // MCP 桥接工具（无 execute）
    }
  }

  // 应用 toolFilter（子 agent 限制）
  if (filter.allow) { /* 只保留白名单 */ }
  if (filter.deny) { /* 删除黑名单 */ }
  return tools
}
```

`★ Insight ─────────────────────────────────────`
**MCP 工具注册时没有 `execute` 函数。** 这意味着 AI SDK 不会自动执行它们，而是把 `tool_call` 放进 `result.toolCalls`，由 `processToolCalls` 手动分发——这样才能走权限检查和 loop-guard 管线。
`─────────────────────────────────────────────────`

---

## 十、流式 chunk 的工具结果截断策略

不同工具有不同的截断策略（`tool-result-sanitize.ts:20-32`）：

```typescript
const PER_TOOL_POLICY: Record<string, TruncateOptions> = {
  readFile: { direction: 'head-tail' },    // 保留文件头尾
  grep: { direction: 'head', maxLines: 500 },     // 词法有序，头即可
  glob: { direction: 'head', maxLines: 500 },
  listDir: { direction: 'head', maxLines: 500 },
  webFetch: { direction: 'head-tail' },    // 保留首尾锚点
  webSearch: { direction: 'head-tail' },
  shell: { direction: 'head' },            // 最重要的输出在开头
}
```

---

## 十一、Abort 取消流的完整路径

用户按 Esc 时的信号传递链：

```
stdin raw mode → usePromptInput 解析 Esc
  → ChatInput.onEscapeCancel
    → useAgent.abort()
      → abortControllerRef.current.abort()
        → AbortSignal 传入 agentLoop
          → runTurn → streamText({ abortSignal })
            → AI SDK 取消流
          → executeShell → shell-provider.spawn({ signal })
            → execa({ cancelSignal }) → SIGKILL 子进程树
```

关键点：
- `runTurn` 的 catch 块检测 AbortError 返回 `{ kind: 'aborted' }`
- `processToolCalls` 在 abort 时为剩余 tool_call 补推合成 `tool_result`——孤儿 tool_call（无 tool_result）会导致下一次 API 请求 400
- `aborted` 不调 `onError`——UI 显示 `[Request interrupted by user]`

---

## 十二、Ghost Tool Call 过滤

AI SDK 有时在流中拒绝了格式错误的 tool input（zod 验证失败），但该调用仍会出现在 `result.toolCalls` 中。如果盲目执行：

1. `writeFile` / `edit` / `shell` 会触发真实副作用
2. 推入的 `tool_result` 会成为孤儿（assistant 消息中无对应 `tool_call`）

`processToolCalls` 用 `collectActiveAssistantToolCallIds` 过滤：

```typescript
// packages/core/src/agent/tool-execution.ts:645-660
function collectActiveAssistantToolCallIds(state: LoopState): Set<string> {
  const ids = new Set<string>()
  for (let i = state.messages.length - 1; i >= 0; i--) {
    if (msg.role === 'user') break  // 遇到 user 消息停止——只扫当前轮
    // 收集 assistant 消息中所有 tool-call 类型的 part
  }
  return ids
}
```

---

## 十三、续写机制（length finishReason）

当模型输出被 `max_tokens` 截断时，agentLoop 自动追加一条续写提示：

```typescript
// packages/core/src/agent/loop.ts:609-628
if (outcome.finishReason === 'length') {
  if (continuationAttempts < MAX_CONTINUATIONS) {
    continuationAttempts++
    state.messages.push({
      role: 'user',
      content: 'Output token limit hit. Resume directly — no apology, no recap...',
    })
    continue  // 下一轮模型从中断处接着写
  }
  callbacks.onError(new Error(`Response still truncated after 3 attempts...`))
  break
}
```

续写提示不进入 UI messages——用户看到的是一条连续的流式输出，只是中间有一次短暂停顿。进入 `tool-calls` 分支时重置计数器，因为成功的工具调用说明模型在做实质进展。

---

## 十四、完整的心智模型

整个 agent loop 可以理解为三方 ping-pong 对话：

```
    user              assistant              tool
     │                    │                    │
     │ "把 X 改一下"      │                    │
     │ ──────────────────▶│                    │
     │                    │ 先 readFile 看看   │
     │                    │ ──────────────────▶│  ← runTurn #1
     │                    │      文件内容      │     finishReason='tool-calls'
     │                    │ ◀╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │  ← processToolCalls
     │                    │ 再 edit 改一行     │
     │                    │ ──────────────────▶│  ← runTurn #2
     │                    │      修改完成      │     finishReason='tool-calls'
     │                    │ ◀╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │  ← processToolCalls
     │ "改好了，diff 如下" │                    │
     │ ◀╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │                    │  ← runTurn #3
     ▼                    ▼                    ▼     finishReason='stop'
```

每轮 `runTurn` = 一次 "assistant 出球 → tool 回球"；`finishReason='tool-calls'` 时回到 assistant 继续递球，`finishReason='stop'` 时整条链回到 user 收尾。

---

## 十五、源码索引

| 文件 | 关键导出 | 行号 |
|------|---------|------|
| `loop.ts` | `agentLoop` | 375 |
| `loop.ts` | `runTurn` | 247 |
| `loop.ts` | `streamChunksToUI` | 87 |
| `loop.ts` | `collectTurnResponse` | 126 |
| `loop.ts` | `TurnOutcome` 类型 | 174 |
| `loop.ts` | `buildTools` | 204 |
| `loop-state.ts` | `LoopState` 接口 | 11 |
| `loop-state.ts` | `createLoopState` | 92 |
| `tool-execution.ts` | `processToolCalls` | 746 |
| `tool-execution.ts` | `handleToolCall` | 472 |
| `tool-execution.ts` | `partitionToolCalls` | 724 |
| `tool-execution.ts` | `BYPASS_LOOP_GUARD_HANDLERS` | 354 |
| `tool-result-sanitize.ts` | `repairOrphanToolCalls` | 68 |
| `tool-result-sanitize.ts` | `truncateToolResultsInMessages` | 183 |
| `compression.ts` | `checkAndCompressContext` | 69 |
| `compression.ts` | `handleContextTooLong` | 143 |
| `types/index.ts` | `AgentCallbacks` | 124 |
| `types/index.ts` | `AgentOptions` | 169 |
| `types/index.ts` | `TokenUsage` | 56 |
