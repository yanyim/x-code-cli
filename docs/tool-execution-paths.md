# 工具执行的两条路径——详解

本文是对 agent loop 中"工具执行两条路径"的逐行级详解。建议先阅读 `agent-loop.md` 第六章获得概览，再回来深入细节。

---

## 一、先弄清楚一件事：工具定义里的 `execute` 字段

X-Code CLI 的 14 个工具用 AI SDK 的 `tool()` 函数定义。`tool()` 接受一个对象，其中有两个关键字段决定了工具走哪条路径：

```typescript
import { tool } from 'ai'

// 路径一：有 execute —— SDK 自动执行
export const readFile = tool({
  description: '读取文件内容...',
  parameters: z.object({ filePath: z.string() }),
  execute: async ({ filePath }, { toolCallId }) => {
    // 工具的逻辑直接写在这里
    const content = await fs.readFile(filePath, 'utf-8')
    return content
  },
})

// 路径二：无 execute —— SDK 不执行，留给 agent loop 手动处理
export const writeFile = tool({
  description: '写入文件...',
  parameters: z.object({ filePath: z.string(), content: z.string() }),
  // 没有 execute —— 注释写着 "No execute — handled manually in agent loop for permission check"
})
```

### 14 个工具的分野

| 工具 | 有 `execute`？ | 走哪条路径 | 原因 |
|------|--------------|-----------|------|
| `readFile` | **有** | 路径一：SDK 自动执行 | 纯读取，无副作用，不需要权限检查 |
| `glob` | **有** | 路径一 | 纯读取，调用 ripgrep |
| `grep` | **有** | 路径一 | 纯读取，调用 ripgrep |
| `listDir` | **有** | 路径一 | 纯读取，readdir |
| `webSearch` | **有** | 路径一 | 调用外部 API（Tavily/Brave），无本地副作用 |
| `webFetch` | **有** | 路径一 | HTTP 请求 + HTML→Markdown，无本地副作用 |
| `writeFile` | **无** | 路径二：手动分发 | 需要权限检查——用户可能拒绝写入 |
| `edit` | **无** | 路径二 | 需要权限检查——修改文件是有副作用的 |
| `shell` | **无** | 路径二 | 需要权限检查 + 跨平台 shell 处理 + 流式输出 |
| `askUser` | **无** | 路径二 | 需要通过 UI 回调触发弹窗渲染 |
| `todoWrite` | **无** | 路径二 | 修改 LoopState 状态 |
| `enterPlanMode` | **无** | 路径二 | 切换权限模式 |
| `exitPlanMode` | **无** | 路径二 | 切换权限模式 + 请求 plan 审批 |
| `task` | **无** | 路径二 | 派生子 agent，需要隔离的 LoopState |

（`listDir` / `listMcpResources` / `readMcpResource` 等也是路径二，但属于 MCP 子系统，后面会讲。）

**核心判断标准：工具是否需要"人类参与决策"或"修改共享状态"。** 读文件不需要问用户，直接跑就行；写文件必须问用户"你允许吗？"。

---

## 二、路径一：SDK 自动执行（6 个读类工具）

### 2.1 时间线：SDK 自动执行时发生了什么

当模型输出的文本中包含 `tool_call`（如 "我要调用 readFile"）时，AI SDK 做了这些事：

```
时间 ──────────────────────────────────────────────────►

模型输出 tool_call chunk
  │
  ▼
SDK 解析出 toolName = "readFile", input = {filePath: "/foo/bar.ts"}
  │
  ├── 检查 readFile 工具有 execute 函数？ → 有！
  │
  ▼
SDK 立即同步调用 execute(input, {toolCallId})
  │   └─ readFile.execute 读取文件，返回内容字符串
  │
  ▼
SDK 把结果打包成 {type: 'tool-result', toolCallId, output: "文件内容..."}
  │
  ├── 方式 A：通过 fullStream 发出 tool-result chunk → streamChunksToUI 转发给 UI
  │
  └── 方式 B：把结果写入 response.messages → collectTurnResponse 推入 state.messages
```

整个过程 agent loop 代码不需要做任何事——SDK 全自动完成。

### 2.2 代码追踪：从 streamText 到 tool-result chunk

当 `streamText()` 被调用时，SDK 开始接收模型的 SSE 流。模型输出类似这样的内容：

```json
{"type": "tool_call", "toolCallId": "call_abc123", "toolName": "readFile", "input": {"filePath": "/src/index.ts"}}
```

SDK 看到 `readFile` 在 tools 注册表中有 `execute`，于是：

**Step 1**：SDK 把这个 tool-call 通过 `fullStream` 发出来。`streamChunksToUI` 收到：

```typescript
// loop.ts:87-126 — streamChunksToUI
for await (const chunk of result.fullStream) {
  // ...
  if (chunk.type === 'tool-call') {
    // chunk = { type: 'tool-call', toolCallId: 'call_abc123', toolName: 'readFile', input: {...} }

    // 注册进度旁路通道（readFile 内部调 reportProgress 时通过这里转发给 UI）
    setProgressReporter(toolCallId, (msg) => callbacks.onToolProgress(toolCallId, msg))

    // 通知 UI："模型正在调用 readFile"
    callbacks.onToolCall(toolCallId, 'readFile', input)
  }
}
```

**Step 2**：SDK **同步**执行 `readFile.execute(input, { toolCallId })`。readFile 内部：

```typescript
// read-file.ts（简化）
execute: async ({ filePath, offset, limit }, { toolCallId }) => {
  reportProgress(toolCallId, `Reading ${filePath}`)  // 通过旁路通道通知 UI "正在读取..."
  const content = await fs.readFile(filePath, 'utf-8')
  return content  // 返回给 SDK
}
```

**Step 3**：SDK 把 execute 的返回值打包成 tool-result chunk：

```typescript
// streamChunksToUI 继续迭代
if (chunk.type === 'tool-result') {
  // chunk = { type: 'tool-result', toolCallId: 'call_abc123', output: "文件内容..." }
  clearProgressReporter(chunk.toolCallId)
  callbacks.onToolResult(toolCallId, truncateToolResult(raw))  // 通知 UI "工具完成了"
}
```

**Step 4**：SDK 把结果写入 `response.messages`。`collectTurnResponse` 收集到这些消息：

```typescript
// loop.ts:126-175 — collectTurnResponse
const response = await result.response
// response.messages 现在包含了：
//   { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_abc123', ... }] }
//   { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_abc123', output: "文件内容..." }] }

// 关键：必须兜底截断！
truncateToolResultsInMessages(response.messages)

state.messages.push(...response.messages)
```

### 2.3 为什么要兜底截断？

路径一的工具结果走了 `response.messages` 这条路，**绕过了** 手动分发中的 `truncateToolResult()` 调用。如果一个 800 行的文件被读取，`response.messages` 里会有完整的 800 行。

如果不截断，这些内容会跟着每轮请求一起发给模型——读 10 次文件后上下文就爆炸了。已知最严重案例：累积到 9M token。

```typescript
// tool-result-sanitize.ts:183-239 — truncateToolResultsInMessages
// 遍历 response.messages 中的 tool 消息，对 output.value 调用 truncateToolResult
// readFile 用 head-tail 策略（保留头部 + 尾部），grep/glob 用 head-only
```

---

## 三、路径二：processToolCalls 手动分发

### 3.1 触发条件：finishReason === 'tool-calls'

当模型输出了 tool_call，但对应的工具 **没有 execute 函数** 时，SDK 不会自动执行。它只是把 tool_call 记录在 `result.toolCalls` 中。

`agentLoop` 主循环看到 `finishReason === 'tool-calls'` 后，取出这些 tool_calls 交给 `processToolCalls`：

```typescript
// loop.ts:539-552（主循环中）
if (outcome.finishReason === 'tool-calls') {
  continuationAttempts = 0
  let toolCalls = await outcome.result.toolCalls   // 拿到所有 tool_call
  await processToolCalls(toolCalls, state, options, callbacks, model)
  continue  // 继续下一轮 runTurn
}
```

### 3.2 processToolCalls 完整流程图

```
processToolCalls(toolCalls)
  │
  ├─ 1. 收集 ID 集合
  │    ├─ collectActiveAssistantToolCallIds(state)  → 有效的 tool_call ID
  │    └─ collectFulfilledToolCallIds(state)         → 已有结果的 ID
  │
  ├─ 2. 前置过滤（生成 liveCalls）
  │    ├─ 跳过 ghost 调用（SDK 中途拒绝的，不在 activeIds 中）
  │    └─ 跳过 fulfilled 调用（已有结果，但记入 loop-guard 窗口）
  │
  ├─ 3. 分批（partitionToolCalls）
  │    ├─ 连续的 task → 归为一批（可并行）
  │    └─ 其他工具 → 各自单元素批（串行）
  │
  ├─ 4. 逐批执行
  │    └─ Promise.all(batch.map(handleToolCall))
  │         └─ handleToolCall 内部五步分发（见下节）
  │
  └─ 5. 刷出延迟消息（deferred → state.messages 尾部）
```

### 3.3 前置过滤的两种跳过

#### Ghost 调用

模型输出了 tool_call，但 SDK 验证 input 时发现格式错误（如缺少必填字段）。SDK 发出 `tool-error` chunk，把该 tool_call 从 `response.messages` 中**排除**——但它仍出现在 `result.toolCalls` 中。

如果盲目执行：
1. `writeFile` 会真的写入文件（真实副作用！）
2. 推入的 tool_result 会变成孤儿（assistant 消息中没有对应的 tool_call）

```typescript
// 收集 assistant 消息中实际存在的 tool_call ID
const activeIds = collectActiveAssistantToolCallIds(state)

// 过滤：只保留 activeIds 中有的调用
if (!activeIds.has(tc.toolCallId)) continue  // 跳过 ghost
```

#### Fulfilled 调用

路径一的自动执行工具（readFile 等）的结果已通过 `response.messages` 推入了 `state.messages`。如果路径二再执行一次，就会重复（重新获取网页、重新读取文件）。

```typescript
const fulfilledIds = collectFulfilledToolCallIds(state)

if (fulfilledIds.has(tc.toolCallId)) {
  // 仍记入 loop-guard 窗口（防止对同一自动执行工具的失控循环）
  recordToolCall(state, ...)
  continue  // 跳过，不执行
}
```

### 3.4 handleToolCall：五步分发管线

每个需要手动执行的工具调用都会经过这个管线：

```
handleToolCall(tc)
  │
  ├─ Step 0: PreToolUse hook（插件拦截）
  │    ├─ deny  → 推送合成错误结果，return
  │    └─ modify → 改写 tc.input（下游看到修改后的参数）
  │
  ├─ Step 1: 旁路检查（BYPASS_LOOP_GUARD_HANDLERS）
  │    ├─ askUser       → 直接调 callbacks.onAskUser
  │    ├─ task          → 调 runSubAgent（子 agent）
  │    ├─ todoWrite     → 更新 state.todos
  │    ├─ enterPlanMode → 切换 permissionMode
  │    ├─ exitPlanMode  → 切换 permissionMode + 请求审批
  │    ├─ listMcpResources  → 读取 MCP 注册表
  │    └─ readMcpResource    → 调 MCP server client
  │    如果命中旁路 → return（不走下面的步骤）
  │
  ├─ Step 2: MCP 工具检查
  │    └─ 如果工具名在 mcpRegistry 中 → handleMcpToolCall（独立权限路径）
  │
  ├─ Step 3: loop guard（循环保护）
  │    └─ 检测重复调用同一工具 + 相同参数 → 拦截或询问用户
  │
  ├─ Step 4: 权限检查（writeFile / edit / shell）
  │    └─ 调 checkPermission → 弹窗询问用户 Yes / Yes always / No
  │
  └─ Step 5: 实际执行
       ├─ writeFile → 创建目录、写入文件、计算 diff
       ├─ edit     → 读取文件、查找替换、计算 diff
       ├─ shell    → 启动子进程、流式输出、收集结果
       └─ 推送结果（pushSuccessfulToolResult，含 PostToolUse hook）
```

### 3.5 旁路工具：为什么它们不走 loop guard？

| 工具 | 原因 |
|------|------|
| `askUser` | 模型两次问用户同一个澄清问题**几乎总是有意的**——用户可能第一次回答含糊。如果 loop guard 拦截了第二次提问，模型的合理追问就丢失了 |
| `task` | 子 agent 有独立的 `LoopState`（自己的消息数组、自己的 recentToolCalls），不会污染父状态。并行安全 |
| `todoWrite` | 纯内存状态更新，不触碰文件系统，无副作用。重复调用只是覆盖同一数组 |
| `enterPlanMode` / `exitPlanMode` | 模式切换是一次性操作，不存在"重复切换到同一模式"的循环问题 |
| `listMcpResources` / `readMcpResource` | 纯读取，无副作用 |

### 3.6 写工具的执行细节

以 `writeFile` 为例，Step 5 的实际执行：

```typescript
// tool-execution.ts:53-115 — executeWriteTool（简化）
async function executeWriteTool(toolName, input, toolCallId, callbacks, signal) {
  if (toolName === 'writeFile') {
    const { filePath, content } = input

    // 1. 报告进度
    reportProgress(toolCallId, `Writing ${filePath}`)

    // 2. 确保目录存在
    await fs.mkdir(path.dirname(filePath), { recursive: true })

    // 3. 读取旧内容（为了算 diff）
    let oldContent = null
    try { oldContent = await fs.readFile(filePath, 'utf-8') } catch { /* 文件不存在 */ }

    // 4. 写入新内容
    await fs.writeFile(filePath, content, 'utf-8')

    // 5. 计算 diff 并通过 UI 旁路通知（不走 state.messages）
    const payload = computeEditDiff(filePath, oldContent, content)
    if (payload && callbacks.onFileEdit) callbacks.onFileEdit(toolCallId, payload)

    return oldContent ? `File written: ${filePath}` : `File created: ${filePath}`
  }
}
```

注意 diff payload 是 **UI 旁路**——它通过 `callbacks.onFileEdit` 直接发送给 UI 渲染彩色 diff 块，**不进入** `state.messages`。模型只看到简短的结果字符串 `"File written: src/foo.ts (42 lines)"`。

---

## 四、两条路径的对比总结

```
                        路径一                         路径二
                    （SDK 自动执行）               （手动分发）
  ──────────────────────────────────────────────────────────────
  触发条件           工具定义有 execute            工具定义无 execute

  谁执行             AI SDK 内部自动              processToolCalls → handleToolCall

  执行时机           流中收到 tool-call 后         runTurn 结束后，finishReason='tool-calls'

  权限检查           无（纯读操作，自动放行）       有（writeFile/edit/shell 需弹窗确认）

  loop guard         不走                          走（旁路工具除外）

  结果回流           response.messages             state.messages.push(toolResultMessage(...))

  截断方式           collectTurnResponse 中         handleToolCall 中
                    truncateToolResultsInMessages   truncateToolResult

  UI 通知            streamChunksToUI 中            pushToolResult 中
                    callbacks.onToolResult          callbacks.onToolResult

  典型工具           readFile glob grep             writeFile edit shell
                    listDir webSearch webFetch      askUser todoWrite task
                                                   enterPlanMode exitPlanMode
```

### 一张图看清两条路径

```
模型输出 tool_call（如 "我要调用 readFile"）
  │
  ▼
streamText() 的 fullStream 发出 tool-call chunk
  │
  ├── streamChunksToUI 转发给 UI：callbacks.onToolCall(...)
  │
  ▼
SDK 检查这个工具有没有 execute？
  │
  ├── 有 execute（readFile / glob / grep / listDir / webSearch / webFetch）
  │     │
  │     ├─ SDK 立即执行 execute(input, {toolCallId})
  │     │
  │     ├─ fullStream 发出 tool-result chunk
  │     │     └─ streamChunksToUI 转发给 UI：callbacks.onToolResult(...)
  │     │
  │     └─ 结果写入 response.messages
  │           └─ collectTurnResponse 推入 state.messages（带兜底截断）
  │
  └── 无 execute（writeFile / edit / shell / askUser / ...）
        │
        ├─ fullStream 不发出 tool-result chunk
        │
        ├─ tool_call 存入 result.toolCalls
        │
        └─ runTurn 结束后
              └─ agentLoop 看到 finishReason='tool-calls'
                    └─ processToolCalls 手动分发
                          └─ handleToolCall 五步管线
                                ├─ 权限检查
                                ├─ loop guard
                                └─ 实际执行
                                      └─ pushToolResult 推入 state.messages
```

---

## 五、并行分批：为什么只有 task 可以并行

`partitionToolCalls` 把连续的 `task` 调用归为一组，用 `Promise.all` 并行执行：

```typescript
// tool-execution.ts:724-738
export function partitionToolCalls(calls: ToolCall[]): ToolCall[][] {
  const batches: ToolCall[][] = []
  let i = 0
  while (i < calls.length) {
    let end = i + 1
    if (calls[i]!.toolName === 'task') {
      // 把连续的 task 调用归到同一批
      while (end < calls.length && calls[end]!.toolName === 'task') end++
    }
    batches.push(calls.slice(i, end))
    i = end
  }
  return batches
}
```

为什么只有 `task` 安全：

| 维度 | task（可并行） | 其他工具（必须串行） |
|------|---------------|-------------------|
| 状态隔离 | 每个 runSubAgent 创建新 LoopState | 共享同一个 state |
| 文件系统 | 各自操作，无交叉 | writeFile/edit 操作同一目录下的文件 |
| UI 输出 | 子 agent 的输出汇入独立 UI 块 | shell 的 stdout/stderr 直接流给父 UI，并行会交叉 |
| 权限弹窗 | 子 agent 有自己的权限上下文 | askUser / 权限弹窗持有 UI，两个同时弹出会竞争 |
| token 累计 | 完成后 additive 累加到 parentState | 中间状态被下一轮读取 |

例如，如果模型同时请求 "并行搜索两个文件的 grep"，grep 是路径一自动执行——SDK 已经并行处理了。但如果模型同时请求 "并行运行两个 shell 命令"，串行执行是因为两条命令的 stdout 会交错混乱，用户看到不可读的输出。

---

## 六、延迟消息队列（deferred）：解决消息顺序问题

### 6.1 问题描述

某些供应商（特别是 DeepSeek）严格要求消息的角色交替顺序。以下模式会被拒绝：

```
assistant (tool_calls: [A, B])
  → tool (result of A)
  → user     ← "loop guard：检测到重复调用"  ← 这条 user 消息插在两个 tool_result 之间！
  → tool (result of B)
```

DeepSeek 会 400 拒绝这种 `assistant → tool → user → tool` 的序列。

### 6.2 延迟队列的解决方案

`deferred` 数组收集那些"必须在本轮所有 tool_result 之后才落地"的消息：

```typescript
const deferred: ModelMessage[] = []

// loop guard 中如果需要插入 user 消息，不直接 push，而是放入 deferred
async function applyLoopGuard(ctx, deferred) {
  // ...
  if (loopCheck.kind === 'hard-block') {
    if (answer === 'Pause') {
      // 不直接 state.messages.push(...)
      deferred.push({
        role: 'user',
        content: '[loop-guard] User paused the loop...',
      })
    }
  }
}

// 所有批处理完成后，一次性刷出
if (deferred.length > 0) state.messages.push(...deferred)
```

最终的消息序列变成：

```
assistant (tool_calls: [A, B])
  → tool (result of A)
  → tool (result of B)
  → user   ← deferred 消息，在所有 tool_result 之后  ✓ 供应商接受
```

---

## 七、源码索引

| 文件 | 关键函数/常量 | 行号 | 作用 |
|------|-------------|------|------|
| `loop.ts` | `streamChunksToUI` | 87 | 流式 chunk 分流（路径一的通知在这里） |
| `loop.ts` | `collectTurnResponse` | 126 | 收集 response.messages（路径一的兜底截断在这里） |
| `tool-execution.ts` | `processToolCalls` | 746 | 路径二的总控：过滤 → 分批 → 执行 |
| `tool-execution.ts` | `handleToolCall` | 472 | 路径二的五步分发管线 |
| `tool-execution.ts` | `BYPASS_LOOP_GUARD_HANDLERS` | 354 | 旁路工具表 |
| `tool-execution.ts` | `partitionToolCalls` | 724 | 分批策略（task 并行、其他串行） |
| `tool-execution.ts` | `executeWriteTool` | 53 | writeFile / edit 的实际执行 |
| `tool-execution.ts` | `executeShell` | 118 | shell 的实际执行（流式输出 + 节流） |
| `tool-execution.ts` | `applyLoopGuard` | 380 | loop guard 检测（写入 deferred） |
| `tool-execution.ts` | `checkWriteOrShellPermission` | 420 | writeFile/edit/shell 权限门 |
| `tool-execution.ts` | `pushToolResult` | 180 | 推送工具结果到 state + UI |
| `tool-execution.ts` | `pushSuccessfulToolResult` | 217 | 带 PostToolUse hook 的结果推送 |
| `tool-result-sanitize.ts` | `truncateToolResultsInMessages` | 183 | 路径一的兜底截断 |
| `tools/index.ts` | `toolRegistry` | 25 | 14 个工具的统一注册表 |
| `tools/read-file.ts` | `readFile` (有 execute) | 110 | 路径一典型工具 |
| `tools/write-file.ts` | `writeFile` (无 execute) | 6 | 路径二典型工具 |
