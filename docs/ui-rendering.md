# UI 渲染设计 — 使用指南

X-Code CLI 的终端 UI 采用 **Ink + 自定义 Cell-Buffer 渲染器** 的双轨架构：Ink 提供 React 生命周期和事件基础设施，但所有可见的终端输出都由 `ChatInput` 组件通过**像素级 diff 直接写入 stdout**，完全绕过了 Ink 的渲染管线。

英文版：[ui-rendering.en.md](./ui-rendering.en.md)

---

## 核心问题：为什么有了 Ink 还需要 ChatInput？

Ink 是一个优秀的"终端里的 React"框架，但在长对话 CLI 场景下有三个根本缺陷：

### 1. CJK / IME 宽度计算不准

Ink 使用 Yoga（Flexbox 引擎）做布局，`log-update` 做重绘。两者都用 `string-width` 库测量字符串的视觉宽度。但 CJK 字符的视觉宽度为 2 列，IME 输入期间的中间态更不可预测。实测中：

- Yoga 把一个 `宽` 字算成 1 列 → 后续文本整体偏移一列
- `log-update` 重绘时重新计算每行宽度 → 每次重绘都"跳"一下

项目已切换到 `@jrichman/ink@6.6.9`（Google fork，Gemini CLI 用的同一分支），它改进了 CJK 测量，但在 Windows ConHost 上仍不能完全消除抖动 — 因为**终端本身的 CJK 渲染就不是原子的**。

### 2. log-update 的 DECSC 寄存器冲突

Ink 的 `log-update` 使用 `\x1b7`（DECSC）保存光标位置，每次重绘都会覆盖这个唯一的终端保存寄存器。如果 ChatInput 也用 DECSC，两个写入者会互相覆盖光标锚点，产生"鬼影"位置。

### 3. 动态区域卸载时留空行

Ink 的动态区域（由 `log-update` 管理的 terminal 区域）在内容变矮时（比如对话框关闭），会在 scrollback 中留下空白行。长对话中这些空白行会不断累积。

### 解决方案

ChatInput 返回 `null` 给 Ink — Ink 的动态区域**永久为空**。所有可见 UI 都由 ChatInput 自己渲染：

```
终端屏幕
┌─────────────────────────────────────────┐
│                                         │ ← Ink 的动态区域（永久为空）
│                                         │    Ink 只管生命周期/Ctrl+C
├─────────────────────────────────────────┤
│ 已提交的 scrollback 消息（streaming     │ ← stdout-writer.ts 直接写
│ 文本、工具结果、用户输入等）              │    入终端 scrollback 历史
├ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┤ ← 上分隔线
│ ● readFile(src/config.ts)               │ ← ChatInput 的 Cell[][] 帧
│ ⎿ Reading...                            │    （spinner、工具状态）
├ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┤ ← 下分隔线
│ > 用户输入文本█                          │ ← 输入框 + 光标
│ ✓ Sonnet 4.6 · 12.4k/1M · 1%           │ ← 底栏
└─────────────────────────────────────────┘
```

### ChatInput 为什么没有 Ink 的 CJK 问题？

关键在于两者处理"宽度"的层级完全不同。

**Ink 是"先算布局，再输出"** — 它必须准确知道整行的宽度才能决定下一行从哪开始：

```
Yoga (Flexbox) 要算布局
  → 需要知道"这一行占多少列"
    → 调用 string-width 测量整行
      → 一行差 1 列，后续所有行全部偏移
        → log-update 全行重绘 → 放大误差
```

**ChatInput 是"逐字符已知宽度，直接定位"** — 每个字符在构建时就算好了 `width`：

```
逐字符构建 Cell[]
  'a'  → width: 1
  '宽' → width: 2     ← charWidth() 在字符级计算，不依赖行级测量

直接按累加宽度定位
  → 换行 = 新建一个 Cell[] 行
  → 光标 = 绝对坐标 \x1b[row;colH
  → 不需要"测量整行再决定怎么排"
```

`charWidth()` 只处理单个字符，比 `string-width` 处理整行字符串简单得多，也更准确。而且 diff 循环只写变化的 cell — 即使某个 CJK 字符宽度算错了，也只影响那一个位置，不会像 Ink 那样让后续所有行偏移。

| | Ink | ChatInput |
|---|---|---|
| 测量单位 | 整行字符串 | 单个字符 |
| 模型 | Flexbox 布局（先测量再排） | 点阵屏幕（每格已知） |
| 算错后果 | 后续所有行偏移 | 只影响当前格 |
| 重绘范围 | `log-update` 整行替换 | 只写变化的 cell |
| CJK 风险 | 高（行级测量 + 全行重绘放大误差） | 低（字符级 + diff 不放大误差） |

### 设计来源

ChatInput 不是外部代码拷贝，但确实借鉴了同赛道项目的设计理念：

| 设计点 | 来源 | 代码中的依据 |
|--------|------|-------------|
| 隐藏真光标 + 反色 cell 画假光标 | Claude Code | `palette.ts` 注释 "Claude Code's same hidden-cursor strategy" |
| `@jrichman/ink` fork + Cell 渲染思路 | Gemini CLI | `package.json` 别名、`CLAUDE.md` 明确说明 |
| DECSTBM scroll region 插入历史（已回退） | codex-rs (OpenAI) | `palette.ts` 注释 "modeled on codex-rs insert_history.rs" |

但实现是原创的 — Gemini CLI 用 `StyledLine`，ChatInput 用裸 ANSI SGR 字节；Claude Code 是闭源的，只有理念借鉴。3200 行中包含大量项目特有逻辑（权限对话框、子 agent 工具状态、todo 面板、Read 组折叠等）。

> Terminal TUI 渲染的设计空间非常小 — 基本上只有几种可行方案：全屏 buffer（ratatui）、log-update 替换（Ink）、cell-diff 直写（本项目）。Claude Code、Gemini CLI、x-code-cli 最终都收敛到"隐藏光标 + cell 直写 + BSU/ESU 原子化"不是巧合，而是终端协议的物理约束决定的 — 终端只有一个光标、一个 DECSC 寄存器、没有双缓冲。

---

## Ink 在项目中的实际角色

Ink 被保留只做三件事：

| 职责 | 使用的 API | 来源文件 |
|------|-----------|---------|
| React 生命周期 + 卸载信号 | `render(<App>)`, `waitUntilExit` | `app.tsx` |
| 退出控制 | `useApp().exit` | `App.tsx` |
| 终端尺寸 / stdin 原始模式 | `useStdout()`, `useStdin()` | `ChatInput.tsx`, `use-prompt-input.ts` |

**Ink 不做的事**：布局、测量、重绘、输出可见内容。

> 项目通过 `package.json` 的 `"ink": "npm:@jrichman/ink@6.6.9"` 别名引入 Google fork。代码中所有 `import from 'ink'` 都解析到这个 fork，但不要直接 `import from '@jrichman/ink'`。

---

## Cell-Buffer 渲染系统

### Cell 数据结构

每个 Cell 代表终端屏幕上的一个字符位：

```ts
interface Cell {
  char: string    // 单个字符（ASCII 或 CJK）
  style: string   // 原始 ANSI SGR 转义序列，如 '\x1b[38;2;147;165;255m'
  width: number   // 视觉宽度（ASCII=1, CJK=2）
}
```

一帧画面就是一个 `Cell[][]`（行数组，每行是 Cell 数组）。`width` 字段是消除 CJK 抖动的关键 — diff 循环跳过 CJK 字符的后半格时不会重新发射字形。

### Cell 构建函数

| 函数 | 作用 |
|------|------|
| `textToCells(text, style)` | 纯文本 → Cell[]，所有 cell 共享同一样式 |
| `ansiTextToCells(text)` | 解析含 ANSI 转义的文本 → Cell[]，每个 cell 携带自己的活跃样式 |
| `renderRowToAnsi(cells)` | Cell[] → ANSI 字符串（用于全行重绘） |
| `cellsEqual(a, b)` | 比较 char + style |

### 样式系统（palette.ts）

样式是硬编码的 RGB ANSI 转义序列，不能用 chalk（因为 diff 循环直接写字节）：

```ts
S_GRAY      = '\x1b[38;2;136;136;136m'   // 灰色（分隔线、注释）
S_SPINNER   = '\x1b[38;2;147;165;255m'   // 蓝紫色（Thinking...）
S_SUCCESS   = '\x1b[38;2;78;186;101;1m'  // 绿色粗体（完成）
S_CURSOR    = '\x1b[7m'                   // 反色（光标方块）
S_NONE      = '\x1b[0m'                   // 重置（非空！防止继承前一个 cell 的颜色）
```

> `S_NONE` 必须是 `'\x1b[0m'` 而不是空字符串。否则 diff 循环的 `if (cell.style !== lastStyle)` 分支不发射任何字节，导致默认样式的空格继承前一个蓝色 cell 的颜色，产生"一会白一会蓝"闪烁。

> **为什么不用 chalk？** diff 循环的热路径上每帧执行数百次 `buf += cell.style + cell.char`。如果 `style` 是一个 chalk 对象，每次拼接都要经过函数调用 + ANSI 拼装。把样式预编译为裸字节存在 Cell 上，diff 循环只需要做字符串拼接 — 在 stdout 写入的热路径上，任何抽象都是成本。这也是 Cell 的 `style` 存原始 ANSI 序列而非语义化颜色对象的原因。

---

## 一帧画面的组成

ChatInput 每次 render 构建一个 `frame: Cell[][]`，从上到下包含以下区域：

```
┌──────────────────────────────────────────┐
│ 1. 错误消息行（可选）                      │
│ 2. Spinner / 工具状态块                    │  ← Thinking... 或 ● toolName(preview)
│ 3. 权限对话框（可选）                      │  ← Yes/Always/No 选项
│ 4. 选择对话框（可选）                      │  ← @-mention /model 交互选择
│ 5. Todo 面板（可选）                       │  ← ✓ done  ○ pending  ↻ in_progress
│ 6. 权限槽位预留行                         │  ← 防止对话框关闭时闪烁
├── ── ── ── ── ── ── ── ── ── ── ── ── ── ┤
│ 7. 上分隔线 `──────`（灰色）               │
│ 8. 输入文本行（含软换行 + 光标）           │  ← █ 是反色 cell，不是真光标
│ 9. 下分隔线 `──────`（灰色）               │
│ 10. 底栏（模型名 · token用量 · 模式）      │
│ 11. 补全菜单（可选）                       │  ← /slash 命令 或 @文件补全
└──────────────────────────────────────────┘
```

**真光标**在组件挂载时就隐藏了（`\x1b[?25l`），用户看到的"光标"其实是一个反色背景的 Cell（`S_CURSOR = '\x1b[7m'`）。这保证了光标位置随帧原子更新，不会单独闪烁。

---

## 渲染管线：从 React State 到终端像素

整个渲染流程在一个 `useEffect` 中完成：

```
React render (state 变化)
       │
       ▼
  useEffect 触发
       │
       ├── 1. Scrollback 提交
       │     新消息通过 writeMessageToStdout() 写入 pendingScrollbackRef
       │
       ├── 2. 构建 Cell[][] 帧
       │     根据当前 state 组装所有区域
       │
       ├── 3. 计算几何
       │     frameTop = termRows - frameHeight + 1 - freeBlanks
       │     （"浮动帧"模型：内容少时帧浮在底部，内容多时帧贴在顶部）
       │
       ├── 4. 选择写入路径
       │     ├── 滚动提交 → FULL-REDRAW（整体重写）
       │     └── 稳定状态 → MINIMAL-WRITE（仅清间隙行）
       │
       ├── 5. Cell-by-cell diff
       │     逐行比较 prevFrame vs frame
       │     只发射变化的 cell
       │
       ├── 6. 组装 payload
       │     BSU + 定位指令 + diff bytes + 停靠光标 + ESU
       │
       └── 7. doFlush()
             process.stdout.write(payload)  ← 单次原子写入
```

### Cell-by-Cell Diff 算法

对每一行：

1. **从左扫描**：找到第一个 `(char, style)` 不同的 cell（`diffIdx`）
2. **从右扫描**：找到最后一个不同的 cell（`endIdx`）
3. **绝对定位**：`\x1b[absRow;col+1H` 跳到该行该列
4. **发射变化的 cell**：遍历 `diffIdx..endIdx`，只在样式变化时发射 SGR
5. **擦除尾部**：旧行更宽时，用空格覆盖残留字符

**效果**：spinner tick 时只有 1 个 cell 变化（旋转符号），整帧只需要写 2 个光标位置 + 几个字节。不是整帧重绘。

### BSU/ESU — DEC 2026 同步更新

每次写入都包裹在 DEC 2026 Synchronized Update 中：

```
\x1b[?2026h     ← BSU：开始同步更新
  ... 所有输出 ...
\x1b[?2026l     ← ESU：结束同步更新
```

支持的终端（Windows Terminal、iTerm2、Ghostty、kitty、Alacritty、WezTerm、VTE、xterm.js）会将 BSU/ESU 之间的所有输出缓冲为**一帧**，原子渲染。不支持 BSU/ESU 的终端会静默忽略这些序列。

> 光标可见性**不在每次渲染时切换**。早期版本在 BSU/ESU 之间切换 `\x1b[?25l/\x1b[?25h`，导致 80ms spinner 节奏下产生 12Hz 的 hide/show 闪烁。现在光标全程隐藏，由同步模式保证原子性。

---

## 防闪烁调度策略

不是每次 state 变化都立即写入终端：

| 场景 | 延迟 | 原因 |
|------|------|------|
| **Scrollback 提交**（新消息写入） | 立即 | 取消任何 pending 的延迟写入 |
| **Spinner tick** | 160ms | 下一个 stream-buffer drain 很可能会覆盖它 |
| **用户打字** | 8ms | 感知延迟要极低 |
| **同高度帧 <16ms** | 丢弃 | 合并（coalescing）避免无意义写入 |
| **两次提交间隔 <50ms** | 节流 | 防止同一 vsync 内双写 |

核心机制：一个 **generation counter**（`flushGenRef`）让延迟写入自失效 — 如果延迟期间发生了一次立即写入，延迟回调检测到 generation 不匹配就放弃执行。

---

## Scrollback：已提交消息的管理

Scrollback 是 append-only 的终端历史记录。`stdout-writer.ts` 负责格式化：

| 消息类型 | 渲染格式 |
|---------|---------|
| 用户输入 | `> 文本内容` |
| 助手流式文本 | Markdown → ANSI（带语法高亮） |
| 工具调用 | `● Label(preview)` + `⎿ 结果摘要` |
| 编辑 diff | 彩色 diff 块 |
| 命令回显 | `> /command` + `⎿ 结果` |

**关键优化**：
- **Read 组折叠**：连续的 Read/Glob/Grep/ListDir 工具调用合并为一行摘要，避免刷屏
- **流式 chunk 间距**：相邻 streaming chunk 之间不插入空行，让多行文本自然拼接成段落

---

## 权限对话框为什么不走 Ink？

权限对话框、选择对话框都渲染在 ChatInput 的 Cell 帧内，而不是 Ink 的子组件，原因：

1. **DECSC 冲突**：Ink 的 `log-update` 使用终端唯一的 `\x1b7` 光标保存寄存器。如果对话框通过 Ink 渲染，两个写入者争用同一寄存器，光标锚点互相覆盖
2. **空行累积**：Ink 动态区域在对话框关闭时变矮，`log-update` 的 erase 操作在 scrollback 中留下空白行
3. **原子性**：对话框需要在同一个 BSU/ESU 包内与帧一起渲染，不能分两次写入

---

## 文件地图

```
packages/cli/src/
├── app.tsx                          Ink render() 入口，挂载前打印 banner
├── ui/
│   ├── components/
│   │   ├── App.tsx                  根 React 组件，连接 useAgent → ChatInput
│   │   ├── AppHeader.tsx            启动 banner
│   │   ├── ChatInput.tsx            ★ 核心：3200+ 行，整个底部渲染引擎
│   │   └── chat-input/
│   │       ├── cells.ts             Cell 类型 + 构建/比较/渲染函数
│   │       ├── palette.ts           ANSI SGR 样式常量 + BSU/ESU
│   │       ├── permission.ts        权限对话框 cell 构建
│   │       ├── reducer.ts           输入文本 useReducer
│   │       ├── text-helpers.ts      Cell 行的换行/截断/计数
│   │       └── types.ts             MenuItem、PermissionRequest 等接口
│   ├── hooks/
│   │   ├── use-agent.ts             agent loop → React state 桥接
│   │   ├── use-prompt-input.ts      stdin raw mode + 按键解析
│   │   └── use-stream-buffer.ts     流式文本 chunking（安全换行边界）
│   ├── render-markdown.ts           Markdown → ANSI 渲染器
│   ├── render-diff.ts               编辑 diff 渲染器
│   ├── stdout-writer.ts             Scrollback 消息格式化 + 写入
│   ├── text-width.ts                CJK 宽度计算（isWide、charWidth、visualWidth）
│   ├── terminal-glyphs.ts           跨终端 Unicode 字形（●、⎿、❯ 等）
│   └── theme.ts                     主题色定义
```
