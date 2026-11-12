# Doc Copilot - Architecture Design

## 1. 分层架构

```
┌─────────────────────────────────────────────────────┐
│                   Platform Layer                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │  Chrome   │  │  Word    │  │  WPS     │  (future)│
│  │ Extension │  │  Add-in  │  │  Plugin  │          │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘          │
│       │              │              │                │
├───────┴──────────────┴──────────────┴───────────────┤
│                   Adapter Layer                      │
│  ┌──────────────────────────────────────────┐       │
│  │  IDocumentAdapter                         │       │
│  │  - getText(): string                      │       │
│  │  - getCursorPosition(): Position          │       │
│  │  - insertText(pos, text): void            │       │
│  │  - replaceRange(range, text): void        │       │
│  │  - showGhostText(pos, text): void         │       │
│  │  - removeGhostText(): void                │       │
│  │  - getContext(cursorPos): DocContext       │       │
│  │  - onContentChange(cb): Disposable        │       │
│  │  - onCursorChange(cb): Disposable         │       │
│  └──────────────────────────────────────────┘       │
│                                                      │
├──────────────────────────────────────────────────────┤
│                    Core Layer                        │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐      │
│  │ Autocomplete│ │  Review    │ │   Agent    │      │
│  │   Engine   │ │  Engine    │ │   System   │      │
│  └─────┬──────┘ └─────┬──────┘ └─────┬──────┘      │
│        │               │               │             │
│  ┌─────┴───────────────┴───────────────┴──────┐     │
│  │           Model Provider (Multi-Model)      │     │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐    │     │
│  │  │  Fast   │  │  Smart  │  │  Image  │    │     │
│  │  │(autocmp)│  │ (agent) │  │ (vision)│    │     │
│  │  └─────────┘  └─────────┘  └─────────┘    │     │
│  └────────────────────────────────────────────┘     │
│                                                      │
├──────────────────────────────────────────────────────┤
│                   Storage Layer                      │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐      │
│  │  Settings  │ │   Cache    │ │  History   │      │
│  │(chrome.    │ │(IndexedDB) │ │(IndexedDB) │      │
│  │ storage)   │ │            │ │            │      │
│  └────────────┘ └────────────┘ └────────────┘      │
└──────────────────────────────────────────────────────┘
```

## 2. 核心模块

### 2.1 Model Provider (多模型支持)
- **Fast Model**: 用于自动补全 (如 GPT-3.5-turbo / 本地模型)，追求低延迟
- **Smart Model**: 用于 Agent 对话、审稿、纠错等复杂任务 (如 GPT-4 / Claude)
- **Image Model**: 用于视觉识别、插图生成等图像相关任务 (如 GPT-4-vision / Gemini-vision)
- 所有模型使用 OpenAI 兼容格式 (base_url + api_key + model_name)

### 2.2 Autocomplete Engine
- Debounce 输入 (300-500ms)
- 上下文窗口: 光标前后各 ~500 字符
- 流式输出 → 灰色 ghost text
- Tab 采纳, Esc 取消
- 缓存最近补全结果

### 2.3 Review Engine (审稿模式)
- 接收原文和修改建议列表
- 每个建议是一个 "采纳点" (ReviewPoint)
- 支持:
  - Tab: 采纳当前
  - Esc: 放弃当前
  - ↑/↓ 或 Ctrl+↑/↓: 上一个/下一个
  - Ctrl+Shift+A: 全部采纳
  - Ctrl+Shift+R: 全部放弃
- 视觉效果: 删除线(旧) + 绿色高亮(新)

### 2.4 Agent System
- 工具集: 总结、翻译、改写、扩写、润色、格式化、解释等
- 对话历史记忆 (session 内)
- 流式回复
- 支持自定义 system prompt

## 3. UI 组件

### 3.1 Command Palette (`\` 触发)
- 快速命令: /fix, /rewrite, /translate, /summarize, /expand...
- 模糊搜索命令列表
- 选中文本时自动作为上下文

### 3.2 Floating Panel (悬浮窗)
- 可拖拽、可调整大小
- Tabs: Chat | Review | Settings
- Chat: Agent 对话界面
- Review: 审稿建议列表
- Settings: API 配置、功能开关

### 3.3 Ghost Text (自动补全)
- 灰色半透明文本
- 紧跟光标位置
- Tab 采纳, Esc/继续输入 消失

## 4. 数据流

```
用户输入 → Content Script 监听
         → Debounce (300ms)
         → 提取上下文 (前后文 + 选中文本)
         → 发送到 Background Service Worker
         → 调用对应 Model Provider
         → 流式返回
         → Content Script 渲染 (ghost text / review overlay)
```

## 5. 跨平台扩展策略

```typescript
// 未来只需实现新的 Adapter
interface IDocumentAdapter {
  readonly platform: 'chrome' | 'word' | 'wps';
  getText(): string;
  getSelectedText(): string;
  getCursorPosition(): Position;
  insertText(position: Position, text: string): void;
  replaceRange(range: Range, text: string): void;
  showGhostText(position: Position, text: string): void;
  removeGhostText(): void;
  getContext(cursorPos: Position, windowSize?: number): DocumentContext;
  onContentChange(callback: (change: ContentChange) => void): Disposable;
  onCursorChange(callback: (pos: Position) => void): Disposable;
}
```
