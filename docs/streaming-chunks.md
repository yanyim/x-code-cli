# 流式 Chunk 处理：实现原理与核心要点

> 本文档是 `docs/agent-loop.md` 第十章的独立深度讲解，涵盖 fullStream chunk 类型分流、reasoning chunk 取舍、tool-call 进度回调时序、排空与异常处理的完整代码追踪。

---

## 一、fullStream：AI SDK v6 的统一流

AI SDK v6 的 `streamText()` 返回一个 `StreamResult` 对象（`stream-utils.ts:5-42`），核心字段是 `fullStream`——一个异步迭代器，每个 chunk 代表模型流式输出的一片信息。

```typescript
// stream-utils.ts:5-18
export interface StreamResult {
  fullStream: AsyncIterable<{
    type: string
    text?: string
    toolName?: string
    input?: unknown
    output?: unknown
    toolCallId?: string
    error?: unknown   // SDK 不从迭代器抛错，而是入队 error chunk 后关流
  }>
  response: Promise<{ messages: ModelMessage[] }>
  usage: Promise<{ inputTokens?: number; outputTokens?: number; ... } | undefined>
  finishReason: Promise<string>
  toolCalls: Promise<Array<{ toolName: string; toolCallId: string; input: Record<string, unknown> }>>
}
```

### 1.1 为什么需要统一流？

不同供应商的流式协议完全不同：

| 供应商 | 原始协议 | SDK 归一后 |
|--------|----------|-----------|
| Anthropic | `content_block_start/delta/stop` 事件流 | `text-delta` / `tool-call` / `tool-result` |
| OpenAI | `choices[0].delta.tool_calls` 增量式 | `tool-call`（合并 delta 后的完整 input） |
| Google | `functionCall` + `functionResponse` | `tool-call` / `tool-result` |
| DeepSeek | `choices[0].delta.reasoning_content` | `reasoning-delta` |

SDK 把这些差异全部归一成同一种 chunk 格式——客户端只看 `chunk.type`，不关心来自哪家供应商。

### 1.2 完整的 chunk 类型表

| chunk type | 含义 | 何时产生 |
|------------|------|----------|
| `text-delta` | 模型生成的文本片段（1-5 字符） | 模型输出文本时，逐字符/逐词 |
| `tool-call` | 模型决定调用工具（含完整 input） | 模型输出 `tool_use` content block |
| `tool-result` | 自动执行工具的返回值 | 带 `execute` 函数的工具执行完成后 |
| `reasoning-start` | 推理段开始 | thinking 模型开始推理时 |
| `reasoning-delta` | 推理内容片段 | thinking 模型逐词推理 |
| `reasoning-end` | 推理段结束 | thinking 模型推理完成 |
| `error` | 供应商错误 | API 请求失败时（SDK 不抛、入队后关流） |
| `finish` | 本轮结束 | 含 `finishReason`（stop / tool-calls / length 等） |

---

## 二、streamChunksToUI：chunk 分流核心循环

`loop.ts:87-123` 的 `streamChunksToUI` 是核心——消费 `fullStream`，把每种 chunk 派发到对应的 UI 回调。

### 2.1 完整流程追踪

```
streamChunksToUI(result, callbacks)    (loop.ts:87-123)
  │
  └─ for await (const chunk of result.fullStream)
      │
      ├─ chunk.type === 'error'
      │   └─ 主动 re-throw 原始错误
      │      → 控制权交给外层 try/catch（runTurn line 336）
      │      → 避免 NoOutputGeneratedError 覆盖真实错误
      │
      ├─ chunk.type === 'text-delta'
      │   └─ callbacks.onTextDelta(chunk.text ?? '')
      │      → UI 累计到流式缓冲区，实时渲染
      │
      ├─ chunk.type === 'tool-call'
      │   ├─ setProgressReporter(toolCallId, cb)   ← 注册进度通道
      │   └─ callbacks.onToolCall(id, name, input)  ← 通知 UI
      │
      ├─ chunk.type === 'tool-result'
      │   ├─ truncateToolResult(raw)                ← 截断工具输出
      │   ├─ clearProgressReporter(toolCallId)      ← 清进度通道
      │   └─ callbacks.onToolResult(id, result)     ← 通知 UI
      │
      ├─ chunk.type === 'reasoning-*'
      │   └─ 忽略（仅 debugLog 记录）
      │
      └─ 其他 chunk type
          └─ debugLog('stream.other-chunk', chunk.type)
```

### 2.2 为什么 error chunk 必须主动 re-throw

这是最容易踩的坑。AI SDK v6 的行为是（`stream-text.ts:1910`）：

1. API 请求失败（余额不足、鉴权失败、5xx 等）
2. SDK **不从迭代器抛错**，而是入队一个 `{ type: 'error', error: ... }` chunk
3. 然后关闭流——`for await` 循环正常退出

如果不识别 error chunk：

```
for await 循环正常退出
  → await result.response
    → SDK 发现"既没有输出也没有 error chunk"
      → 抛 NoOutputGeneratedError
        → 用户看到 "No output generated" 而不是 "余额不足"
```

所以 `streamChunksToUI` 的第一件事就是检查 error chunk 并 re-throw：

```typescript
// loop.ts:89-96
if (chunk.type === 'error') {
  throw chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error))
}
```

这把控制权交给 `runTurn` 的外层 try/catch（`loop.ts:336`），然后走 `classifyApiError` 错误分类路径，展示用户友好的消息（如 "API account balance insufficient (402)"）。

### 2.3 tool-result 的截断

工具输出在流式 chunk 阶段就做了截断：

```typescript
// loop.ts:113-116
} else if (chunk.type === 'tool-result') {
  const raw = typeof chunk.output === 'string' ? chunk.output : JSON.stringify(chunk.output ?? '')
  if (chunk.toolCallId) clearProgressReporter(chunk.toolCallId)
  callbacks.onToolResult(chunk.toolCallId ?? '', truncateToolResult(raw))
}
```

`truncateToolResult`（来自 `tools/index.ts`）对结果做 2000 行 / 50 KB 的双重预算截断。这是 UI 展示层面的截断——在 `collectTurnResponse` 中还会做一次针对 `state.messages` 的截断（`truncateToolResultsInMessages`），确保持久化的消息也是截断后的版本。

---

## 三、Reasoning Chunk：丢弃的 UI 决策

### 3.1 为什么忽略 reasoning chunk

推理内容是 thinking 模型（DeepSeek-V4、Claude extended thinking、Gemini 2.5 Pro thinking budget）的内部思考过程。直接渲染会让 UI 充满自言自语：

```
让我想想...用户问的是 X，我应该先 readFile...
等等，文件路径可能是 Y...
还是先 grep 一下...
```

代码中的处理（`loop.ts:117-122`）：

```typescript
} else {
  debugLog('stream.other-chunk', chunk.type)
}
// reasoning-delta / reasoning-start / reasoning-end：刻意不进 UI，
// 但在 debug 模式下通过 stream.other-chunk 记录。
```

### 3.2 "丢弃"不影响 token 计费

关键区别：

| 层面 | reasoning chunk 的处理 | 影响 |
|------|----------------------|------|
| **UI** | 丢弃，不渲染 | 用户看不到中间思考 |
| **token 计费** | 不影响 | 供应商已经计费，客户端渲不渲染无所谓 |
| **response.messages** | SDK 照样写回 | `response.messages` 包含 reasoning content parts |
| **state.messages** | 照样存入 | 下一轮 API 请求带着发出去 |

### 3.3 DeepSeek-V4 的特殊要求

DeepSeek-V4 Reasoner 有一个严格约束：每条 assistant 消息必须携带 `reasoning_content` 字段，否则下一轮请求直接 400。

`collectTurnResponse` 中用 `ensureReasoningContentParts`（`provider-compat.ts:25-39`）主动补齐：

```typescript
// loop.ts:141
ensureReasoningContentParts(state.messages, modelId)

// provider-compat.ts:25-39
export function ensureReasoningContentParts(messages: ModelMessage[], modelId: string): void {
  if (!modelId.includes('deepseek-v4')) return  // 只对 DeepSeek-V4 生效

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    const content = msg.content
    if (!Array.isArray(content)) continue

    const hasReasoning = (content as Array<{ type: string }>).some((p) => p.type === 'reasoning')
    if (!hasReasoning) {
      // 补一个空的 reasoning part
      ;(content as Array<{ type: string; text?: string }>).unshift({ type: 'reasoning', text: '' })
    }
  }
}
```

为什么需要？因为模型可能在某些轮次（如纯文本回复）不产生 reasoning content，但 `response.messages` 中 assistant 消息缺少 `reasoning_content` 会让 DeepSeek 下一轮请求失败。补一个空 `{ type: 'reasoning', text: '' }` 满足供应商约束。

---

## 四、Tool-Call 进度回调：时序是关键

### 4.1 问题背景

自动执行的工具（readFile / grep / webFetch 等 6 个带 `execute` 函数的工具）在运行过程中会推送"我现在在做什么"的进度消息。但 AI SDK 的 tool `execute` 函数是 SDK 自己调用的——我们没有调用入口，没法直接传回调参数进去。

解决方案：一个模块级的 `Map<toolCallId, callback>` 注册表。

### 4.2 进度上报架构

```
progress.ts 的全局注册表：

reporters = new Map<string, ProgressReporter>()

三步生命周期：

  ① 注册：agent loop 收到 tool-call chunk 时
     setProgressReporter(toolCallId, (msg) => callbacks.onToolProgress(toolCallId, msg))

  ② 使用：工具 execute() 内部运行时
     reportProgress(toolCallId, "Searching: query")  →  reporters.get(id)?.(msg)

  ③ 清理：agent loop 收到 tool-result chunk 时
     clearProgressReporter(toolCallId)  →  reporters.delete(id)
```

源码（`progress.ts:18-34`）：

```typescript
export type ProgressReporter = (message: string) => void

const reporters = new Map<string, ProgressReporter>()

export function setProgressReporter(toolCallId: string, fn: ProgressReporter): void {
  reporters.set(toolCallId, fn)
}

export function clearProgressReporter(toolCallId: string): void {
  reporters.delete(toolCallId)
}

export function reportProgress(toolCallId: string | undefined, message: string): void {
  if (!toolCallId) return
  reporters.get(toolCallId)?.(message)  // 可选链——没注册时静默跳过
}
```

### 4.3 各工具的进度消息

| 工具 | 进度消息 | 源码位置 |
|------|---------|---------|
| `webSearch` | `"Searching: <query>"` | `web-search.ts:111` |
| `webFetch` | `"Fetching <url>"` / `"Using cached copy"` | `web-fetch.ts:157,161` |
| `grep` | `"Searching for /<pattern>/"` | `grep.ts:53` |
| `readFile` | `"Reading <filePath>"` | `read-file.ts:127` |
| `listDir` | `"Listing <dirPath>"` | `list-dir.ts:18` |
| `glob` | `"Matching <pattern>"` | `glob.ts:44` |

每个工具一般只在 execute 入口处报一次进度。UI 显示最新一条（覆盖式更新）。

**特殊情况：shell 命令**。Shell 开始时通过 `reportProgress` 报一次 `"Running command..."`，之后子进程的流式输出不走 progress map，而是通过独立的 `onShellOutput` 回调（`tool-execution.ts` 直接调用）把每行推到 UI 滚动区。最终结果仍然通过 `onToolResult` 传递。

### 4.4 关键时序约束

```typescript
// loop.ts:107-110
if (chunk.toolCallId) {
  // 步骤 1：注册进度回调（必须在 SDK 调 execute 之前）
  setProgressReporter(toolCallId, (msg) => callbacks.onToolProgress(toolCallId, msg))
}
// 步骤 2：通知 UI 工具开始
callbacks.onToolCall(chunk.toolCallId ?? '', chunk.toolName ?? '', ...)
```

时序分解：

```
1. for-await 循环 yield 一个 tool-call chunk
2. 同步执行 setProgressReporter（写 map）     ← 必须在这步完成
3. 同步执行 callbacks.onToolCall（通知 UI）
4. 下一次 await result.fullStream 把控制权交回 SDK
5. SDK 同步调 execute(input, { toolCallId })   ← 这时 map 里必须有 reporter
6. execute 第一行可能就调 reportProgress(...)   ← 首条进度必须能找到 reporter
```

如果步骤 2 和 3 颠倒（先通知 UI，再注册 reporter），看起来大多数时候没问题——因为从 `onToolCall` 到下一次 yield 之间是同步代码，SDK 还没拿到控制权。但正确的顺序保证了**所有**场景下都不丢进度，包括工具 execute 实现中"第一句就 reportProgress"的情况。

### 4.5 为什么不用 AI SDK 的 tool 参数传递？

`progress.ts` 的模块头注释（`progress.ts:10-17`）解释了设计选择：

> AI SDK 确实通过 `{ toolCallId }` 作为 execute 的第二个参数暴露了调用 ID，但没有办法通过 `streamText({ tools })` 定义把 per-call 的 UI 回调传进去——除非包装每个工具。用 `toolCallId` 查找让工具定义保持干净，同时对手动分发的工具（shell / writeFile / edit / askUser）也一样工作。

手动分发的工具（不带 `execute` 函数的）在 `tool-execution.ts` 中执行，那里可以直接访问 `callbacks`——但 SDK 自动执行的工具不在我们的调用路径上，所以需要这条旁路通道。

---

## 五、进度上报的完整实现

"工具正在做什么"这条状态指示器看似简单，背后涉及两条独立的数据通道和一套精心设计的时序保证。本节从头讲清楚整个进度上报系统的实现。

### 5.1 两条通道：progress map 与 onShellOutput

进度上报有两条完全不同的路径：

```
通道 1：progress map（适用于所有工具）
  工具 execute() 内调 reportProgress(toolCallId, msg)
    → progress.ts 的全局 Map 查找 toolCallId 对应的回调
      → callbacks.onToolProgress(toolCallId, msg)
        → UI 更新工具行上方的状态指示器（覆盖式，只显示最新一条）

通道 2：onShellOutput（仅 shell 工具）
  shell 子进程 stdout/stderr 的每个 data 事件
    → callbacks.onShellOutput(chunk)
      → UI 滚动区追加输出行（累积式，全部保留）
```

**为什么 shell 需要两条通道？** 因为 shell 命令的输出是流式的、持续的——`npm test` 可能输出几百行，每行都是用户想看到的实时反馈。如果把这些全塞进 progress map（覆盖式），用户只能看到最后一行；如果全塞进 onToolProgress，每行都触发 setState，性能爆炸。

所以 shell 的设计是：
- **progress map**：报一次 "Running command..." 和持续更新的最新行摘要（节流后）
- **onShellOutput**：把子进程的每一块输出直接推到 UI 滚动区

### 5.2 SDK 自动执行工具的进度上报（6 个工具）

这 6 个工具（readFile / glob / grep / listDir / webSearch / webFetch）有 `execute` 函数，由 AI SDK 在收到 `tool-call` chunk 后自动调用。进度上报走通道 1。

**时序（以 grep 为例）：**

```
① 模型输出 tool-call chunk { toolName: 'grep', input: { pattern: 'TODO' }, toolCallId: 'abc123' }

② streamChunksToUI 处理该 chunk：
   ├─ setProgressReporter('abc123', (msg) => callbacks.onToolProgress('abc123', msg))  ← 注册
   └─ callbacks.onToolCall('abc123', 'grep', { pattern: 'TODO' })                       ← 通知 UI

③ for-await 循环的下一次 await 把控制权交回 SDK

④ SDK 同步调 execute({ pattern: 'TODO' }, { toolCallId: 'abc123' })

⑤ grep.ts:53 — 工具 execute 入口的第一句：
   reportProgress('abc123', 'Searching for /TODO/')   ← 从 map 找到回调，触发 onToolProgress

⑥ grep.ts:54 — 实际执行 ripgrep：
   const { stdout } = await execFileAsync(rgPath, args, { maxBuffer, timeout })

⑦ execute 返回结果，SDK 把它包装成 tool-result chunk

⑧ streamChunksToUI 处理 tool-result chunk：
   ├─ clearProgressReporter('abc123')  ← 清理
   └─ callbacks.onToolResult('abc123', truncateToolResult(raw))
```

**为什么第 ② 步必须先 setProgressReporter 再 onToolCall？**

因为步骤 ④ 和 ⑤ 之间可能只有几微秒。如果 `reporters` map 里还没有 `abc123` 的条目，`reportProgress` 中的 `reporters.get(toolCallId)?.(message)` 可选链会静默跳过——不报错，但首条进度丢了。任何工具的 execute 实现都是"try 块进去第一句就 reportProgress(...)"，所以注册必须在 SDK 调 execute 之前完成。

**各工具的进度消息（源码对照）：**

```typescript
// read-file.ts:127
reportProgress(toolCallId, `Reading ${filePath}`)

// grep.ts:53
reportProgress(toolCallId, `Searching for /${pattern}/`)

// glob.ts:44
reportProgress(toolCallId, `Matching ${pattern}`)

// list-dir.ts:18
reportProgress(toolCallId, `Listing ${dirPath}`)

// web-search.ts:111
reportProgress(toolCallId, `Searching: ${query}`)

// web-fetch.ts:157,161
reportProgress(toolCallId, 'Using cached copy')     // 命中缓存时
reportProgress(toolCallId, `Fetching ${url}`)        // 实际请求时
```

### 5.3 手动分发工具的进度上报（8 个工具）

没有 `execute` 函数的工具（writeFile / edit / shell / askUser / task / enterPlanMode / exitPlanMode / todoWrite）在 `tool-execution.ts` 的 `handleToolCall` / `processToolCalls` 中手动执行。这些工具直接访问 `callbacks`，但进度上报仍然复用同一个 progress map。

```typescript
// tool-execution.ts:60 — writeFile
reportProgress(toolCallId, `Writing ${filePath}`)

// tool-execution.ts:90 — edit
reportProgress(toolCallId, `Editing ${filePath}`)

// tool-execution.ts:123 — shell
reportProgress(toolCallId, 'Running command...')

// tool-execution.ts:262 — task（子 agent）
reportProgress(toolCallId, `Task: ${description} (${agentName})`)

// tool-execution.ts:339 — readMcpResource
reportProgress(toolCallId, `Reading ${uri}`)

// tool-execution.ts:629 — handleMcpToolCall
reportProgress(toolCallId, `Calling ${entry.serverName}/${entry.rawName}`)
```

手动分发的工具在 `processToolCalls` 中执行，此时 `streamChunksToUI` 的 for-await 循环已经结束——不会有 tool-call chunk 到达。进度回调的注册来自 `collectActiveAssistantToolCallIds`（收集 `response.messages` 中的 tool_call IDs），在 `processToolCalls` 开始前统一注册。

### 5.4 Shell 的特殊通道：onShellOutput + 节流

Shell 是最复杂的进度上报场景——子进程持续输出，需要实时显示又不能每行都触发 UI 重渲染。

**完整流程（`tool-execution.ts:115-158`）：**

```typescript
// tool-execution.ts:121-151
const proc = getShellProvider().spawn(command, { timeout, signal })

// 步骤 1：报初始进度
reportProgress(toolCallId, 'Running command...')

// 步骤 2：节流参数
let lastProgressTime = 0
const PROGRESS_THROTTLE_MS = 50    // 最多 20 次/秒

// 步骤 3：子进程输出的处理函数
const onChunk = (chunk: Buffer) => {
  const s = chunk.toString()

  // 通道 2：所有输出直接推到 UI 滚动区（不节流）
  callbacks.onShellOutput(s)

  // 通道 1：节流后的 progress map 更新（只推最新行摘要）
  const now = Date.now()
  if (now - lastProgressTime < PROGRESS_THROTTLE_MS) return  // 节流：50ms 内跳过

  const lines = s.split(/\r?\n/).filter((l) => l.trim().length > 0)
  const last = lines[lines.length - 1]
  if (last) {
    lastProgressTime = now
    const trimmed = last.length > 120 ? last.slice(0, 117) + '...' : last
    reportProgress(toolCallId, trimmed)    // 最新非空行作为进度消息
  }
}

// 步骤 4：同时监听 stdout 和 stderr
proc.stdout?.on('data', onChunk)
proc.stderr?.on('data', onChunk)

// 步骤 5：等待子进程结束
const result = await proc
```

**为什么需要 50ms 节流？** 注释解释得很清楚（`tool-execution.ts:125-134`）：

> PowerShell Format-Table 等表格渲染命令在约 1ms 的突发中发出多行，每行作为单独的 data 事件。不节流的话每毫秒触发 5-10 次 reportProgress，每次都变成 setState → ChatInput render → 延迟 stdout write。如果延迟触发定时器恰好在 tool-result commit 到达前约 1ms 触发，用户会看到明显的"进度文字闪烁，然后结果块滚入"现象。在源头节流把风暴降到 ≤20 次/秒。

**onShellOutput 不节流的原因**：它推送的是滚动区内容，UI 用独立的缓冲区机制处理（追加到日志区，不影响工具行上方的状态指示器）。滚动区可以承受高频更新——它只需要追加文本，不做 diff 重绘。

**进度消息的截断**（`tool-execution.ts:149`）：

```typescript
const trimmed = last.length > 120 ? last.slice(0, 117) + '...' : last
```

120 字符截断——进度消息是状态指示器，不需要显示完整行。模型通过 tool-result 看到的输出是完整的，不受截断影响。

### 5.5 进度通道的清理时机

```
SDK 自动执行工具：
  注册 → tool-call chunk 到达时（streamChunksToUI）
  清理 → tool-result chunk 到达时（streamChunksToUI）

手动分发工具：
  注册 → processToolCalls 收集 toolCallIds 时
  清理 → pushToolResult 被调用时（tool-execution.ts 的各 handle 函数最终都调 pushToolResult）
```

清理不及时会导致 Map 中积累已完成的 toolCallId 条目——内存泄漏。但因为是 per-session 的短生命周期 Map，实际影响可忽略。更关键的是防止 stale callback 干扰下一个同名 toolCallId（理论上可能，但 SDK 保证 ID 全局唯一）。

### 5.6 进度上报的全景图

```
                    ┌──────────────────────────────────────────┐
                    │            Agent Loop                     │
                    │                                           │
  tool-call chunk   │   streamChunksToUI()                      │
  到达 ─────────────→     setProgressReporter(id, cb)          │
                    │     callbacks.onToolCall(id, name, input) │
                    │                                           │
  SDK 调 execute()  │   ┌─ readFile ────┐  ┌─ grep ────┐      │
                    │   │ reportProgress │  │ reportProgress   │
                    │   │ ("Reading X")  │  │ ("Searching")   │
                    │   └───────────────┘  └──────────┘      │
                    │                                           │
  tool-result chunk │   clearProgressReporter(id)               │
  到达 ─────────────→     callbacks.onToolResult(id, result)   │
                    │                                           │
                    │   ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   │
                    │                                           │
  processToolCalls  │   ┌─ shell ──────────────────────┐       │
  (手动分发)        │   │ reportProgress("Running...") │       │
                    │   │                              │       │
                    │   │ proc.stdout.on('data', cb)    │       │
                    │   │   → callbacks.onShellOutput() │ ← 通道 2
                    │   │   → reportProgress(throttled) │ ← 通道 1
                    │   │                              │       │
                    │   │ result → pushToolResult()     │       │
                    │   └──────────────────────────────┘       │
                    │                                           │
                    │   ┌─ writeFile / edit ──────────┐        │
                    │   │ reportProgress("Writing X") │        │
                    │   │ reportProgress("Editing X") │        │
                    │   └─────────────────────────────┘        │
                    └──────────────────────────────────────────┘

  progress.ts 的全局 Map<toolCallId, callback>
    ↑ 注册                ↑ 查找                  ↑ 清理
    setProgressReporter   reportProgress           clearProgressReporter
```

---

## 七、排空（Drain）与异常处理

### 7.1 sibling promise 问题

`StreamResult` 暴露四个独立的 promise（`stream-utils.ts:19-41`）：

```typescript
response: Promise<{ messages: ModelMessage[] }>
usage: Promise<{ inputTokens: number; ... }>
finishReason: Promise<string>
toolCalls: Promise<Array<{...}>>
```

这些 promise 互相独立但**共享同一个底层流**——任何一个失败都会让所有 promise 同时 reject。

问题场景：

```
1. API 请求失败
2. result.response reject  →  NoOutputGeneratedError
3. result.usage reject     →  NoOutputGeneratedError
4. result.finishReason reject  →  NoOutputGeneratedError
5. result.toolCalls reject →  NoOutputGeneratedError

Node.js 的 unhandled rejection 扫描可能在 catch 块执行前运行
→ 进程终止或 stderr 刷满 stack trace
```

### 7.2 drainStreamResult 解决方案

```typescript
// stream-utils.ts:50-56
export function drainStreamResult(result: StreamResult): void {
  const noop = () => {}
  Promise.resolve(result.response).catch(noop)
  Promise.resolve(result.finishReason).catch(noop)
  Promise.resolve(result.usage).catch(noop)
  Promise.resolve(result.toolCalls).catch(noop)
}
```

给每个 sibling promise 挂一个 `.catch(noop)`——防止 unhandled rejection。排空是**幂等的**：

- 后续 `await result.response` 仍然正常 reject
- 正常路径（无错误）时 noop 永远不触发
- 多次调用不会有副作用

### 7.3 两个调用时机

**时机 1：`await fullStream` 之前**（`loop.ts:332`）

```typescript
// loop.ts:294-332
result = streamText({...}) as unknown as StreamResult
// ← 在 await 流之前，预先给所有 sibling promise 挂 catch
drainStreamResult(result)

try {
  await streamChunksToUI(result, callbacks)
} catch (err) {
  // ...
}
```

为什么在 `await` 之前？因为流抛错时，SDK 在同一个 tick 内拒绝所有 sibling promise。如果我们等 `fullStream` 抛错后再处理，Node 的 unhandled rejection 扫描可能先运行。

**时机 2：catch 块中再次排空**（`loop.ts:339`）

```typescript
try {
  await streamChunksToUI(result, callbacks)
} catch (err) {
  drainStreamResult(result)  // ← 再次排空，确保所有 promise 都被 catch
  // ...
}
```

第二次排空是防御性的——如果流在中间某点失败，可能又产生了新的 pending promise。再排空一次确保不遗漏。

### 7.4 完整的异常处理路径

`runTurn`（`loop.ts:247-372`）有三层 try/catch：

```
runTurn
  │
  ├─ try: streamText() 构造流（line 295-325）
  │   └─ catch: 构造失败（如无效参数）→ { kind: 'error' } 或 { kind: 'aborted' }
  │
  ├─ drainStreamResult(result)              ← 第一次排空
  │
  ├─ try: streamChunksToUI() 消费流（line 334-357）
  │   │
  │   ├─ catch: 流消费失败
  │   │   ├─ drainStreamResult(result)      ← 第二次排空
  │   │   ├─ isAbortError? → { kind: 'aborted' }
  │   │   ├─ isContextTooLongError?
  │   │   │   ├─ handleContextTooLong()     ← 被动压缩（reactive 路径）
  │   │   │   ├─ abortSignal 已 aborted? → { kind: 'aborted' }
  │   │   │   └─ compressed? → { kind: 'retry' }   ← 通知 agentLoop 重试
  │   │   └─ 其他错误 → classifyApiError → { kind: 'error' }
  │   │
  │   └─ error chunk 被 re-throw 后到达这里
  │
  ├─ try: collectTurnResponse() 收集结果（line 359-371）
  │   ├─ 收 response.messages → 推入 state.messages
  │   ├─ 收 usage → 累计到 state.tokenUsage
  │   └─ 返回 finishReason → { kind: 'done', finishReason }
  │
  └─ catch: 结果收集失败
      ├─ drainStreamResult(result)          ← 第三次排空
      ├─ isAbortError? → { kind: 'aborted' }
      └─ classifyApiError → { kind: 'error' }
```

### 7.5 错误分类：classifyApiError

所有非 abort、非 context-too-long 的错误都通过 `classifyApiError`（`api-errors.ts:185-287`）转化为用户友好的消息。

分类链是**优先级有序**的——前面的匹配后面的不再检查：

```
classifyApiError(err) (api-errors.ts:185)
  │
  ├─ isContextTooLongError          → "Context too long — try /compact or /clear"
  ├─ isReasoningContentError        → "DeepSeek requires reasoning_content..."
  ├─ isMissingApiKeyError           → "API key is not set. Set <PROVIDER>_API_KEY"
  ├─ isUnauthorizedError (401)      → "API authentication failed. Check key..."
  ├─ isInsufficientBalanceError (402) → "Balance insufficient. Top up..."
  ├─ isForbiddenError (403)         → "Access forbidden..."
  ├─ isModelNotFoundError (404)     → "Model not found. Switch with /model"
  ├─ isContentPolicyError (422)     → "Blocked by safety filter..."
  ├─ isMaxTokensError               → "max_tokens exceeds limit..."
  ├─ isServiceUnavailableError (503) → "Service unavailable..."
  ├─ isRateLimitedError (429)       → "Rate limited. Retrying..." (retryable=true)
  ├─ isNetworkError                 → "Network error. Retrying..." (retryable=true)
  ├─ isTypeValidationError          → "Provider returned error: <msg>"
  ├─ isMalformedToolHistoryError    → "Orphan tool call. Will auto-repair..."
  └─ 兜底                           → 原始错误消息
```

`isContextTooLongError` 的模式匹配（`api-errors.ts:4-12`）：

```typescript
const CONTEXT_TOO_LONG_PATTERNS = [
  'maximum context length',
  'context_length_exceeded',
  'token limit',
  'prompt is too long',
  'prompt_too_long',
  'input tokens',
  'context window',
] as const
```

加上 HTTP 413 状态码（`permanentErrorFetch` 重写的），覆盖了所有主流供应商的上下文溢出表述方式。

### 7.6 上下文超限的检测方式

`isContextTooLongError`（`api-errors.ts:23-30`）使用两种信号：

```typescript
export function isContextTooLongError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  if (extractHttpStatus(msg) === 413) return true       // HTTP 状态码
  for (const pattern of CONTEXT_TOO_LONG_PATTERNS) {
    if (msg.includes(pattern)) return true               // 消息文本模式
  }
  return false
}
```

覆盖的供应商表述：

| 供应商 | 典型错误消息 |
|--------|-------------|
| Anthropic | `"prompt is too long: X tokens > context_length_exceeded"` |
| OpenAI | `"This model's maximum context length is X tokens"` |
| DeepSeek | `"token limit exceeded"` |
| 通用 | HTTP 413 Payload Too Large |

### 7.7 抑制 SDK 默认 onError

```typescript
// loop.ts:317-319
onError: ({ error }) => {
  if (process.env.DEBUG_STDOUT) debugLog('stream.onError', String(error))
},
```

SDK 默认的 `onError` 是 `console.error(error)`，会把完整的 `RetryError` 对象（堆栈 + 嵌套 `APICallError` 数组 + 供应商响应体）倾泻到 stderr。这既吓人又不可操作——用户看到满屏 stack trace 但什么也做不了。

X-Code CLI 抑制了默认行为，只保留 debug 出口（`DEBUG_STDOUT=1` 时写日志文件）。真正的错误分类由 `classifyApiError` 完成，展示一行用户友好的消息。

---

## 八、流式输出的 `onError` 抑制与错误分类的配合

```
streamText() 构造
  │
  ├─ onError: 只 debugLog（抑制默认 console.error）
  │
  ├─ 正常流式输出 → streamChunksToUI 分发
  │   ├─ text-delta → onTextDelta
  │   ├─ tool-call → setProgressReporter + onToolCall
  │   ├─ tool-result → truncateToolResult + clearProgressReporter + onToolResult
  │   └─ error → re-throw
  │
  ├─ error chunk re-throw 到 runTurn catch
  │   ├─ drainStreamResult（排空 sibling promise）
  │   ├─ isAbortError? → aborted
  │   ├─ isContextTooLongError? → handleContextTooLong（reactive 压缩）→ retry
  │   └─ classifyApiError → onError（一行用户友好消息）→ error
  │
  └─ 正常结束 → collectTurnResponse
      ├─ response.messages → state.messages
      ├─ truncateToolResultsInMessages（截断持久化消息）
      ├─ ensureReasoningContentParts（DeepSeek 推理补齐）
      ├─ usage → state.tokenUsage
      └─ finishReason → done
```

---

## 九、TurnOutcome：退出条件归一

`runTurn` 返回 `TurnOutcome`（`loop.ts:174-183`），一个 discriminated union：

```typescript
type TurnOutcome =
  | { kind: 'done'; finishReason: string; result: StreamResult }   // 正常完成
  | { kind: 'error' }                                               // 不可恢复错误
  | { kind: 'retry' }                                               // 上下文溢出 + 压缩后重试
  | { kind: 'aborted' }                                             // 用户中止
```

`agentLoop` 根据 outcome 分发（`loop.ts:582-636`）：

```typescript
if (outcome.kind === 'error') break
if (outcome.kind === 'aborted') break
if (outcome.kind === 'retry') {
  turn--        // 不计入轮次配额
  continue      // 回到 while 顶部，重新 checkAndCompressContext + runTurn
}
// kind === 'done' → 根据 finishReason 分发
if (outcome.finishReason === 'tool-calls') {
  await processToolCalls(...)
  continue
}
if (outcome.finishReason === 'length') {
  // 推送续写提示，继续循环
}
if (outcome.finishReason === 'stop') {
  completedNormally = true
  break
}
```

---

## 十、关键源文件索引

| 文件 | 行号 | 关键导出/函数 |
|------|------|---------------|
| `loop.ts` | 87-123 | `streamChunksToUI()` — chunk 分流核心循环 |
| `loop.ts` | 174-183 | `TurnOutcome` — 退出条件 discriminated union |
| `loop.ts` | 247-372 | `runTurn()` — 单轮流式请求 + 异常处理 |
| `loop.ts` | 332 | `drainStreamResult()` 第一次调用点 |
| `loop.ts` | 342-354 | reactive 压缩触发点（`isContextTooLongError`） |
| `stream-utils.ts` | 5-42 | `StreamResult` 类型定义 |
| `stream-utils.ts` | 50-56 | `drainStreamResult()` — sibling promise 排空 |
| `progress.ts` | 18-34 | `setProgressReporter` / `reportProgress` / `clearProgressReporter` |
| `tool-execution.ts` | 60 | writeFile 进度：`Writing ${filePath}` |
| `tool-execution.ts` | 90 | edit 进度：`Editing ${filePath}` |
| `tool-execution.ts` | 121-151 | shell 双通道：progress map + onShellOutput + 50ms 节流 |
| `tool-execution.ts` | 262 | task 进度：`Task: ${description}` |
| `tool-execution.ts` | 629 | MCP 工具进度：`Calling ${server}/${tool}` |
| `read-file.ts` | 127 | readFile 进度：`Reading ${filePath}` |
| `grep.ts` | 53 | grep 进度：`Searching for /${pattern}/` |
| `glob.ts` | 44 | glob 进度：`Matching ${pattern}` |
| `list-dir.ts` | 18 | listDir 进度：`Listing ${dirPath}` |
| `web-search.ts` | 111 | webSearch 进度：`Searching: ${query}` |
| `web-fetch.ts` | 157,161 | webFetch 进度：`Fetching ${url}` / `Using cached copy` |
| `api-errors.ts` | 4-12 | `CONTEXT_TOO_LONG_PATTERNS` — 上下文溢出模式表 |
| `api-errors.ts` | 23-30 | `isContextTooLongError()` — 上下文超限检测 |
| `api-errors.ts` | 185-287 | `classifyApiError()` — 错误分类链 |
| `provider-compat.ts` | 25-39 | `ensureReasoningContentParts()` — DeepSeek 推理补齐 |
| `types/index.ts` | 129-130 | `onToolProgress` / `onToolResult` 回调类型 |
| `types/index.ts` | 152 | `onShellOutput` 回调类型 |
