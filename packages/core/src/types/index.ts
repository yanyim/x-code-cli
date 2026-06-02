// @x-code-cli/core — 公共类型定义
import type { LanguageModel, ModelMessage } from 'ai'

import type { EditDiffPayload } from '../agent/diff.js'
import type { SubAgentRegistry } from '../agent/sub-agents/registry.js'
import type { SubAgentEvent } from '../agent/sub-agents/types.js'
import type { CommandRegistry } from '../commands/registry.js'
import type { HookBus } from '../hooks/bus.js'
import type { McpPermissionStore } from '../mcp/permissions.js'
import type { McpRegistry } from '../mcp/registry.js'
import type { PluginRegistry } from '../plugins/registry.js'
import type { SkillRegistry } from '../skills/registry.js'

// ─── 权限 ───

export type PermissionLevel = 'always-allow' | 'ask' | 'deny'

/** 当前会话的审批模式。
 *
 *    'default'      — 默认流程：写入类工具需要确认，模型可以调用任何工具。
 *    'plan'         — 计划模式（只读）：通过系统提示覆盖层指示模型进行探索并
 *                     将计划写入会话专属的计划文件，但不进行任何其他编辑。
 *                     执行方式基于提示——与 Claude Code 保持一致，没有硬性的
 *                     权限层拦截——因此不配合的模型仍然会触发 write/edit/shell
 *                     的常规 `ask` 确认提示。
 *    'acceptEdits'  — 写入类工具（writeFile / edit）自动批准，无需逐一确认；
 *                     shell 命令仍按正常分类处理（always-allow / ask / deny），
 *                     破坏性命令仍然受限。适用于计划审批后立即执行的场景——用户
 *                     已经审查过计划内容，在实现阶段对每个 writeFile 点击"是"
 *                     纯属多余的摩擦。exitPlanMode 在计划被批准时会自动切换到
 *                     此模式。 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan'

// ─── 待办列表（TodoWrite 工具）───

/** 模型工作清单中的单条待办事项。
 *
 *    content    — 任务的祈使句表述（如"更新认证处理器"）
 *    activeForm — 进行时态表述，用于实时状态指示器
 *                 （如"正在更新认证处理器"）；当状态为 'in_progress' 时
 *                 在 UI 中显示，让用户了解代理当前正在做什么。
 *    status     — 'pending'（待处理）| 'in_progress'（进行中）| 'completed'（已完成）。
 *
 *  完整镜像 Claude Code 的 TodoWrite 负载结构。仅在内存中持久化
 *  （LoopState.todos），按会话隔离，不写入磁盘。 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  activeForm: string
  status: TodoStatus
}

// ─── Token 用量 ───

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** 已读取的缓存提示 token 数（Anthropic 的 cache_read、OpenAI 的 cached_tokens 等）。
   *  计费费率为正常输入费率的一小部分——具体比例取决于提供商。
   *  已包含在 `inputTokens` 中；此字段仅供参考。 */
  cacheReadTokens: number
  /** 写入提供商侧缓存的 token 数（Anthropic 的 cache_creation_input_tokens）。
   *  计费高于正常输入费率，但可在后续轮次解锁廉价的缓存读取。
   *  对于不区分缓存创建与读取的提供商，此值为零。 */
  cacheCreationTokens: number
  /** 当前上下文窗口占用量——最近一次 API 响应的 `input_tokens + output_tokens`
   *  （自 AI SDK v6 将 cache_read 和 cache_write 统一归入 `inputTokens` 以来，
   *  该字段已包含这两部分）。与上述累积字段不同，这是一个快照——每轮覆盖，
   *  非累加。驱动底部状态栏的 "N / M · X%" 指示器。
   *
   *  为什么是 input + output（匹配所有提供商的定义）：
   *  所有主流 LLM API——Anthropic、OpenAI、Google Gemini、DeepSeek、Moonshot、
   *  Alibaba、xAI——都将"上下文窗口"定义为 input + output 的共享预算池，约束
   *  条件为 `input + output ≤ context_window`（单一 KV-cache 容量上限）。如果
   *  底部状态栏只显示 input，数字将与用户查阅提供商文档时看到的上下文窗口定义
   *  不一致。上方的累积字段则继续用于 `/usage` 计费统计。 */
  currentContextTokens: number
}

// ─── 显示消息 ───

export interface DisplayMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: DisplayToolCall[]
  timestamp: number
  /** 为 true 时表示流式传输过程中发出的助手文本片段（每个换行一个）。
   *  渲染时不附加常规消息的尾部空行，因此连续片段在视觉上合并为同一段落。
   *  通过将每条完整行直接发送到回滚缓冲区，避免流式文本进入底部单元格缓冲区
   *  （防止行移位抖动）。 */
  streamingChunk?: boolean
  /** 紧凑的斜杠命令渲染方式，匹配 Claude Code 的两行块格式：
   *    > /model
   *      ⎿  已将模型设置为 Sonnet 4.6
   *  'command-echo'（用户角色）省略常规用户消息附加的尾部空行；
   *  'command-result'（助手角色）使用 ⎿ 前缀和单个换行符渲染，而非
   *  markdown + \n\n。仅用于简短的单行命令响应。多行长输出（如
   *  /help、/usage）仍然走常规的助手消息渲染路径。 */
  kind?: 'command-echo' | 'command-result'
}

export interface DisplayToolCall {
  id: string
  toolName: string
  input: Record<string, unknown>
  output?: string
  /** `error` 表示工具执行完毕但退出码非零或抛出了异常——标准输出写入器
   *  会将其结果体渲染为红色，使失败在回滚区域中醒目可见。`denied` 保留
   *  用于权限拒绝路径。 */
  status: 'pending' | 'running' | 'completed' | 'denied' | 'error'
  /** 工具调用的执行耗时（毫秒） */
  durationMs?: number
  /** 由 writeFile / edit 生成的结构化补丁——驱动回滚区域中工具标记下方的
   *  彩色差异块。以下情况下不存在：非编辑工具、从历史记录恢复的条目（会话
   *  恢复时不重新计算）、以及实际未产生变更的编辑（oldContent === newContent）。 */
  editPayload?: EditDiffPayload
}

// ─── 代理回调（core → UI 桥接）───

export interface AgentCallbacks {
  onTextDelta: (text: string) => void
  onToolCall: (toolCallId: string, toolName: string, input: Record<string, unknown>) => void
  /** 工具运行时发出的流式进度消息（如"搜索中: query" → "找到 5 个结果"）。
   *  实时 UI 中仅显示最新的一条消息；最终摘要通过 onToolResult 传出。 */
  onToolProgress: (toolCallId: string, message: string) => void
  onToolResult: (toolCallId: string, result: string, isError?: boolean) => void
  /** 可选。在成功的 writeFile / edit 的 `onToolResult` 触发之前立即触发，
   *  携带结构化补丁和行数统计，使 UI 可以在工具标记下方渲染差异块。
   *  权限被拒绝或出错的写入（文件实际未被修改）以及产生相同文件内容的
   *  无效编辑会跳过此回调。 */
  onFileEdit?: (toolCallId: string, payload: EditDiffPayload) => void
  onAskPermission: (toolCall: {
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
  }) => Promise<'yes' | 'always' | 'no'>
  onAskUser: (question: string, options: { label: string; description: string }[]) => Promise<string>
  /** 由 `exitPlanMode` 触发。resolve `true` 退出计划模式并让模型开始执行；
   *  resolve `false` 拒绝计划并让模型继续在计划模式下迭代。 */
  onPlanApprovalRequest: (planText: string) => Promise<boolean>
  /** 每当 permissionMode 切换时触发，使 UI 重新同步底部指示器，并
   *  （在需要持久化时）将新值写入用户配置。 */
  onPlanModeChange: (mode: PermissionMode) => void
  /** 模型调用 `todoWrite` 后触发，使 UI 可以展示当前待办清单。
   *  每次调用都传入完整列表（todoWrite 是全量替换工具，非增量）——
   *  UI 只需直接存储。 */
  onTodosUpdate: (todos: TodoItem[]) => void
  onShellOutput: (chunk: string) => void
  onUsageUpdate: (usage: TokenUsage) => void
  onContextCompressed: (summary: string) => void
  onError: (error: Error) => void
  /** 由子代理运行器触发，用于流式传输子代理循环的进度。
   *  CLI UI 使用这些事件构建折叠/展开的任务块。 */
  onSubAgentEvent?: (event: SubAgentEvent) => void
  /** 可选。由轮次结束后的记忆提取器触发，每提交一条事实到 AutoMemory
   *  时调用一次。在回滚区域显示"已记住: …"提示，让用户了解静默提取器
   *  保存了什么内容。提取器是即发即弃的（在 agentLoop 返回后运行），因此
   *  此回调可能在 `submit()` resolve 之后、甚至进入下一轮之后才触发——请确保
   *  闭包中不包含轮次级状态。 */
  onMemoryWrite?: (notice: MemoryWriteNotice) => void
}

// ─── 代理选项 ───

export interface AgentOptions {
  modelId: string
  trustMode: boolean
  /** 单次 `agentLoop` 调用内的最大迭代次数上限。省略时循环无轮次上限——
   *  用户的 Esc / Ctrl+C 是唯一的停止方式。子代理和 `--print` 模式是
   *  两个实际传入此值的调用方；交互式会话保持不设置。 */
  maxTurns?: number
  printMode: boolean
  /** 为 true 时，代理循环启用各提供商支持的最大推理能力
   *  （映射关系见 providers/thinking.ts）。以 `thinking: boolean` 形式
   *  持久化在 `~/.x-code/config.json` 中，运行时通过 `/thinking on|off`
   *  切换。默认为 false。 */
  thinking?: boolean
  /** 会话的初始权限模式。默认为 'default'。
   *  由 `--plan` CLI 标志或 `loadUserConfig().permissionMode` 设置。 */
  permissionMode?: PermissionMode
  systemPromptExtra?: string
  abortSignal?: AbortSignal

  // ── 子代理支持 ──

  /** 用于解析子代理模型覆盖的提供商注册表。由 CLI 在启动时注入。
   *  省略时子代理继承父级模型（无独立模型选择）。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  modelRegistry?: { languageModel: (...args: any[]) => LanguageModel }
  /** 子代理注册表。由 CLI 在启动时注入，扫描内置和自定义代理定义后构建。
   *  省略时 task 工具不会注册（无子代理支持）。 */
  subAgentRegistry?: SubAgentRegistry
  /** 工具允许/拒绝过滤器。由子代理循环使用，限制子代理可调用的工具。
   *  `task` 始终在 `deny` 列表中（禁止递归）。 */
  toolFilter?: { allow?: string[]; deny?: string[] }

  // ── 技能支持 ──

  /** 技能注册表，由 CLI 启动时的 createSkillRegistry 填充。
   *  省略表示未配置任何技能——activateSkill 工具不会注册，系统提示中
   *  也不会包含 `## Available Skills` 部分。 */
  skillRegistry?: SkillRegistry

  // ── MCP 支持 ──

  /** MCP 注册表，由 CLI 启动时的 loadMcpServers 填充。省略表示 MCP
   *  完全禁用（未配置任何服务器）——代理循环会短路跳过所有 MCP 相关逻辑。
   *  注册表在会话生命周期内不可变；`/mcp refresh` 会在下一次 agentLoop
   *  入口处替换整个对象。 */
  mcpRegistry?: McpRegistry
  /** MCP 工具调用的权限存储。每个 CLI 进程创建一次，缓存持久化的始终允许
   *  列表和会话级别的允许规则。省略时工具执行回退为每次询问语义。 */
  mcpPermissionStore?: McpPermissionStore

  // ── 插件支持 ──

  /** 插件注册表，由 CLI 启动时的 loadAllPlugins 填充。包含所有成功加载的
   *  插件（已启用 + 已禁用），暴露给 `/plugin ...` 斜杠命令族以便列出、
   *  检查和切换，而无需重新扫描缓存。插件的贡献（技能/代理/MCP）已由
   *  CLI 启动流程合并到各自的注册表中——此字段仅是斜杠命令 UI 的元数据
   *  接口。省略表示插件已禁用（`--no-plugins`）或未安装任何插件。 */
  pluginRegistry?: PluginRegistry

  /** 由已启用插件的 `hooks` 贡献构建的钩子总线。代理循环通过它发射
   *  SessionStart / UserPromptSubmit / TurnComplete / SessionEnd 事件；
   *  工具执行层额外发射 PreToolUse / PostToolUse。省略时不发射任何
   *  钩子（代理循环完全跳过发射站点）。在测试和子代理中使用
   *  `emptyHookBus()` 以允许调用发射站点但无实际监听器。 */
  hookBus?: HookBus

  /** 基于文件的斜杠命令注册表，从插件贡献的 `commands/` 目录构建。
   *  App.tsx 的默认斜杠分发器在内置命令列表和技能注册表之后检查此注册表；
   *  匹配到名称后展开命令体（替换 $ARGUMENTS / ${CLAUDE_PLUGIN_ROOT}）
   *  并作为模型提示提交。省略时无插件命令可用。 */
  commandRegistry?: CommandRegistry
}

// ─── 知识库 ───

/**
 * 自动记忆条目的分类体系。分类描述的是知识的"类型"（关于谁、如何习得的），
 * 而非主题——这与 Claude Code 使用的分类体系保持一致，能产生更精确的记忆，
 * 因为每个类别对代理有不同的触发条件。
 *
 * - user:      关于人类用户的事实——角色、专业领域、目标、约束条件
 * - feedback:  纠正或经过验证的方法（"不要 mock 数据库"、"是的，那个是对的"）
 * - project:   进行中的工作、举措、决策、非显而易见的项目状态
 * - reference: 指向外部系统的引用（Linear 项目、Grafana 面板等）
 */
export type KnowledgeCategory = 'user' | 'feedback' | 'project' | 'reference'

export interface KnowledgeFact {
  key: string
  fact: string
  category: KnowledgeCategory
  date: string
}

/** 由轮次结束后的记忆提取器在提交事实到 AutoMemory 时发射的界面事件。
 *  使 UI 可以在回滚区域渲染"已记住: …"提示行，让用户了解本应是静默
 *  操作的写入内容。 */
export interface MemoryWriteNotice {
  scope: 'project' | 'user'
  category: KnowledgeCategory
  key: string
  fact: string
}

export interface SessionSummary {
  id: string
  title: string
  startedAt: string
  endedAt: string
  status: 'completed' | 'in_progress' | 'abandoned'
  summary: string
  keyResults: string[]
  pendingWork: string[]
  filesModified: string[]
  decisions: string[]
}

// ─── 模型别名 ───

export const MODEL_ALIASES: Record<string, string> = {
  sonnet: 'anthropic:claude-sonnet-4-6',
  opus: 'anthropic:claude-opus-4-7',
  haiku: 'anthropic:claude-haiku-4-5',
  gpt4: 'openai:gpt-4.1',
  gemini: 'google:gemini-2.5-pro',
  deepseek: 'deepseek:deepseek-v4-flash',
  'deepseek-pro': 'deepseek:deepseek-v4-pro',
  qwen: 'alibaba:qwen-max',
  glm: 'zhipu:glm-4-plus',
  kimi: 'moonshotai:kimi-k2.5',
}

// ─── 提供商检测顺序（用于智能默认值）───

export const PROVIDER_DETECTION_ORDER = [
  { envKey: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek:deepseek-v4-flash' },
  { envKey: 'ANTHROPIC_API_KEY', defaultModel: 'anthropic:claude-sonnet-4-6' },
  { envKey: 'OPENAI_API_KEY', defaultModel: 'openai:gpt-4.1' },
  { envKey: 'ALIBABA_API_KEY', defaultModel: 'alibaba:qwen-max' },
  { envKey: 'GOOGLE_GENERATIVE_AI_API_KEY', defaultModel: 'google:gemini-2.5-pro' },
  { envKey: 'XAI_API_KEY', defaultModel: 'xai:grok-3' },
  { envKey: 'ZHIPU_API_KEY', defaultModel: 'zhipu:glm-4-plus' },
  { envKey: 'MOONSHOT_API_KEY', defaultModel: 'moonshotai:kimi-k2.5' },
  { envKey: 'XF_API_KEY', defaultModel: 'xunfei:astron-code-latest' },
] as const

// ─── 各提供商精选模型目录（用于交互式 /model 选择器）───

export interface ProviderModel {
  /** 传递给 AI SDK 的完整 `<provider>:<model>` 标识符 */
  id: string
  /** 在选择器中显示的简短标签 */
  label: string
  /** 显示在标签下方的单行描述 */
  description: string
}

/**
 * 各提供商的人工精选模型列表。仅包含经过测试或标榜为生产稳定的模型——
 * 代理倾向于选择可见的模型，因此我们不在此列出每个实验性变体。
 * 需要使用小众模型的用户仍可通过 `/model <provider>:<model>` 输入
 * 完整标识符或通过 `--model` 参数传递。
 */
export const PROVIDER_MODELS: Record<string, readonly ProviderModel[]> = {
  anthropic: [
    {
      id: 'anthropic:claude-sonnet-4-6',
      label: 'Sonnet 4.6',
      description: 'Balanced default — good for coding + reasoning, 1M context',
    },
    {
      id: 'anthropic:claude-opus-4-7',
      label: 'Opus 4.7',
      description: 'Most capable, strongest at agentic coding, 1M context',
    },
    { id: 'anthropic:claude-haiku-4-5', label: 'Haiku 4.5', description: 'Fastest, cheapest — shorter replies' },
  ],
  openai: [
    { id: 'openai:gpt-4.1', label: 'GPT-4.1', description: 'General-purpose, 1M context window' },
    { id: 'openai:gpt-4.1-mini', label: 'GPT-4.1 Mini', description: 'Cheaper tier of 4.1, 1M context' },
    { id: 'openai:o3', label: 'o3', description: 'Reasoning model — slower, stronger on hard problems' },
    { id: 'openai:o4-mini', label: 'o4-mini', description: 'Smaller reasoning model' },
  ],
  deepseek: [
    {
      id: 'deepseek:deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      description: 'Fast, efficient general-purpose, 1M context',
    },
    {
      id: 'deepseek:deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      description: 'Flagship, stronger reasoning, 1M context',
    },
  ],
  alibaba: [
    { id: 'alibaba:qwen-max', label: 'Qwen Max', description: 'Strongest general Qwen, 128k context' },
    { id: 'alibaba:qwen-plus', label: 'Qwen Plus', description: 'Balanced cost/quality' },
    { id: 'alibaba:qwen-turbo', label: 'Qwen Turbo', description: 'Cheapest, fast' },
    { id: 'alibaba:qwen3-max', label: 'Qwen3 Max', description: 'Latest flagship' },
    { id: 'alibaba:qwen3-coder-plus', label: 'Qwen3 Coder Plus', description: 'Tuned for coding tasks' },
    { id: 'alibaba:qwq-plus', label: 'QwQ Plus', description: 'Reasoning model' },
  ],
  google: [
    { id: 'google:gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: '1M context, strong long-doc handling' },
    { id: 'google:gemini-2.5-flash', label: 'Gemini 2.5 Flash', description: 'Cheaper/faster tier' },
  ],
  xai: [
    { id: 'xai:grok-3', label: 'Grok 3', description: '131k context' },
    { id: 'xai:grok-3-mini', label: 'Grok 3 Mini', description: 'Smaller/cheaper variant' },
  ],
  zhipu: [{ id: 'zhipu:glm-4-plus', label: 'GLM-4 Plus', description: '128k context' }],
  moonshotai: [{ id: 'moonshotai:kimi-k2.5', label: 'Kimi K2.5', description: '131k context' }],
  xunfei: [{ id: 'xunfei:astron-code-latest', label: 'Astron Code', description: '讯飞星火代码模型, 128k context' }],
}

// ─── 提供商 API 密钥获取地址 ───

export const PROVIDER_KEY_URLS: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/',
  openai: 'https://platform.openai.com/api-keys',
  google: 'https://aistudio.google.com/apikey',
  xai: 'https://console.x.ai/',
  deepseek: 'https://platform.deepseek.com/api_keys',
  alibaba: 'https://dashscope.console.aliyun.com/apiKey',
  zhipu: 'https://open.bigmodel.cn/usercenter/apikeys',
  moonshotai: 'https://platform.moonshot.ai/console/api-keys',
  xunfei: 'https://xinghuo.xfyun.cn/',
}

// ─── 重新导出 AI SDK 类型 ───

export type { ModelMessage, LanguageModel }

// ─── 重新导出子代理类型 ───

export type { SubAgentEvent, SubAgentDefinition, SubAgentTrace } from '../agent/sub-agents/types.js'
export type { SubAgentRegistry } from '../agent/sub-agents/registry.js'
