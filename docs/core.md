core 内部模块地图
`@x-code-cli/core` 内部按职责分目录。读者完全不必现在就读完每个文件——这张地图的作用是让后续章节出现“打开 agent/loop.ts 看一下”这类指引时，你能立刻知道它在产品里属于哪一层。

```
packages/core/src/
├── agent/                  Agent 引擎主体
│   ├── loop.ts             agent loop 主循环                     → Ch.08
│   ├── loop-state.ts       LoopState（messages / 用量 / 缓存等）  → Ch.08
│   ├── loop-guard.ts       检测重复 tool call、阻断 doom-loop     → Ch.32
│   ├── system-prompt.ts    系统提示词构建                         → Ch.08
│   ├── stream-utils.ts     流式 chunk 处理                        → Ch.10
│   ├── api-errors.ts       错误分类与恢复                         → Ch.11
│   ├── tool-execution.ts   工具执行分发                           → Ch.17 / Ch.18
│   ├── tool-result-sanitize.ts   工具结果截断                     → Ch.17
│   ├── compression.ts      上下文压缩                             → Ch.31
│   ├── context-window.ts   token 计数与阈值                       → Ch.30 / Ch.31
│   ├── light-compact.ts    轻量压缩兜底                           → Ch.31
│   ├── plan-tools.ts       todoWrite / planMode 分发              → Ch.20 / Ch.21
│   ├── plan-storage.ts     plan 文件持久化                        → Ch.21
│   ├── file-ingest.ts      文件附件解析                           → Ch.35
│   ├── vision-fallback.ts  纯文本模型借视觉                       → Ch.35
│   ├── memory-extractor.ts 后台记忆提炼                           → Ch.36
│   ├── session-store.ts    会话 jsonl 存储                        → Ch.36
│   ├── diff.ts             edit 工具的 diff 计算（走 UI 不进 messages） → Ch.13
│   ├── messages.ts         消息类型与构造辅助                      → Ch.08
│   ├── provider-compat.ts  供应商兼容性 shim（如 DeepSeek V4 reasoning） → Ch.09 / Ch.35
│   └── sub-agents/         子 agent 引擎（task 工具）             → Ch.19
├── tools/                  工具实现（13 个静态 + task 共 14 个）
│   ├── read-file / edit / write-file                              → Ch.13
│   ├── shell / shell-provider / shell-utils                       → Ch.14
│   ├── glob / grep / list-dir                                     → Ch.15
│   ├── web-search / web-fetch                                     → Ch.16
│   ├── ask-user / todo-write / enter-plan-mode / exit-plan-mode   → Ch.18 / Ch.20 / Ch.21
│   ├── task                                                       → Ch.19
│   └── 辅助：progress（进度回调注册）/ truncate（结果截断）/ index.ts（toolRegistry 的统一导出文件）  → Ch.12 / Ch.17
├── providers/              多供应商适配
│   ├── registry.ts         createProviderRegistry 装配 8 家       → Ch.09
│   ├── capabilities.ts     模型能力查询
│   ├── cache-control.ts    Anthropic / OpenAI 兼容端的缓存策略    → Ch.33
│   └── thinking.ts         /thinking 各家差异适配                  → Ch.34
├── permissions/            三级权限模型 + session allow rules     → Ch.29
├── knowledge/              AGENTS.md 链 + 自动记忆 + 会话摘要      → Ch.36
├── config/                 模型解析、env / config.json
├── types/                  公共类型（AgentOptions / AgentCallbacks 等）
├── utils/                  通用工具（lru-cache / media-type / shell-error 等）
└── index.ts                barrel export（一个 index 文件 re-export 各模块的导出，作为 cli 唯一 import 入口）

```


- **agent / 是引擎，tools / 是工具集**——agent 知道“什么时候该调工具”，工具自己只管“被调时做什么”。两边通过 tool-execution.ts 这个分发层连起来
- **providers / 是适配层**——抹平 8 家 LLM 的协议差异（缓存、thinking、模型注册），让 agent loop 能写一份代码跑遍所有供应商
- **permissions / knowledge / 是横切关注点**——每个工具调用前过权限层，每次启动从知识层读 AGENTS.md
- **types / 与 index.ts 是公开 API 边界**——cli 唯一允许 import 的就是 index.ts 里 re-export 的符号
