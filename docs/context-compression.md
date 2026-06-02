# 上下文压缩：实现原理与策略详解

> 本文档是 `docs/agent-loop.md` 第七章的独立深度讲解，涵盖压缩的触发条件、三层压缩策略、JSONL 持久化语义、以及 proactive / reactive 两条路径的完整代码追踪。

---

## 一、为什么需要上下文压缩？

大语言模型（LLM）有一个硬性架构限制：**上下文窗口（context window）**。每次 API 调用时，`input tokens + output tokens ≤ context_window` 是不可违反的约束——超出时供应商直接返回 HTTP 400 或截断回复。

在 Agent Loop 场景中，消息数组 `state.messages` 会持续增长：

- 每轮对话追加 `user → assistant → tool_calls → tool_results`（一对对话可能产生 4+ 条消息）
- 工具输出（特别是 `readFile` 读大文件、`grep` 高匹配结果）可能单条数千 token
- Loop 诱导的上下文膨胀：模型反复调用同一个失败的工具，每次都产生完整的 tool_call + tool_result 对

如果不做压缩，几轮工具密集型操作后就会触及窗口上限，Agent Loop 陷入不可恢复状态。

---

## 二、Token 估算与触发阈值

### 2.1 模型上下文窗口表

`context-window.ts` 维护了一张模型→窗口大小的映射表：

```
MODEL_CONTEXT_WINDOWS（context-window.ts:28-63）

anthropic:claude-opus-4-7    → 1,000,000 tokens
anthropic:claude-sonnet-4-6  → 1,000,000 tokens
anthropic:claude-haiku-4-5   →   200,000 tokens
openai:gpt-4.1               → 1,047,576 tokens
openai:o3                    →   200,000 tokens
deepseek:deepseek-v4-flash   → 1,000,000 tokens
alibaba:qwen-turbo           → 1,000,000 tokens
alibaba:qwen-max             →    32,768 tokens   ← 注意：极小窗口
...
```

查找逻辑是两级 fallback（`context-window.ts:79-84`）：

```
1. 精确匹配 modelId        → MODEL_CONTEXT_WINDOWS.get("anthropic:claude-opus-4-7")
2. 供应商级 fallback       → PROVIDER_CONTEXT_WINDOWS.get("anthropic")
3. 全局默认值              → DEFAULT_CONTEXT_WINDOW = 128,000
```

### 2.2 压缩触发阈值：80% 规则

```typescript
// context-window.ts:15
export const COMPRESSION_TRIGGER_RATIO = 0.8

// context-window.ts:87-89
export function getCompressionThreshold(modelId: string): number {
  return Math.floor(getContextWindow(modelId) * COMPRESSION_TRIGGER_RATIO)
}
```

以 `claude-sonnet-4-6` 为例：
- 上下文窗口 = 1,000,000 tokens
- 压缩阈值 = `Math.floor(1,000,000 × 0.8)` = **800,000 tokens**

为什么不等到 100% 再触发？因为：
1. 单轮对话可能瞬间增加大量 token（读一个 1000 行文件 ≈ 4000+ tokens）
2. 估算值有误差，留 20% 安全裕量
3. 提前压缩可以避免被动路径的延迟（被动路径需要先失败再重试）

### 2.3 Token 估算机制

系统使用**两个独立信号**来判断是否需要压缩：

| 信号 | 来源 | 精度 | 时机 |
|------|------|------|------|
| `state.lastInputTokens` | API 返回的真实 `usage.inputTokens` | 高 | 上一轮 API 调用完成后 |
| `estimateTokenCount()` | 字符数 ÷ 3.0 的粗估 | 低（偏高） | 每次调用前即时计算 |

```typescript
// context-window.ts:22
const CHARS_PER_TOKEN_ESTIMATE = 3.0

// context-window.ts:125-137
export function estimateTokenCount(messages: ModelMessage[]): number {
  let chars = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content as Array<{ type: string; text?: string }>) {
        if (typeof part.text === 'string') chars += part.text.length
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE)
}
```

`CHARS_PER_TOKEN_ESTIMATE = 3.0` 是**有意偏低**的——英文约 4 字符/token，中文/代码更低。用 3.0 意味着估算值**偏高**，安全网更早触发，宁可多压缩一次也不要等到 API 报错。

### 2.4 判断条件

```typescript
// compression.ts:76
const needsCompression = state.lastInputTokens > threshold
                      || estimateTokenCount(state.messages) > threshold
```

**两个信号任一越线都触发压缩。** 这确保了：
- 正常增长被真实 token 数捕获（上一轮 API 报告的精确值）
- 暴增被字符估算捕获（本轮调用前的即时检查，不需要等 API 返回）

---

## 三、三层压缩策略：从廉价到昂贵

压缩不是一步到位的，而是**三层递进**——先尝试最廉价的方案，不够再升级：

```
第 1 层：Light Compact（O(n)，无 LLM，0ms 网络）
  ↓ 不够时
第 2 层：Session Summary（一次 generateText 往返，2-5s）
  ↓ 总是接着
第 3 层：compressMessages（又一次 generateText 往返，2-5s）
```

### 3.1 第 1 层：Light Compact — 零成本的循环卫士裁剪

**核心思想**：大部分上下文膨胀来自模型反复调用失败的工具（loop），这些消息对模型没有任何学习价值——它已经被 `[loop-guard]` 拦截并告知停止了。直接丢掉，不需要理解内容。

**源文件**：`light-compact.ts`

```
lightCompactMessages(messages)（light-compact.ts:98-117）
  │
  ├─ collectLoopGuardedIds(messages)     // 扫描所有 [loop-guard] 结果
  │   └─ 返回 Set<toolCallId>           // 被拦截的 tool call ID 集合
  │
  ├─ 遍历 messages：
  │   ├─ tool 消息内容是 [loop-guard] → 直接丢弃（dropped++）
  │   ├─ assistant 消息 → stripToolCallParts()，移除被拦截的 tool-call parts
  │   │   ├─ 有剩余 parts → 保留裁剪后的消息
  │   │   └─ 全部被移除 → 丢弃整条消息（返回 null）
  │   └─ 其他消息 → 原样保留
  │
  └─ 返回 { messages: out, dropped }
```

**关键常量**（`light-compact.ts:23`）：
```typescript
const LOOP_GUARD_SENTINEL = '[loop-guard]'
```

Loop guard 机制在 `tool-execution.ts` 中实现——当模型连续调用相同工具超过阈值时，后续调用被拦截并返回 `[loop-guard]` 前缀的通知。这些调用结果在重放时不提供任何新信息，可以安全丢弃。

**时间复杂度**：O(n)，单次遍历，没有 LLM 调用，没有网络请求。

### 3.2 第 2 层：Session Summary — 结构化会话总结

**核心思想**：如果 light compact 不够（膨胀不是来自 loop），就用 LLM 生成一段结构化总结，保留关键决策和上下文。

**源文件**：`knowledge/session.ts`

```typescript
// session.ts:23
const SESSION_SUMMARY_MESSAGE_COUNT = 20  // 只看最近 20 条消息

// session.ts:37-55
const { text } = await generateText({
  model,
  messages: [
    {
      role: 'system',
      content: `Summarize this conversation as a structured JSON object with these fields:
- title: short descriptive title (string)
- summary: 2-3 sentence overview (string)
- keyResults: what was accomplished (string[])
- pendingWork: what remains to be done (string[])
- decisions: important decisions made (string[])
- status: "completed" | "in_progress" | "abandoned"

Return ONLY valid JSON, no markdown fencing.`,
    },
    ...messages.slice(-SESSION_SUMMARY_MESSAGE_COUNT),  // 最近 20 条
  ],
})
```

返回的 `SessionSummary` 结构（`types/index.ts`）：

```typescript
interface SessionSummary {
  id: string           // 会话 ID
  startedAt: string    // 开始时间
  endedAt: string      // 结束时间
  filesModified: string[]  // 修改过的文件列表
  title: string        // 会话标题
  summary: string      // 2-3 句总结（最重要——会进入替换消息）
  keyResults: string[] // 完成了什么
  pendingWork: string[] // 还有什么没做
  decisions: string[]  // 重要决策
  status: 'completed' | 'in_progress' | 'abandoned'
}
```

这段总结会被嵌入到 JSONL 的 `compact-boundary` 行中，供 session picker 显示。JSON parse 失败时有 fallback（`session.ts:71-84`），用原始文本前 200 字符作为 summary。

### 3.3 第 3 层：compressMessages — LLM 总结替换

**核心思想**：用 LLM 把旧消息压缩成一段总结文本，保留最近 N 条消息原样不变。

**源文件**：`compression.ts:38-59`

```typescript
// compression.ts:33
export const KEEP_RECENT = 6  // 最近 6 条消息原样保留

export async function compressMessages(
  messages: ModelMessage[],
  model: LanguageModel,
): Promise<ModelMessage[]> {
  // 1. 确保"最近"切片不以孤立的 tool 消息开头
  let keepCount = KEEP_RECENT
  while (keepCount < messages.length
         && messages[messages.length - keepCount]?.role === 'tool') {
    keepCount++
  }

  // 2. 分割：旧消息 → 总结，新消息 → 原样保留
  const recent = messages.slice(-keepCount)
  const old = messages.slice(0, -keepCount)
  if (old.length === 0) return messages  // 消息太少，不压缩

  // 3. LLM 总结旧消息
  const { text: summary } = await generateText({
    model,
    system: 'Summarize the following conversation concisely, preserving key decisions, file changes, and context needed to continue.',
    messages: old,
  })

  // 4. 返回 [总结消息, ...最近消息]
  return [
    { role: 'user', content: `[Previous conversation summary]\n${summary}` },
    ...recent,
  ]
}
```

**为什么 KEEP_RECENT = 6？**

6 条消息 ≈ 1.5 轮完整对话（user → assistant → tool_calls → tool_results = 4 条），足够保持当前对话的连贯性，同时让总结承担大部分上下文。

**孤立 tool 消息保护**（`compression.ts:43-45`）：

如果直接取最近 6 条，可能第一条就是 `role: 'tool'` 的 tool_result——它没有配对的 assistant tool_calls，供应商会拒绝。所以 while 循环向前扩展直到遇到非 tool 消息。

**为什么总结是 `role: 'user'` 而不是 `role: 'system'`？**

因为供应商的 API 对消息角色有严格交替要求（user → assistant → user → ...）。用 `role: 'user'` 确保紧接着的 `role: 'assistant'` 消息在角色顺序上合法。

---

## 四、Proactive 路径（主动压缩）

**触发时机**：每轮 `streamText` 调用之前，在 `agentLoop` 的 while 循环顶部。

**调用链**：
```
agentLoop (loop.ts:513)
  └─ checkAndCompressContext(state, model, threshold, callbacks, hookCtx)
       (compression.ts:69-136)
```

### 4.1 完整流程追踪

```
checkAndCompressContext (compression.ts:69)
  │
  ├─ Step 0: 判断是否需要压缩 (line 76-77)
  │   ├─ state.lastInputTokens > threshold  ← 真实 token 数（API 报告）
  │   ├─ || estimateTokenCount(state.messages) > threshold  ← 字符估算
  │   ├─ || state.messages.length <= KEEP_RECENT  ← 太少不压缩
  │   └─ 任一 token 信号越线 + 消息足够多 → 继续
  │
  ├─ Step 1: PreCompact hook（line 82-88）
  │   └─ fire-and-forget，不等待 hook 决策
  │      （一旦越线，压缩是强制的，hook 只能观察不能阻止）
  │
  ├─ Step 2: Light Compact（line 90-111）
  │   ├─ lightCompactMessages(state.messages)
  │   ├─ if light.dropped > 0:
  │   │   ├─ state.messages = light.messages   ← 原地替换
  │   │   ├─ 重新估算 → stillOver?
  │   │   │   ├─ !stillOver → 成功！
  │   │   │   │   ├─ markBoundaryAndReflush(state)  ← 写 boundary（无总结文本）
  │   │   │   │   ├─ PostCompact hook
  │   │   │   │   └─ return（完成，不走后续昂贵路径）
  │   │   │   └─ stillOver → 继续走 LLM 总结
  │   │   └─ callbacks.onContextCompressed("Dropped N looped...")
  │   └─ if light.dropped === 0: 跳过（没有 loop-guard 可丢）
  │
  ├─ Step 3: Session Summary（line 113-123）
  │   ├─ generateSessionSummary(state.messages, model, ...)
  │   ├─ → 返回结构化 SessionSummary
  │   ├─ summaryText = summary.summary  ← 只要文本字段
  │   └─ catch → summaryText = ''（失败不阻塞，下面的 compressMessages 仍会跑）
  │
  ├─ Step 4: compressMessages（line 124）
  │   ├─ state.messages = await compressMessages(state.messages, model)
  │   ├─ state.lastInputTokens = 0  ← 重置，下轮重新从 API 获取真实值
  │   ├─ markBoundaryAndReflush(state, summaryText)  ← 写 boundary + 重新刷盘
  │   ├─ callbacks.onContextCompressed("Context compressed to fit context window.")
  │   └─ PostCompact hook
  │
  └─ return（压缩完成，agentLoop 继续跑 runTurn）
```

### 4.2 关键设计决策

**为什么先跑 light compact？**

因为它是 `$0 + 10ms` 的操作——没有网络请求、没有 LLM 调用、纯 O(n) 遍历。对于最常见的膨胀来源（loop 诱导），light compact 通常就够了。只有当膨胀来自真正的对话历史累积时，才需要花 2-5 秒走 LLM 总结路径。

**为什么 session summary 和 compressMessages 是两个独立的 LLM 调用？**

- `generateSessionSummary` 生成**结构化 JSON**（标题、状态、关键结果等），面向 session picker UX 和持久化
- `compressMessages` 生成**自然语言总结**，面向模型理解——它要替换旧消息数组，需要语义连贯

两者目的不同、prompt 不同、输出格式不同，所以是两次独立调用。

---

## 五、Reactive 路径（被动压缩）

**触发时机**：当 `streamText` 的 API 调用实际返回了 "prompt too long" 错误时。

**调用链**：
```
runTurn (loop.ts:334-356)
  ├─ streamChunksToUI → throw error
  ├─ catch: isContextTooLongError(err) → true
  └─ handleContextTooLong(state, model, callbacks, hookCtx)
       (compression.ts:143-169)
```

### 5.1 完整流程追踪

```
runTurn (loop.ts:247)
  │
  ├─ streamText({...}) → 返回流
  ├─ streamChunksToUI(result, callbacks) → 消费流
  │   └─ 遇到 error chunk → throw error
  │
  ├─ catch (err):
  │   ├─ isAbortError? → { kind: 'aborted' }
  │   ├─ isContextTooLongError(err)? → true
  │   │   │
  │   │   └─ handleContextTooLong(state, model, callbacks, hookCtx)
  │   │       (compression.ts:143-169)
  │   │       │
  │   │       ├─ 消息太少? (≤ KEEP_RECENT) → return false（无法压缩）
  │   │       ├─ PreCompact hook (trigger: 'reactive')
  │   │       ├─ state.messages = await compressMessages(state.messages, model)
  │   │       ├─ state.lastInputTokens = 0
  │   │       ├─ markBoundaryAndReflush(state)  ← 无总结文本
  │   │       ├─ callbacks.onContextCompressed("Context too long — automatically compressed. Retrying...")
  │   │       ├─ PostCompact hook (trigger: 'reactive')
  │   │       └─ return true（压缩成功，可以重试）
  │   │
  │   ├─ compressed === true → return { kind: 'retry' }
  │   └─ abortSignal 已 aborted → return { kind: 'aborted' }
  │
  └─ 回到 agentLoop:
      if (outcome.kind === 'retry') {
        turn--          // 不计入轮次配额
        continue        // 重新跑这轮
      }
```

### 5.2 Reactive 路径为什么更简单？

Reactive 路径**跳过了 light compact 和 session summary**，直接走 `compressMessages`。原因：

1. **已经失败了**——API 调用已经报错，用户正在等待，不能再花时间尝试廉价的方案
2. **状态已知**——确认超限了，不需要再估算
3. **尽快重试**——直接压缩后重发本轮请求，减少用户可见延迟

### 5.3 重试机制

```typescript
// loop.ts:584-588
if (outcome.kind === 'retry') {
  turn--        // 被动压缩恢复不计入配额
  continue      // 重新进 while 循环，从 checkAndCompressContext 开始
}
```

重试时：
- `turn--` 确保这次失败不计入 `maxTurns` 配额
- `continue` 回到 while 循环顶部，重新走 `checkAndCompressContext`（此时刚压缩过，应该不会再次触发）
- 然后跑 `runTurn` 发起新的 API 请求

**安全守卫**：如果用户在压缩期间按了 Esc（`options.abortSignal?.aborted`），直接退出而不重试，避免浪费。

---

## 六、JSONL 持久化与 compact-boundary 语义

压缩不只是改内存中的 `state.messages`——还要保持 JSONL 文件与内存状态一致，否则崩溃恢复会 resurrect 已被压缩丢弃的消息。

### 6.1 JSONL 入口类型

`session-store.ts` 定义了 5 种入口类型：

| 类型 | 字段 | 作用 |
|------|------|------|
| `HeaderEntry` | `kind: 'header'` | 会话元数据（sessionId、modelId、gitBranch 等） |
| `MsgEntry` | `kind: 'msg'` | 一条 ModelMessage |
| `UsageEntry` | `kind: 'usage'` | token 用量快照 |
| `CompactBoundaryEntry` | `kind: 'compact-boundary'` | 压缩边界标记 |
| `InterruptedEntry` | `kind: 'interrupted'` | 中断标记（信息性） |

### 6.2 正常追加：flushPendingMessages

```typescript
// session-store.ts:166-185
export async function flushPendingMessages(state: LoopState): Promise<void> {
  if (state.persistedMessageCount >= state.messages.length) return
  // 只追加新增的消息（差异追加）
  for (let i = state.persistedMessageCount; i < state.messages.length; i++) {
    const entry: MsgEntry = { t: 'msg', message: state.messages[i], ts }
    lines.push(JSON.stringify(entry))
  }
  await fs.appendFile(filePath, lines.join('\n') + '\n', 'utf-8')
  state.persistedMessageCount = state.messages.length
}
```

`state.persistedMessageCount` 是一个**游标**，记录上次刷到哪里了。每次只追加新增部分，不重写整个文件。

### 6.3 压缩时：markBoundaryAndReflush

压缩后消息数组缩短了——之前已经写入 JSONL 的旧消息不能留在那里（恢复时会被读回来）。解决方案：

```typescript
// session-store.ts:218-235
export async function markBoundaryAndReflush(state: LoopState, summary?: string): Promise<void> {
  // 1. 写一条 compact-boundary 行
  const boundary: CompactBoundaryEntry = { t: 'meta', kind: 'compact-boundary', ts }
  if (summary !== undefined) boundary.summary = summary

  // 2. 重新追加当前所有消息（完整重写）
  for (const message of state.messages) {
    const entry: MsgEntry = { t: 'msg', message, ts }
    lines.push(JSON.stringify(entry))
  }

  await fs.appendFile(filePath, lines.join('\n') + '\n', 'utf-8')
  state.persistedMessageCount = state.messages.length
}
```

为什么不用 `fs.writeFile` 覆盖，而是追加？因为：
1. 追加是原子性的（append-only），崩溃安全
2. 覆盖需要先读再写，中间崩溃可能丢失所有数据

### 6.4 加载时：compact-boundary 截断语义

```typescript
// session-store.ts:285-316
export async function loadSession(filePath: string): Promise<LoadedSession | null> {
  let messages: ModelMessage[] = []

  for (const line of raw.split('\n')) {
    // ...
    if (entry.kind === 'compact-boundary') {
      messages = []   // ← 清空！之后的行覆盖之前的
    } else if (entry.t === 'msg') {
      messages.push(entry.message)
    }
  }

  return { messages, ... }
}
```

**核心语义**：遇到 `compact-boundary` 行时清空消息累加器。所以加载后的 `messages` 只包含**最后一个 boundary 之后**的内容——而这恰好等于压缩后的内存状态（因为 `markBoundaryAndReflush` 会重新追加所有当前消息）。

```
JSONL 文件内容（简化）：

msg: user "你好"
msg: assistant "我来帮你..."
msg: user "读一下 a.txt"
msg: assistant [tool_call: readFile]
msg: tool [result: "文件内容..."]
                              ← ── 第一次压缩 ──
compact-boundary { summary: "用户要求读取文件..." }
msg: user [summary] "之前的对话总结..."
msg: assistant "我读取了 a.txt..."
msg: user "继续修改"
                              ← ── 第二次压缩 ──
compact-boundary { summary: "修改了文件..." }
msg: user [summary] "继续修改..."
msg: assistant "好的..."

加载后只得到最后 boundary 之后的 2 条消息。
```

---

## 七、两条路径对比总结

```
                        Proactive（主动）                    Reactive（被动）
  ──────────────────────────────────────────────────────────────────────────
  触发时机              每轮 streamText 之前                  API 返回 "prompt too long"
  触发条件              token > threshold × 0.8              API 调用实际失败
  调用位置              agentLoop 循环顶部                    runTurn catch 块

  Light Compact         ✓ 先尝试                              ✗ 跳过
  Session Summary       ✓ 生成结构化总结                       ✗ 跳过
  compressMessages      ✓ LLM 总结替换                         ✓ LLM 总结替换

  Boundary 标记         带 summary（如果有）                   不带 summary
  重试机制              不需要（还没发请求）                    turn-- + continue
  用户体验              透明（压缩在 API 调用前）              可见延迟（先失败再压缩再重试）

  Hook trigger          'proactive'                           'reactive'
  ──────────────────────────────────────────────────────────────────────────
```

### 7.1 整体流程图

```
agentLoop while 循环顶部
  │
  ├─ flushPendingMessages()          ← 先把上一轮的增量刷盘
  │
  ├─ checkAndCompressContext()       ← PROACTIVE 路径
  │   │
  │   ├─ 不需要压缩? → return
  │   │
  │   ├─ lightCompactMessages()
  │   │   ├─ 有丢掉的 loop-guard 对?
  │   │   │   ├─ 压缩后仍在阈值以下? → markBoundary → return ✓
  │   │   │   └─ 仍超限? → 继续 ↓
  │   │   └─ 没有? → 继续 ↓
  │   │
  │   ├─ generateSessionSummary()    ← 结构化总结（尽力而为）
  │   ├─ compressMessages()          ← LLM 总结替换
  │   ├─ markBoundaryAndReflush()    ← 写 boundary + 重新刷盘
  │   └─ return ✓
  │
  ├─ runTurn()                       ← 发起 API 调用
  │   ├─ streamText({...})
  │   ├─ streamChunksToUI()
  │   │   └─ throw error ("prompt too long")
  │   │
  │   ├─ catch → REACTIVE 路径
  │   │   ├─ handleContextTooLong()
  │   │   │   ├─ compressMessages()  ← 直接 LLM 总结（跳过 light compact）
  │   │   │   ├─ markBoundaryAndReflush()
  │   │   │   └─ return true
  │   │   └─ { kind: 'retry' }       ← 通知 agentLoop 重试
  │   │
  │   └─ collectTurnResponse()       ← 正常完成时收集结果
  │
  ├─ processToolCalls()              ← 处理工具调用
  └─ continue / break
```

---

## 八、Hook 集成

压缩过程通过 `CompactionHookContext` 接口与 Hook 系统集成（`compression.ts:25-30`）：

```typescript
export interface CompactionHookContext {
  hookBus?: HookBus
  modelId: string
  cwd: string
  abortSignal?: AbortSignal
}
```

两个 hook 事件：

| Hook | 时机 | payload |
|------|------|---------|
| `PreCompact` | 压缩开始前 | trigger、messageCount、tokenEstimate |
| `PostCompact` | 压缩完成后 | trigger、messageCount、summary |

Hook 执行策略：
- **fire-and-forget**（异步，不等待结果）
- 压缩是强制的——hook 只能观察（做审计、持久化 checkpoint 等），不能阻止
- hook 失败不向上冒泡（`catch` + `debugLog`）

```typescript
// compression.ts:173-188
function emitCompactionHook(ctx, partial): void {
  if (!ctx?.hookBus?.has(partial.name)) return  // 没人监听就直接跳过
  void ctx.hookBus.emit({...}).catch((err) =>
    debugLog(`agent.hook-${partial.name.toLowerCase()}-error`, String(err))
  )
}
```

---

## 九、关键源文件索引

| 文件 | 行号 | 关键导出 |
|------|------|----------|
| `context-window.ts` | 15 | `COMPRESSION_TRIGGER_RATIO = 0.8` |
| `context-window.ts` | 22 | `CHARS_PER_TOKEN_ESTIMATE = 3.0` |
| `context-window.ts` | 79-84 | `getContextWindow()` — 模型窗口查找 |
| `context-window.ts` | 87-89 | `getCompressionThreshold()` — 阈值计算 |
| `context-window.ts` | 125-137 | `estimateTokenCount()` — 字符级 token 估算 |
| `compression.ts` | 33 | `KEEP_RECENT = 6` |
| `compression.ts` | 38-59 | `compressMessages()` — LLM 总结替换 |
| `compression.ts` | 69-136 | `checkAndCompressContext()` — proactive 路径 |
| `compression.ts` | 143-169 | `handleContextTooLong()` — reactive 路径 |
| `light-compact.ts` | 23 | `LOOP_GUARD_SENTINEL = '[loop-guard]'` |
| `light-compact.ts` | 98-117 | `lightCompactMessages()` — 轻量裁剪 |
| `session-store.ts` | 80-90 | `CompactBoundaryEntry` 类型定义 |
| `session-store.ts` | 166-185 | `flushPendingMessages()` — 增量刷盘 |
| `session-store.ts` | 218-235 | `markBoundaryAndReflush()` — boundary + 重刷 |
| `session-store.ts` | 285-316 | `loadSession()` — 加载（boundary 截断语义） |
| `session.ts` | 23 | `SESSION_SUMMARY_MESSAGE_COUNT = 20` |
| `session.ts` | 29-85 | `generateSessionSummary()` — 结构化总结生成 |
| `loop.ts` | 506-518 | proactive 路径调用点 |
| `loop.ts` | 342-354 | reactive 路径调用点 |
| `loop.ts` | 584-588 | retry 处理（`turn--` + `continue`） |
