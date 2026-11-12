# Doc Copilot 🤖

AI 驱动的文档写作助手 Chrome 扩展。支持自动补全、审稿模式、Agent 对话、多模型配置。

适用于如流、飞书、Google Docs、Notion、语雀、腾讯文档等任何 Web 文档编辑器。

## ✨ 功能

- **`\` 命令面板** — 类似 VS Code 的命令输入，快速执行 fix/rewrite/polish/translate 等命令
- **悬浮窗** — 可拖拽面板，包含 Chat / Review / Settings 三个标签页
- **自动补全** — 灰色幽灵文本，Tab 采纳，Esc 放弃（类似 GitHub Copilot）
- **审稿模式** — 多个采纳点，Tab/Esc 逐个处理，Ctrl+Shift+A 全部采纳
- **Agent 对话** — 内置文档工具（总结、翻译、改写、扩写、润色等）
- **多模型支持** — Fast/Smart/Image 三档模型，OpenAI 兼容 API 格式
- **第三方代理** — 支持任意 OpenAI 格式的 API（如 OneAPI、New API 等代理）

## 🏗 架构

```
Platform Layer     → Chrome Extension (future: Word/WPS)
  ↓
Adapter Layer      → IDocumentAdapter (统一文档操作接口)
  ↓
Core Layer         → Autocomplete / Review / Agent 引擎
  ↓
Model Provider     → Fast (补全) / Smart (Agent) / Image (图像生成)
```

详见 [CLAUDE.md](./.claude/CLAUDE.md)

## 📦 构建

### 前置要求

- Node.js >= 18
- pnpm (推荐) 或 npm

### 安装与构建

```bash
# 安装依赖
pnpm install

# 构建扩展
pnpm build

# 类型检查
pnpm typecheck

# 清理
pnpm clean
```

### 加载到 Chrome

1. 打开 `chrome://extensions`
2. 开启右上角 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择 `dist/` 文件夹

## ⌨️ 快捷键

| 快捷键 | 功能 |
|--------|------|
| `\` | 打开命令面板（需在编辑器中，行首或空格后） |
| `Alt+Shift+D` | 打开/关闭悬浮窗 |
| `Tab` | 采纳自动补全 / 采纳当前审稿建议 |
| `Esc` | 取消自动补全 / 拒绝当前审稿建议 |
| `Ctrl+↑` / `Ctrl+↓` | 上一个/下一个审稿建议 |
| `Ctrl+Shift+A` | 全部采纳审稿建议 |
| `Ctrl+Shift+R` | 全部拒绝审稿建议 |

## ⚙️ 配置

点击悬浮窗的 **Settings** 标签或命令面板输入 `/settings`。

### 模型配置

支持 OpenAI 兼容格式的第三方代理：

| 角色 | 用途 | 推荐模型 |
|------|------|----------|
| ⚡ Fast | 自动补全（低延迟） | gpt-3.5-turbo / deepseek-chat |
| 🧠 Smart | Agent 对话/审稿/改写 | gpt-4 / claude-3 |
| 🎨 Image | 图像生成 | flux-schnell |

每个角色独立配置：
- **API Base URL** — 如 `https://api.openai.com/v1` 或你的代理地址
- **API Key** — 你的 API 密钥
- **Model ID** — 模型名称

### 功能开关

- ✅ 自动补全 (ghost text)
- ✅ 自动纠错提示
- ✅ 内联建议

## 🌐 平台兼容性

Content Script 注入所有网页，通过 `IDocumentAdapter` 检测编辑器类型：

| 平台 | 编辑器类型 | 状态 |
|------|-----------|------|
| 如流 (Infoflow) | contentEditable | ✅ 支持 |
| 飞书 (Feishu/Lark) | contentEditable | ✅ 支持 |
| Google Docs | contentEditable | ✅ 支持 |
| Notion | contentEditable | ✅ 支持 |
| 语雀 (Yuque) | contentEditable | ✅ 支持 |
| 腾讯文档 | contentEditable | ✅ 支持 |
| 石墨文档 | contentEditable | ✅ 支持 |
| Confluence | contentEditable | ✅ 支持 |
| textarea / input | 原生表单 | ✅ 支持 |

> 由于各平台使用 contentEditable 的方式不同，部分高级功能（如 ghost text 精确定位）在复杂编辑器中可能需要适配。

## 🔮 扩展计划

- [ ] Word Add-in 适配器
- [ ] WPS 插件适配器
- [ ] 飞书/如流专用适配器（精确光标定位）
- [ ] 本地模型支持 (Ollama)
- [ ] 自定义 System Prompt
- [ ] 多语言 UI

## 📁 项目结构

```
doc-copilot/
├── public/
│   ├── manifest.json          # Chrome Extension Manifest V3
│   └── icons/                 # Extension icons
├── src/
│   ├── adapters/
│   │   ├── base/adapter.ts    # IDocumentAdapter 接口
│   │   └── chrome/adapter.ts  # Chrome 实现 (contentEditable + textarea)
│   ├── core/
│   │   ├── models/provider.ts # 多模型 OpenAI-compatible 客户端
│   │   ├── autocomplete/      # 自动补全引擎
│   │   ├── review/            # 审稿引擎
│   │   └── agent/             # Agent 系统
│   ├── content/               # Content Script (页面注入)
│   │   ├── index.ts           # 主入口 + 键盘快捷键
│   │   ├── autocomplete-controller.ts
│   │   ├── command-palette/   # `\` 命令面板
│   │   ├── floating-panel/    # 悬浮窗 (Chat/Review/Settings)
│   │   ├── review-overlay/    # 审稿模式 UI
│   │   └── styles.ts          # CSS 注入
│   ├── background/index.ts    # Background Service Worker
│   ├── popup/                 # Extension popup
│   └── shared/
│       ├── types/index.ts     # 全局类型定义
│       ├── utils/index.ts     # 工具函数
│       └── storage/settings.ts # 设置存储
├── scripts/
│   └── build.sh               # 构建脚本 (3-pass IIFE)
├── vite.config.ts
├── tsconfig.json
└── package.json
```
