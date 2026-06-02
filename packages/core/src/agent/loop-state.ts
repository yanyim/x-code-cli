// @x-code-cli/core — Agent Loop 共享状态容器
//
// LoopState 是 agent loop 跨轮、跨提交复用的状态对象。同一 CLI 会话内，
// UI 层（use-agent.ts）持有 loopStateRef，每次用户提交都把上次的 state 传回。
// 多数字段是瞬时元数据（token 计数、loop-guard 窗口），不持久化到磁盘；
// 跨会话延续依赖 jsonl transcript 的重放。
import type { ModelMessage } from 'ai'

import type { PermissionMode, TodoItem, TokenUsage } from '../types/index.js'

export interface LoopState {
  messages: ModelMessage[]
  tokenUsage: TokenUsage
  /** 最近一次 API 响应的真实 input token 数。
   *  用于驱动主动压缩（proactive compression）：checkAndCompressContext
   *  每轮流前拿这个值和模型上下文阈值比较，超过就触发压缩。
   *  reactive 压缩后会重置为 0，让下一轮重新累积。 */
  lastInputTokens: number
  sessionId: string
  startedAt: string
  filesModified: Set<string>
  /** 最近执行的工具调用滚动记录，以「工具名 + 稳定序列化输入」的哈希为键。
   *  doom-loop guard（循环保护）用它检测模型是否在反复调用同一个失败的工具。
   *  哈希只比较工具名 + 输入参数，不比较 toolCallId——同一参数的不同调用
   *  在循环保护看来是"重复"。详见 loop-guard.ts。 */
  recentToolCalls: Array<{ toolName: string; hash: string }>
  /** 缓存的系统提示词文本——整个会话只构建一次，保证前缀字节级稳定。
   *
   *  字节级稳定是 OpenAI 兼容供应商（DeepSeek / Moonshot / Alibaba / 智谱 / xAI）
   *  自动前缀缓存的前提：前缀在请求之间只要变了一个字节，缓存全部失效。
   *  所以不能在系统提示词里拼"当前时间"、"本轮 token 数"等每轮不同的信息。
   *
   *  唯一的刷新触发点是 permissionMode 切换：plan-tools.ts 在进入/退出
   *  plan mode 时把它置 null，下一轮 runTurn 会重建带/不带 plan-mode 叠加层
   *  的系统提示词。非切换情况下永远复用同一份字符串。 */
  systemPromptCache: string | null
  /** 当前权限模式——通过 /plan 斜杠命令（用户）或 enterPlanMode/exitPlanMode 工具（模型）切换。
   *  tool-execution 根据它决定是否应用 plan-mode 叠加层、哪些工具可见。
   *  不持久化到磁盘——下次启动按 --plan 或用户配置重置。 */
  permissionMode: PermissionMode
  /** plan mode 下的 plan 文件路径（`.x-code/plans/{sessionId}.md`），非 plan mode 时为 null。
   *  惰性创建——模型第一次调用 enterPlanMode 时才生成，之后同一 plan-mode 会话内复用。
   *  退出 plan mode 时清空。 */
  currentPlanPath: string | null
  /** 从用户首条消息派生的小写连字符短标识，用于给会话文件起人类可读的名称。
   *  纯英文输入走本地 slugify（0 次 LLM 调用）；中日韩 / emoji / 太短的输入
   *  会发一次孤立的 generateText 拿 2-4 个英文词。
   *
   *  只设一次，永不更新——中途改了会让本会话的 jsonl / plan 文件名错位，
   *  留下孤儿文件。首次消息无 ASCII 内容时为空串，文件名退回纯时间戳。 */
  taskSlug: string
  /** 模型通过 todoWrite 工具维护的待办清单。
   *  全量替换语义——每次 todoWrite 调用重写整个数组，不做增量合并。
   *  纯内存态，不持久化到磁盘。所有项都完成时自动清空为 []。
   *  /clear 和 /resume 会重建 LoopState（清空为 []）；
   *  /compact 保留——让多步骤任务在历史总结后仍能看到进度。 */
  todos: TodoItem[]
  /** 已持久化到会话 jsonl 文件的消息数量（游标）。
   *  agent loop 在轮次边界调 flushPendingMessages，用
   *  state.messages.slice(persistedMessageCount) 做增量追加，然后推高游标。
   *
   *  压缩（轻量或深度）会原地改写 messages 数组，此时游标重置为
   *  state.messages.length——改写后的消息通过 compact-boundary 行重新刷盘，
   *  恢复时加载器按"最后一个 boundary 之后的内容为准"的规则重建内存状态。
   *  详见 agent/session-store.ts。 */
  persistedMessageCount: number

  // ── 子 agent 支持（agentLoop 中设置一次，tool-execution 读取）──

  /** 缓存的知识上下文，用于子 agent 的系统提示词。
   *  在 agentLoop 中 buildKnowledgeContext 解析后设置一次；
   *  子 agent 循环直接读取，不再单独调用 buildKnowledgeContext。 */
  knowledgeContext?: string
  /** 当前工作目录是否为 git 仓库。一次性探测后缓存，用于子 agent 系统提示词。 */
  isGitRepo?: boolean
}

/** 生成人类可读的会话 ID：`YYYYMMDD-HHMMSS-mmm`（本地时间，毫秒尾部保证唯一）。
 *
 *  取代了旧的 `Date.now().toString(36)`（如 `mohbm95d`），那种格式在
 *  `ls .x-code/sessions/` 里完全不可读。时间戳格式与 plan 文件命名一致，
 *  两个目录的文件列表排序和扫描方式统一。 */
function generateSessionId(now: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    `-${pad(now.getMilliseconds(), 3)}`
  )
}

export function createLoopState(initialMode: PermissionMode = 'default'): LoopState {
  return {
    messages: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      currentContextTokens: 0,
    },
    lastInputTokens: 0,
    sessionId: generateSessionId(),
    startedAt: new Date().toISOString(),
    filesModified: new Set(),
    recentToolCalls: [],
    systemPromptCache: null,
    permissionMode: initialMode,
    // plan 路径在用户首条消息到达后才惰性派生（在 agentLoop / enterPlanMode 中完成）。
    // 此处无法 slugify——用户的意图在构造 LoopState 时还不可见。
    currentPlanPath: null,
    taskSlug: '',
    todos: [],
    persistedMessageCount: 0,
  }
}
