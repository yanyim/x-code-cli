// @x-code-cli/core — 上下文窗口压缩
//
// 两条路径共享同一套压缩原语：
//   - 主动（proactive，`checkAndCompressContext`）：每轮流之前运行，
//     当 token 估算值跨过模型阈值时裁剪旧消息。
//   - 被动（reactive，`handleContextTooLong`）：当流式请求真报了
//     "prompt too long" 时触发，压缩后通知调用方重试本轮。
//
// 两条路径都先跑廉价的进程内轻量裁剪（丢掉 loop-guard 配对——不调 LLM），
// 只在不够时才走 compressMessages，发一次 generateText 让 LLM 写总结。
import { generateText } from 'ai'
import type { LanguageModel, ModelMessage } from 'ai'

import type { HookBus } from '../hooks/bus.js'
import { generateSessionSummary } from '../knowledge/session.js'
import type { AgentCallbacks } from '../types/index.js'
import { debugLog } from '../utils.js'
import { estimateTokenCount } from './context-window.js'
import { lightCompactMessages } from './light-compact.js'
import type { LoopState } from './loop-state.js'
import { markBoundaryAndReflush } from './session-store.js'

/** 压缩路径的可选 hook 接口。让插件观察（PreCompact）和响应（PostCompact）
 *  上下文裁剪行为——可用于 checkpoint 持久化或审计。 */
export interface CompactionHookContext {
  hookBus?: HookBus
  modelId: string
  cwd: string
  abortSignal?: AbortSignal
}

/** 压缩时保留最近的消息数量（保持原样不总结）。 */
export const KEEP_RECENT = 6

/** 把旧消息压缩成一段总结。
 *  保留最近 KEEP_RECENT 条消息原样，其余用 LLM 总结替代。
 *  返回 [user(总结文本), ...recent]。 */
export async function compressMessages(messages: ModelMessage[], model: LanguageModel): Promise<ModelMessage[]> {
  // 确保"最近"切片不以孤立的 tool 消息开头——供应商拒绝没有配对
  // assistant tool_calls 的 tool 消息。如果最近 KEEP_RECENT 条的
  // 第一条是 tool 角色，逐条增加保留数直到遇到非 tool 消息。
  let keepCount = KEEP_RECENT
  while (keepCount < messages.length && messages[messages.length - keepCount]?.role === 'tool') {
    keepCount++
  }
  const recent = messages.slice(-keepCount)
  const old = messages.slice(0, -keepCount)

  if (old.length === 0) return messages

  const { text: summary } = await generateText({
    model,
    system:
      'Summarize the following conversation concisely, preserving key decisions, file changes, and context needed to continue.',
    messages: old,
  })

  return [{ role: 'user', content: `[Previous conversation summary]\n${summary}` }, ...recent]
}

/**
 * 主动压缩：当最近一次真实 input token 数或基于字符的估算值跨过阈值时触发。
 *
 * 先跑 O(n) 的轻量裁剪（丢掉 loop-guard 配对——不调 LLM，不发网络请求）。
 * 如果裁剪后回到阈值以下，直接跳过昂贵的 LLM 总结路径。
 * 这是 "$0 + 10ms 的裁剪"和"一次完整的 generateText 往返"之间的关键差异——
 * 对于 loop 诱导的上下文膨胀（最常见的情况），轻量路径就够了。
 */
export async function checkAndCompressContext(
  state: LoopState,
  model: LanguageModel,
  threshold: number,
  callbacks: AgentCallbacks,
  hookCtx?: CompactionHookContext,
): Promise<void> {
  const needsCompression = state.lastInputTokens > threshold || estimateTokenCount(state.messages) > threshold
  if (!needsCompression || state.messages.length <= KEEP_RECENT) return

  // PreCompact hook——在任一压缩路径运行前触发。不等待 hook 决策
  // （一旦跨过阈值压缩就是强制的），所以是 fire-and-forget。
  const messageCountBefore = state.messages.length
  const tokenEstimateBefore = estimateTokenCount(state.messages)
  emitCompactionHook(hookCtx, {
    name: 'PreCompact',
    trigger: 'proactive',
    messageCount: messageCountBefore,
    tokenEstimate: tokenEstimateBefore,
  })

  const light = lightCompactMessages(state.messages)
  if (light.dropped > 0) {
    state.messages = light.messages
    const stillOver = estimateTokenCount(state.messages) > threshold
    callbacks.onContextCompressed(
      `Dropped ${light.dropped} looped tool-call message(s) to reclaim context${stillOver ? ' — still over threshold, summarising' : ''}.`,
    )
    if (!stillOver) {
      // 轻量裁剪成功——写一条 boundary 行，这样恢复时不会把已丢弃的
      // loop-guard 配对从磁盘 resurrect 回来（它们仍在 boundary 之前的
      // 磁盘数据中，但加载器在最后一个 boundary 处截断）。
      // boundary 不带总结文本，因为没有做总结。
      void markBoundaryAndReflush(state)
      emitCompactionHook(hookCtx, {
        name: 'PostCompact',
        trigger: 'proactive',
        messageCount: state.messages.length,
        summary: '',
      })
      return
    }
  }

  let summaryText = ''
  try {
    const summary = await generateSessionSummary(state.messages, model, state.sessionId, state.startedAt, [
      ...state.filesModified,
    ])
    summaryText = summary.summary
  } catch {
    // 总结生成失败——继续执行，使用空文本。下面的 compressMessages 仍然
    // 会跑自己的 LLM 总结，所以上下文仍会缩小；只是丢失了会骑在 boundary
    // 行上的结构化总结（用于 picker UX）。
  }
  state.messages = await compressMessages(state.messages, model)
  state.lastInputTokens = 0
  // 写一条 compact-boundary 行 + 重新刷盘裁剪后的消息，确保
  // boundary 之后的 jsonl 内容等于新的内存状态。
  void markBoundaryAndReflush(state, summaryText)
  callbacks.onContextCompressed('Context compressed to fit context window.')
  emitCompactionHook(hookCtx, {
    name: 'PostCompact',
    trigger: 'proactive',
    messageCount: state.messages.length,
    summary: summaryText,
  })
}

/**
 * 被动压缩：当流式请求因为 "prompt too long" 而报错时触发。
 * 压缩后返回 true，通知调用方重试本轮。
 * 和 Claude Code 的 reactiveCompact 逻辑一致。
 */
export async function handleContextTooLong(
  state: LoopState,
  model: LanguageModel,
  callbacks: AgentCallbacks,
  hookCtx?: CompactionHookContext,
): Promise<boolean> {
  if (state.messages.length <= KEEP_RECENT) return false
  emitCompactionHook(hookCtx, {
    name: 'PreCompact',
    trigger: 'reactive',
    messageCount: state.messages.length,
    tokenEstimate: estimateTokenCount(state.messages),
  })
  state.messages = await compressMessages(state.messages, model)
  state.lastInputTokens = 0
  // 与主动路径相同的 boundary 纪律——被动压缩也原地改写 state.messages，
  // 所以 jsonl 需要 compact-boundary 标记来保持加载器语义一致。
  void markBoundaryAndReflush(state)
  callbacks.onContextCompressed('Context too long — automatically compressed. Retrying...')
  emitCompactionHook(hookCtx, {
    name: 'PostCompact',
    trigger: 'reactive',
    messageCount: state.messages.length,
    summary: '',
  })
  return true
}

/** 发射 PreCompact / PostCompact hook。尽力而为——压缩已经发生（或即将发生），
 *  hook 失败和中止不能向上冒泡。 */
function emitCompactionHook(
  ctx: CompactionHookContext | undefined,
  partial:
    | { name: 'PreCompact'; trigger: 'proactive' | 'reactive'; messageCount: number; tokenEstimate: number }
    | { name: 'PostCompact'; trigger: 'proactive' | 'reactive'; messageCount: number; summary: string },
): void {
  if (!ctx?.hookBus?.has(partial.name)) return
  void ctx.hookBus
    .emit(
      {
        ...partial,
        session: { cwd: ctx.cwd, modelId: ctx.modelId },
      },
      { signal: ctx.abortSignal },
    )
    .catch((err) => debugLog(`agent.hook-${partial.name.toLowerCase()}-error`, String(err)))
}
