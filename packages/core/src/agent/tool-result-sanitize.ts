// @x-code-cli/core — 工具结果截断 + 孤儿 tool_call/tool_result 修复
//
// AI SDK 自动执行的工具（readFile / grep / glob / listDir / webFetch / webSearch）
// 的结果通过 `response.messages` 中的 tool-result parts 返回。手动执行路径
// （tool-execution.ts）会跑 `truncateToolResult`，但自动执行的结果绕过了那条路径，
// 以原始大小进入 `state.messages`。本模块在流完成后遍历响应消息，在持久化前
// 原地应用相同的按工具截断策略。
//
// 按工具的截断策略：
//   - shell / edit / writeFile：手动路径已经截断过
//   - readFile：head-tail（保留文件头 + 文件尾）
//   - grep / glob / listDir：head-only（词法有序，头部代表性足够）
//   - webFetch：head-tail（页面通常首尾有导航噪音，但尾部保留最终锚点仍有价值）
//   - 默认：head-tail
import type { ModelMessage } from 'ai'

import { truncateToolResult } from '../tools/truncate.js'
import type { TruncateOptions } from '../tools/truncate.js'

const PER_TOOL_POLICY: Record<string, TruncateOptions> = {
  readFile: { direction: 'head-tail' },
  grep: { direction: 'head', maxLines: 500 },
  glob: { direction: 'head', maxLines: 500 },
  listDir: { direction: 'head', maxLines: 500 },
  webFetch: { direction: 'head-tail' },
  webSearch: { direction: 'head-tail' },
  shell: { direction: 'head' },
}

/** 根据工具名获取截断策略。未注册的工具名使用默认 head-tail 策略。 */
function policyFor(toolName: string | undefined): TruncateOptions {
  if (!toolName) return { direction: 'head-tail' }
  return PER_TOOL_POLICY[toolName] ?? { direction: 'head-tail' }
}

/** AI SDK tool-result parts 在传输中的大致类型。
 *  只改写我们已知的子集，其余保持不动。 */
type ToolResultLike = {
  type: 'tool-result'
  toolName?: string
  output?: {
    type?: 'text' | 'content' | string
    value?: unknown
  }
}

/**
 * 遍历 messages 并双向修复 tool_call ↔ tool_result 的配对关系。
 *
 * 供应商严格要求：
 *   - 每个 assistant tool_call 都必须有配对的 tool_result
 *   - 每个 tool_result 之前必须有包含相同 toolCallId 的 assistant tool_call
 * 任一方向的孤儿都会导致下一次 API 请求 400："tool must be a response to
 * a preceding message with tool_calls"（或反向错误）。
 *
 * 孤儿的产生方式：
 *   - 正向（tool_call 无 tool_result）：模型偶尔输出格式错误的 tool input
 *     （如 todoWrite 缺少必填字段），SDK 验证失败后发出 tool-error 事件，
 *     某些情况下不推送配对的 tool-result 到 response.messages。
 *     我们为这些孤儿合成错误结果。
 *   - 反向（tool_result 无 tool_call）：SDK 因 tool input 验证失败发出
 *     tool-error 时，可能把 tool_call 从 response.messages 中剔除——但
 *     processToolCalls 仍会消费 result.toolCalls promise 并执行工具，
 *     把 tool_result 推入 state.messages。我们删除这些孤儿。
 *
 * 原地修改 messages。幂等（跑两次等于什么都没做）。
 */
export function repairOrphanToolCalls(messages: ModelMessage[]): void {
  // 第一步：收集所有 assistant 消息中出现的 tool_call_id。
  const expected = new Set<string>()
  const toolNameById = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string; toolCallId?: string; toolName?: string }>) {
      if (part?.type === 'tool-call' && typeof part.toolCallId === 'string') {
        expected.add(part.toolCallId)
        if (typeof part.toolName === 'string') toolNameById.set(part.toolCallId, part.toolName)
      }
    }
  }

  // 删除 tool_result 中 toolCallId 从未出现在 assistant tool_call 中的部分（反向孤儿）。
  // 如果 tool 消息的所有 parts 都是孤儿，删除整条消息；
  // 如果只有部分是孤儿，就地过滤掉这些 parts。
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg || msg.role !== 'tool') continue
    if (!Array.isArray(msg.content)) continue
    const parts = msg.content as Array<{ type?: string; toolCallId?: string }>
    const kept = parts.filter((part) => {
      if (part?.type !== 'tool-result') return true
      if (typeof part.toolCallId !== 'string') return true
      return expected.has(part.toolCallId)
    })
    if (kept.length === 0) {
      // splice 删除整条 tool 消息可能导致 assistant → assistant 相邻
      // （常见形态是 assistant tool_calls → tool results → assistant 续写）。
      // Anthropic 严格要求 user/assistant 交替，虽然 @ai-sdk/anthropic 转换器
      // 目前会自动合并连续同角色消息，但我们的正确性不应依赖下游 SDK 行为。
      // 当两侧都是 assistant 时，用 user 文本占位符替代，保持边界。
      // 否则（一侧或两侧是 user/tool/不存在），直接删除是安全的。
      const prev = messages[i - 1]
      const next = messages[i + 1]
      if (prev?.role === 'assistant' && next?.role === 'assistant') {
        messages[i] = {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '[Stale tool result discarded — no matching tool_call in history.]',
            },
          ],
        } as ModelMessage
      } else {
        messages.splice(i, 1)
      }
    } else if (kept.length !== parts.length) {
      // AI SDK 的严格联合类型在类型层面禁止我们操作的 partial part 形状——
      // 但上面已在运行时确认过类型，所以结构化类型断言是安全的。
      ;(msg as { content: unknown }).content = kept
    }
  }

  // 第三步：收集所有已有 tool_result 配对的 tool_call_id（反向孤儿清除后）。
  const fulfilled = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'tool') continue
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string; toolCallId?: string }>) {
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') {
        fulfilled.add(part.toolCallId)
      }
    }
  }

  // 第四步：为正向孤儿追加合成的错误结果，保持整体排序。
  // 正向孤儿总是放在末尾——它们从来没有真实结果，所以位置纯粹是
  // 下一次 API 请求的占位符。把所有孤儿 parts 收集到一个 tool 消息中，
  // 而不是每个 ID 推一条：AI SDK 的 Anthropic 转换器目前会合并连续
  // 同角色消息，但 Google 转换器不会，OpenAI-compat 会按 tool_call_id
  // 拆分——输出单条 tool ModelMessage 对拆分器等价，对不合并的供应商更安全。
  const orphanParts: Array<{
    type: 'tool-result'
    toolCallId: string
    toolName: string
    output: { type: 'text'; value: string }
  }> = []
  for (const id of expected) {
    if (fulfilled.has(id)) continue
    const name = toolNameById.get(id) ?? 'unknown'
    orphanParts.push({
      type: 'tool-result',
      toolCallId: id,
      toolName: name,
      output: {
        type: 'text',
        value:
          'Error: Tool input failed validation (likely missing required fields). The assistant should retry with the correct schema.',
      },
    })
  }
  if (orphanParts.length > 0) {
    // 纵深防御：如果其他代码路径已经留下了一条尾部 tool 消息
    //（如 processToolCalls 推送了我们在上面没动的真实结果），
    // 把孤儿 parts 合并进去，而不是输出第二条相邻的 tool ModelMessage。
    const tail = messages[messages.length - 1]
    if (tail && tail.role === 'tool' && Array.isArray(tail.content)) {
      ;(tail.content as unknown[]).push(...(orphanParts as unknown[]))
    } else {
      messages.push({
        role: 'tool',
        content: orphanParts as never,
      } as ModelMessage)
    }
  }
}

/**
 * 原地遍历 messages 并截断超大的 tool-result parts。
 * 只改写 output.value 字段，消息结构的其余部分完全保留供应商返回的原样。
 */
export function truncateToolResultsInMessages(messages: ModelMessage[]): void {
  for (const msg of messages) {
    if (msg.role !== 'tool') continue
    if (!Array.isArray(msg.content)) continue

    for (const part of msg.content as unknown as ToolResultLike[]) {
      if (part?.type !== 'tool-result') continue
      const output = part.output
      if (!output) continue

      // 文本输出：`{ type: 'text', value: string }`
      if (output.type === 'text' && typeof output.value === 'string') {
        const truncated = truncateToolResult(output.value, policyFor(part.toolName))
        if (truncated.length !== output.value.length) {
          output.value = truncated
        }
        continue
      }

      // 内容输出：`{ type: 'content', value: Array<{ type: string, text?: string, ... }> }`
      // 只有 text 条目是可变的——image-data / file-data / file-url 是二进制载荷，
      // 由 provider-compat 层在其他地方处理。
      if (output.type === 'content' && Array.isArray(output.value)) {
        const entries = output.value as Array<{ type?: string; text?: string }>
        for (const entry of entries) {
          if (entry?.type === 'text' && typeof entry.text === 'string') {
            const truncated = truncateToolResult(entry.text, policyFor(part.toolName))
            if (truncated.length !== entry.text.length) {
              entry.text = truncated
            }
          }
        }
      }
    }
  }
}
