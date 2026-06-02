# 多供应商管理 — 使用指南

X-Code CLI 通过统一的 AI SDK 适配层支持 10 家大模型供应商（含 1 个 OpenAI 兼容自定义端点）。所有供应商在 agent loop 中共享同一份 `streamText` 调用代码，差异通过 `providerOptions` 透传给各家 SDK。

英文版：[providers.en.md](./providers.en.md)

---

## 整体架构

```
用户 --model xunfei:astron-code-latest
       │
       ▼
  config/index.ts          解析 env vars → getProviderOptions()
       │
       ▼
  providers/registry.ts    条件实例化 → createProviderRegistry()
       │
       ▼
  registry.languageModel('xunfei:astron-code-latest')
       │                        └─ AI SDK 按冒号前缀路由到对应 provider 实例
       ▼
  agent/loop.ts            streamText({ model, providerOptions })
       │
       ├── providers/thinking.ts       按 provider 拼 thinking 参数
       ├── providers/cache-control.ts  按 provider 拼 cache-control 参数
       └── providers/capabilities.ts   按 provider 查询视觉/PDF 能力
```

**核心设计原则**：

- **provider 与 model 解耦** — model id 格式为 `provider:model`（如 `anthropic:claude-sonnet-4-6`），冒号前缀路由到对应 provider 实例，冒号后是供应商侧的模型标识
- **统一接口，差异透传** — agent loop 只管 `streamText({ model, providerOptions })`，各家专有参数通过 `providerOptions` 按 provider 名字空间隔离
- **条件注册** — 只有 API Key 已配置的 provider 才被实例化，未配置的不会出现

---

## 已支持供应商

| Provider | SDK 包 | 环境变量 | 默认模型 | 特殊处理 |
|----------|--------|----------|----------|----------|
| Anthropic | `@ai-sdk/anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` | cache_control 断点 |
| OpenAI | `@ai-sdk/openai` | `OPENAI_API_KEY` | `gpt-4.1` | promptCacheKey |
| Google | `@ai-sdk/google` | `GOOGLE_GENERATIVE_AI_API_KEY` | `gemini-2.5-pro` | — |
| xAI | `@ai-sdk/xai` | `XAI_API_KEY` | `grok-3` | — |
| DeepSeek | `@ai-sdk/deepseek` | `DEEPSEEK_API_KEY` | `deepseek-v4-flash` | reasoning_content 回填 |
| Alibaba | `@ai-sdk/alibaba` | `ALIBABA_API_KEY` | `qwen-max` | 硬编码 baseURL |
| Zhipu | `zhipu-ai-provider`（社区包） | `ZHIPU_API_KEY` | `glm-4-plus` | 直接使用导出实例 |
| Moonshot | `@ai-sdk/moonshotai` | `MOONSHOT_API_KEY` | `kimi-k2.5` | — |
| 讯飞 | `@ai-sdk/openai-compatible` | `XF_API_KEY` + `XF_BASE_URL` | `astron-code-latest` | 需额外 baseURL |
| Custom | `@ai-sdk/openai-compatible` | `OPENAI_COMPATIBLE_API_KEY` + `OPENAI_COMPATIBLE_BASE_URL` | — | 通用兼容端点 |

> 大多数 SDK 包遵循统一约定：从同名环境变量自动读取 API Key，无需在代码中显式传参。需要 `baseURL` 的供应商（Alibaba、讯飞、Custom）在 `registry.ts` 中显式指定。

---

## 四层配置体系

供应商适配分布在四个关键文件中，各管一件事：

### 1. 配置层 — `config/index.ts`

职责：从环境变量读取 API Key，判断哪些 provider 可用。

```ts
// ENV_MAP: 只需 API Key 的供应商（8 家）
const ENV_MAP = {
  anthropic: 'ANTHROPIC_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  // ...
}

// 需要 apiKey + baseURL 的供应商，在 getProviderOptions() 中特殊处理
xunfei: { apiKey: process.env.XF_API_KEY, baseURL: process.env.XF_BASE_URL }
custom: { apiKey: process.env.OPENAI_COMPATIBLE_API_KEY, baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL }
```

**模型解析优先级**（`resolveModelId`）：

1. `--model` CLI 参数
2. `~/.x-code/config.json` 中的 `model` 字段（由 `/model` 指令写入）
3. `X_CODE_MODEL` 环境变量
4. 智能默认：按 `PROVIDER_DETECTION_ORDER` 顺序，取第一个有 API Key 的供应商的默认模型

### 2. 注册层 — `providers/registry.ts`

职责：根据配置层返回的 options 条件实例化 AI SDK provider，聚合成统一查询入口。

```ts
function createModelRegistry() {
  const opts = getProviderOptions()
  const providers = {}

  // 有专用 SDK 包的 → 用工厂函数
  if (opts.anthropic) providers.anthropic = createAnthropic({ fetch: permanentErrorFetch })
  if (opts.deepseek)  providers.deepseek  = createDeepSeek({ fetch: deepseekReasoningFetch })

  // OpenAI 兼容端点 → 用 createOpenAICompatible
  if (opts.xunfei.apiKey && opts.xunfei.baseURL) {
    providers.xunfei = createOpenAICompatible({
      name: 'xunfei', apiKey: opts.xunfei.apiKey,
      baseURL: opts.xunfei.baseURL, fetch: permanentErrorFetch,
    })
  }

  return createProviderRegistry(providers)
}
```

所有 provider 实例都包裹 `permanentErrorFetch` — 它将供应商返回的"其实是永久的"错误（余额不足、上下文溢出、内容过滤）从可重试的 HTTP 状态码改为不可重试的，避免 AI SDK 白白重试 30 秒。

### 3. 能力层 — `providers/capabilities.ts`

职责：声明每个供应商是否支持图片、PDF、文件上传。

```ts
const CAPS = {
  anthropic: { image: true,  pdf: true,  filesApi: true  },
  deepseek:  { image: false, pdf: false, filesApi: false },
  xunfei:    { image: false, pdf: false, filesApi: false },
  custom:    { image: false, pdf: false, filesApi: false },
  // ...
}
```

不支持视觉的供应商在用户粘贴图片时自动走降级路径：优先借用其他已配置供应商的视觉模型生成描述（`vision-fallback.ts`），其次用 tesseract.js 本地 OCR。

### 4. 适配层 — `providers/thinking.ts` + `providers/cache-control.ts`

**thinking.ts** — 将用户侧统一的 `/thinking on|off` 开关映射为各家不同的参数：

| Provider | ON | OFF |
|----------|----|-----|
| Anthropic | `thinking: { type: 'enabled', budgetTokens: 8000 }` | `thinking: { type: 'disabled' }` |
| DeepSeek / Moonshot | `thinking: { type: 'enabled' }` | `thinking: { type: 'disabled' }` |
| Alibaba | `enableThinking: true` | `enableThinking: false` |
| Google | `thinkingConfig: { thinkingBudget: -1 }` | `thinkingConfig: { thinkingBudget: 0 }` |
| xAI / OpenAI | `reasoningEffort: 'high'` | `reasoningEffort: 'low'` / `'minimal'` |
| 其他 | 无操作（`return {}`） | 无操作 |

**cache-control.ts** — 提示缓存策略：

| Provider | 策略 |
|----------|------|
| Anthropic | 在 system 消息、最后 2 条消息、最后一个 tool 定义上标记 `cacheControl: { type: 'ephemeral' }`（4 个断点） |
| OpenAI | 通过 `promptCacheKey: sessionId` 路由到同一缓存分片 |
| 其他 | 隐式前缀缓存，依赖 `systemPromptCache` 保持字节稳定 |

---

## 如何添加新供应商

以添加讯飞（iFlytek）为例，完整步骤如下：

### Step 1：确认 SDK 包

- 如果有官方 `@ai-sdk/<vendor>` 包 → 用工厂函数（如 `createDeepSeek`）
- 如果有社区包 → 直接使用导出实例（如 Zhipu 的 `zhipu`）
- 如果只有 OpenAI 兼容 API → 用 `@ai-sdk/openai-compatible` 的 `createOpenAICompatible`

在 `packages/core/package.json` 中添加依赖（如果需要新包）。

### Step 2：配置环境变量 — `packages/core/src/config/index.ts`

**只需 API Key 的供应商**：在 `ENV_MAP` 中添加一行。

**需要 API Key + Base URL 的供应商**：在 `getProviderOptions()` 返回值中添加特殊字段，并在 `getAvailableProviders()` 中添加检测逻辑。

### Step 3：注册 Provider — `packages/core/src/providers/registry.ts`

```ts
// 有专用 SDK
if (opts.xxx) providers.xxx = createXxx({ fetch: permanentErrorFetch })

// OpenAI 兼容端点
if (opts.xxx.apiKey && opts.xxx.baseURL) {
  providers.xxx = createOpenAICompatible({
    name: 'xxx', apiKey: opts.xxx.apiKey,
    baseURL: opts.xxx.baseURL, fetch: permanentErrorFetch,
  })
}
```

### Step 4：声明能力 — `packages/core/src/providers/capabilities.ts`

在 `CAPS` 表中添加 `{ image, pdf, filesApi }`。不确定时保守设为 `false`。

### Step 5：thinking 适配 — `packages/core/src/providers/thinking.ts`

如果新供应商支持 thinking/reasoning，在 `switch (provider)` 中添加 case。否则跳过（自动 fallthrough 到 `default: return {}`）。

### Step 6：模型目录 — `packages/core/src/types/index.ts`

添加三处：

```ts
// 1. 检测顺序（末位添加）
PROVIDER_DETECTION_ORDER = [
  // ...existing...
  { envKey: 'XXX_API_KEY', defaultModel: 'xxx:model-id' },
]

// 2. 模型列表（供 /model 交互式选择）
PROVIDER_MODELS.xxx = [
  { id: 'xxx:model-id', label: 'Model Name', description: 'xxx context' },
]

// 3. API Key 管理页面
PROVIDER_KEY_URLS.xxx = 'https://...'
```

### Step 7：上下文窗口 — `packages/core/src/agent/context-window.ts`

```ts
// 模型级
MODEL_CONTEXT_WINDOWS.set('xxx:model-id', 128000)

// provider 级 fallback
PROVIDER_CONTEXT_WINDOWS.set('xxx', 128000)
```

### Step 8：测试更新 — `packages/core/tests/config.test.ts`

在 `PROVIDER_ENV_VARS` 数组中添加新供应商的环境变量名，防止测试泄漏。

### Step 9：验证

```bash
pnpm typecheck    # 类型检查
pnpm test         # 单元测试
pnpm build        # 构建
```

---

## 供应商特有的兼容性处理

某些供应商需要额外的请求/响应修补，这些在 `registry.ts` 和 `provider-compat.ts` 中处理：

| 供应商 | 问题 | 处理方式 |
|--------|------|----------|
| DeepSeek V4 | API 要求回传 `reasoning_content`，但 SDK 转换器会丢失空值 | `deepseekReasoningFetch` 在请求发出前回填 `reasoning_content: ""` |
| DeepSeek V4 | 同上 | `ensureReasoningContentParts` 在消息列表中注入空的 reasoning part |
| Alibaba | DashScope API 地址不是默认值 | 硬编码 `baseURL` 到 `dashscope.aliyuncs.com` |
| Anthropic | API 限制 4 个 cache_control 断点 | 在 system + 最后 2 消息 + 最后 tool 上标记断点 |

所有供应商共享的 `permanentErrorFetch` 会拦截以下永久性错误并改为不可重试状态码：

| 错误类型 | 目标状态码 | 检测关键词 |
|----------|-----------|-----------|
| 余额不足 / 配额耗尽 | 402 | `insufficient balance`、`exceeded_current_quota` |
| 上下文超长 | 413 | `context_length_exceeded`、`prompt is too long` |
| 内容安全过滤 | 422 | `content_filter`、`harmful_content` |
| API Key 无效 | 401 | `invalid api key`、`expired api key` |
| 模型不存在 | 404 | `model_not_found`、`unknown model` |
