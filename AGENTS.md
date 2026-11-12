# Doc Copilot — AGENTS.md（完整项目知识交接文档）

> **最后更新**: 2026-03-07
> **当前版本**: v0.2.40
> **状态**: 基本功能完成，等用户测试 Chat 和百度知识库适配

---

## 1. 项目概述

Doc Copilot 是一个 **Chrome MV3 扩展**，定位为文档领域的 AI 写作助手（类似 GitHub Copilot 但面向文档编辑器）。支持任何 Web 文档编辑器（如流、飞书、Google Docs、Notion、百度知识库等）。

### 核心功能
1. **自动补全** — 灰色 ghost text，Tab 采纳，Esc 取消（类似 GitHub Copilot）
2. **选中文本优化** — 选中文字后可通过悬浮工具栏或右键菜单 fix/rewrite/polish/translate
3. **审稿模式** — AI 分析文档生成修改建议，逐条 Tab 采纳 / Esc 拒绝
4. **悬浮窗 Agent Chat** — 可拖拽面板，与 AI 对话讨论文档内容
5. **只读模式支持** — 无编辑元素时，Chat/Review 仍可基于页面内容工作
6. **单文本模型配置** — 自动补全 / Agent Chat / 审稿共用 Smart 文本模型，OpenAI 兼容 API

---

## 2. 技术架构

### 分层架构
```
Platform Layer     → Chrome Extension（未来: Word/WPS）
  ↓
Site Adapter       → ISiteAdapter（站点内容提取，支持只读）
  ↓
Document Adapter   → IDocumentAdapter（编辑操作：插入、替换、ghost text）
  ↓
Core Layer         → Autocomplete / Review / Agent 引擎
  ↓
Model Provider     → Smart Text Model（OpenAI 兼容 API）
  ↓
Storage Layer      → chrome.storage.sync（设置）
```

### 技术栈
- **语言**: TypeScript（strict mode）
- **构建**: Vite（3-pass IIFE 构建，不是 ESM）
- **包管理**: pnpm
- **构建目标**: Chrome 110+
- **无外部运行时依赖**，纯 TypeScript 实现

### 关键设计决策
- **IIFE 构建**：Chrome MV3 service worker 和 content script 都不支持 ES modules，必须用 IIFE
  - ⚠️ manifest.json 的 background 段**不能**有 `"type": "module"`
  - ⚠️ popup.html 的 script 标签**不能**有 `type="module"`
- **Shadow DOM 未使用**：当前 UI 组件直接注入页面 DOM，用 CSS 前缀 `dc-` 隔离
- **Adapter 模式**：`IDocumentAdapter` 抽象编辑操作，`ISiteAdapter` 抽象内容提取
- **OpenAI 兼容 API**：所有模型通过 `base_url + api_key + model_id` 配置

---

## 3. 项目结构

```
doc-copilot/
├── public/
│   ├── manifest.json          # Chrome MV3 manifest
│   └── icons/                 # 扩展图标（16/32/48/128 png+svg）
├── src/
│   ├── adapters/
│   │   ├── base/adapter.ts    # IDocumentAdapter 接口定义
│   │   ├── chrome/adapter.ts  # ChromeDocumentAdapter — contentEditable + textarea 实现
│   │   └── sites/
│   │       ├── types.ts       # ISiteAdapter 接口 + SiteContentResult 类型
│   │       ├── registry.ts    # SiteAdapterRegistry 单例（URL → adapter 匹配）
│   │       ├── baidu-ku.ts    # BaiduKuAdapter — ku.baidu-int.com 专用（Slate.js）
│   │       └── generic.ts     # GenericSiteAdapter — 通用兜底（任何页面）
│   ├── core/
│   │   ├── models/provider.ts # ModelProvider — OpenAI 兼容 API 客户端 + token 统计
│   │   ├── autocomplete/engine.ts  # AutocompleteEngine — debounce + 缓存 + 流式补全
│   │   ├── review/engine.ts        # ReviewEngine — 分析文档 → ReviewPoint 列表
│   │   └── agent/system.ts         # AgentSystem — 内置工具 + 对话历史 + 流式回复
│   ├── content/
│   │   ├── index.ts                # 主入口 DocCopilot 类 — 初始化一切 + 键盘快捷键
│   │   ├── autocomplete-controller.ts  # ghost text 生命周期管理
│   │   ├── command-palette/controller.ts  # 命令执行逻辑（右键菜单复用）
│   │   ├── floating-panel/controller.ts   # 悬浮窗（Chat/Review/Settings）
│   │   ├── review-overlay/controller.ts   # 审稿覆盖层 UI
│   │   └── styles.ts              # 所有 CSS（JS 注入）
│   ├── background/index.ts        # Background Service Worker — 消息路由 + 右键菜单
│   ├── popup/
│   │   ├── popup.html             # 扩展弹出窗口 HTML
│   │   └── popup.ts               # 弹出窗口脚本
│   └── shared/
│       ├── types/index.ts         # 所有类型定义 + DEFAULT_SETTINGS
│       ├── utils/index.ts         # 工具函数（debounce/throttle/EventEmitter/detectLanguage）
│       └── storage/settings.ts    # SettingsStorage — chrome.storage 封装 + 智能合并
├── scripts/
│   └── build.sh                   # 3-pass 构建脚本
├── vite.config.ts                 # Vite 配置（多入口 IIFE）
├── tsconfig.json
├── package.json
└── dist/                          # 构建输出（加载到 Chrome 的目录）
```

---

## 4. 模型配置

### 默认配置（需用户首次配置）
| 角色 | 用途 | 模型 | 温度 |
|------|------|------|------|
| 🧠 Smart | 文本模型（补全 / Chat / 审稿） | 用户填写 | 0.7 |

- **API Base / API Key / Model ID**: 默认为空，首次使用时只需填写 Smart 文本模型
- **所有 max_tokens**: 8192
- **格式**: OpenAI 兼容（`/chat/completions`）

### 设置合并逻辑
`SettingsStorage.mergeModelConfig()` 会合并用户设置，并清理历史版本内置的默认 API 配置：
- 用户手动填写的非空字符串会保留
- 历史版本内置的默认 URL / 模型 / SK 会被识别并清空，引导用户重新配置
- 数字/布尔值正常覆盖

---

## 5. 快捷键

| 快捷键 | 功能 | 绑定位置 |
|--------|------|----------|
| `Alt+Shift+D` | 切换悬浮窗 | content/index.ts + manifest commands |
| `Tab` | 采纳 ghost text / 采纳审稿建议 | content/index.ts **capture phase** |
| `Esc` | 取消补全 / 拒绝审稿 / 关闭面板 | content/index.ts bubble phase |
| `Ctrl+↑/↓` | 上/下一个审稿建议 | content/index.ts bubble phase |
| `Ctrl+Shift+A` | 全部采纳审稿建议 | content/index.ts bubble phase |
| `Ctrl+Shift+R` | 全部拒绝审稿建议 | content/index.ts bubble phase |

> ⚠️ **Tab 在 capture phase 监听**！这是关键——Slate.js 等编辑器会在自己的事件处理中消费 Tab，必须用 capture phase + `stopImmediatePropagation()` 抢先处理。

---

## 6. Site Adapter 子系统

### 设计目标
- 可扩展：加新站点只需一个文件 + 注册一行代码
- 编辑/只读模式自动检测
- 独立于 Document Adapter（内容提取 vs 编辑操作分离）

### ISiteAdapter 接口
```typescript
interface ISiteAdapter {
  readonly id: string;
  readonly name: string;
  matches(url: string, document: Document): boolean;
  extractContent(document: Document): SiteContentResult | null;
  getEditableElement(document: Document): HTMLElement | null;
  observe(document: Document, callback: (content: SiteContentResult) => void): () => void;
}
```

### 现有实现

#### BaiduKuAdapter（`baidu-ku.ts`）
- **匹配**: `ku.baidu-int.com` 或 `ku.baidu.com`
- **编辑器**: Slate.js（`data-slate-editor="true"`）
- **核心选择器**:
  - 主文档: `div[data-slate-editor="true"].mp-editor-container:not(.mp-micro-editor)`
  - 回退: `#knowledgeContent div[data-slate-editor="true"]`
  - 评论框（排除）: `.mp-micro-editor`
- **只读判断**: `contenteditable="false"` + `.mp-editor-readonly` 类
- **内容提取**: 克隆 DOM → 移除 UI 装饰（`mp-card-add`, `mp-list-item-bullet` 等）→ `innerText`
- **标题提取**: 多级回退（`.mp-header-title-editor input` → `h1` → `document.title`）
- **首次加载诊断**: 自动输出 DOM 结构到 Console（`logDomDiagnostics()`）

#### GenericSiteAdapter（`generic.ts`）
- **匹配**: 永远返回 true（最低优先级兜底）
- **内容提取**: `<article>` → `<main>` → `[role="main"]` → 最大文本块 → `document.body`
- **编辑检测**: `document.activeElement` 是否可编辑

### 注册顺序（`content/index.ts` → `initializeSiteAdapters()`）
1. `BaiduKuAdapter`（优先匹配）
2. `GenericSiteAdapter`（兜底）

> 未来可加: 飞书、CSDN、Notion 等，一个文件 + `siteAdapterRegistry.register(new XxxAdapter())` 即可。

---

## 7. 消息流（Chrome Extension 消息机制）

```
Content Script (page)
  ↕ chrome.runtime.sendMessage / onMessage
Background Service Worker
  → ModelProvider (fetch to API)
  → AutocompleteEngine / ReviewEngine / AgentSystem
  ← Response / StreamChunk
```

### 消息类型
| Type | 方向 | 用途 |
|------|------|------|
| `AUTOCOMPLETE_REQUEST` | Content → BG | 请求补全 |
| `REVIEW_REQUEST` | Content → BG | 请求审稿分析 |
| `AGENT_MESSAGE` | Content → BG | Agent 对话 |
| `GET_SETTINGS` | Content → BG | 读取设置 |
| `GET_USAGE` | Content → BG | 获取 token 统计 |
| `UPDATE_SETTINGS` | Content → BG | 保存设置 |
| `SETTINGS_CHANGED` | BG → Content (broadcast) | 设置变更通知 |
| `COMMAND` | BG → Content | 键盘快捷键命令 |
| `CONTEXT_MENU_ACTION` | BG → Content | 右键菜单操作 |

---

## 8. Agent Chat 上下文构建

`AgentSystem.buildChatMessages()` 的上下文组装逻辑：

1. System prompt 包含：
   - 角色描述 + 可用工具列表
   - 文档标题（`context.title`）
   - **完整文档文本**（`context.fullText`，截断到 `agentMaxContextChars`，默认 8192 字符）
   - 选中文本（`context.selectedText`，截断 1000 字符）
   - 光标前后文本（各 500 字符）
2. 对话历史：最近 20 条消息

### 上下文来源
- **编辑模式**: `ChromeDocumentAdapter.getContext()` + `siteContent.fullText` 补充
- **只读模式**: `siteAdapter.extractContent()` → `fullText` 作为整体上下文

> ⚠️ **之前的 bug**: Agent prompt 只传 textBefore/textAfter（各 300 字），只读模式下 textAfter 为空，textBefore 只是文档末尾片段。v0.2.1 已修复——显式传 `fullText` 到 system prompt。

---

## 9. 构建与打包

### 构建命令
```bash
cd doc-copilot
pnpm install
pnpm build          # 等价于 bash scripts/build.sh
```

### 构建流程（3-pass）
```bash
BUILD_TARGET=content npx vite build    # → dist/content.js（content script）
BUILD_TARGET=background npx vite build  # → dist/background.js（service worker）
BUILD_TARGET=popup npx vite build       # → dist/popup.js + 复制静态文件
```

每个 target 的 vite 配置在 `vite.config.ts` 中通过 `BUILD_TARGET` 环境变量切换。

### 打包分发
```bash
cd dist && zip -r ../doc-copilot-v0.2.40-chrome.zip . && cd ..
```
zip 文件放在项目根目录，用户下载后解压加载 `dist/` 目录即可。

### 加载到 Chrome
1. 打开 `chrome://extensions`
2. 开启**开发者模式**
3. 点击**加载已解压的扩展程序**
4. 选择 `dist/` 文件夹

---

## 10. 已知问题与注意事项

### 历史 bug（已修复）

| 版本 | 问题 | 修复 |
|------|------|------|
| v0.1.0 | manifest 缺 `contextMenus` 权限 | 添加 `"contextMenus"` 到 permissions |
| v0.1.0 | background SW 用了 `type: "module"` | IIFE 构建不能用 module |
| v0.1.0 | popup.html script 标签用了 `type="module"` | 同上 |
| v0.1.1 | Tab 键无法采纳 ghost text | `acceptGhostText()` 先读数据再删 DOM |
| v0.1.1 | `Set.toArray()` 浏览器不兼容 | 改为 `Array.from()` |
| v0.2.0 | BaiduKuAdapter 选择器全是猜测 | 基于真实 DOM 诊断完全重写 |
| v0.2.0 | Agent Chat 只传光标前后 300 字 | 加入 fullText（截断 8192） |
| v0.2.0 | popup.html 版本号未更新 | footer 仍显示 v0.2.0（小问题） |

### 重要教训
1. **Chrome MV3 + IIFE**: `type: "module"` 在 manifest background 和 popup script 标签都不能用
2. **permissions 必须声明**: `chrome.contextMenus` 需要 `"contextMenus"` 权限
3. **百度知识库 Console 禁止粘贴代码**: 调试只能靠扩展内嵌日志（`[Doc Copilot]` 前缀）
4. **Slate.js Tab 拦截**: 必须在 capture phase 抢先处理 Tab 键
5. **ghost text 生命周期**: 先读 `dataset.text` 和 `dataset.offset`，再 `remove()` DOM 元素
6. **设置升级兼容**: 用户已有设置中的空字符串不应覆盖新版本的默认值（`mergeModelConfig` 非空策略）
7. **insertText 兼容 Slate**: 用 `InputEvent('beforeinput', { inputType: 'insertText' })`，不能只用 `execCommand`

### 待完成事项
- [ ] 百度知识库**编辑模式**完整测试（CSS 选择器已基于诊断日志重写）
- [x] popup.html footer 版本号与 manifest 同步
- [ ] 后续可能增加飞书、CSDN 等站点适配器
- [ ] Word Add-in / WPS 插件适配器（远期）
- [ ] 本地模型支持（Ollama）
- [ ] 自定义 System Prompt

---

## 11. 用户偏好与约束

- **不要内置默认 API URL / SK** — 首次使用通过引导页让用户配置
- **打包好 zip 放 workspace 里**，用户自己下载
- **不要用如流发文件附件**（发不了）
- 用户习惯中文沟通

---

## 12. 文件快速索引

| 要改什么 | 看哪个文件 |
|----------|-----------|
| 默认模型/API 配置 | `src/shared/types/index.ts` → `DEFAULT_SETTINGS` |
| 添加新站点适配器 | `src/adapters/sites/` 新建文件 + `content/index.ts` 注册 |
| 百度知识库选择器 | `src/adapters/sites/baidu-ku.ts` |
| 自动补全 prompt | `src/core/autocomplete/engine.ts` → `buildPrompt()` |
| Agent system prompt | `src/core/agent/system.ts` → `buildChatMessages()` |
| 审稿分析 prompt | `src/core/review/engine.ts` → `buildAnalysisPrompt()` |
| 键盘快捷键 | `src/content/index.ts` → `setupKeyboardShortcuts()` |
| 悬浮窗 UI | `src/content/floating-panel/controller.ts` |
| 右键菜单命令执行 | `src/content/command-palette/controller.ts` |
| 所有 CSS 样式 | `src/content/styles.ts` |
| 构建配置 | `vite.config.ts` + `scripts/build.sh` |
| 扩展 manifest | `public/manifest.json` |
| Chrome 消息处理 | `src/background/index.ts` |
| 设置存储/合并 | `src/shared/storage/settings.ts` |
| Ghost text 插入/采纳 | `src/adapters/chrome/adapter.ts` → `acceptGhostText()` |
| 版本号 | `package.json` + `public/manifest.json` + `src/popup/popup.html` footer |

---

## 13. 数据流速查

### 自动补全
```
用户输入 → ContentChange callback → debounce(400ms)
  → AutocompleteController.triggerAutocomplete()
  → chrome.runtime.sendMessage(AUTOCOMPLETE_REQUEST)
  → Background: AutocompleteEngine.suggest()
  → ModelProvider.streamToString('smart', ...)
  → API: /chat/completions (stream)
  → 返回 AutocompleteResult
  → showGhostText() → 灰色文本显示
  → 用户按 Tab → acceptGhostText() → insertViaInputEvent()
```

### Agent Chat
```
用户在悬浮窗输入 → FloatingPanelController.send()
  → getPageContext() → fullText + 光标上下文
  → chrome.runtime.sendMessage(AGENT_MESSAGE)
  → Background: AgentSystem.chat()
  → buildChatMessages() → system prompt + fullText + 历史
  → ModelProvider.streamToString('smart', ...)
  → 返回 AgentMessage
  → addChatMessage() → 渲染到聊天窗口
```

### 审稿
```
用户点 Review → ReviewOverlayController.startReview()
  → chrome.runtime.sendMessage(REVIEW_REQUEST)
  → Background: ReviewEngine.analyze()
  → ModelProvider.complete('smart', ...)
  → 返回 JSON 数组 → parseReviewPoints()
  → ReviewSession(ReviewPoint[]) 返回 Content Script
  → renderOverlay() + renderStatusBar()
  → Tab 采纳 → replaceRange() | Esc 拒绝 → 跳过
```
