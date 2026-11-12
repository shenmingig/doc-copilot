# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Doc Copilot is an AI-powered writing assistant Chrome Extension that provides autocomplete, review mode, and agent chat for any web-based document editor (Google Docs, Notion, Feishu/如流, Yuque, etc.). It uses a multi-model architecture with OpenAI-compatible APIs.

## Build & Development Commands

```bash
# Install dependencies
pnpm install

# Build the extension (3-pass build: content → background → popup)
pnpm build

# Build and watch for changes (requires chokidar-cli)
pnpm dev

# Type checking only
pnpm typecheck

# Clean build artifacts
pnpm clean
```

### Loading in Chrome

After building:
1. Open `chrome://extensions`
2. Enable Developer Mode
3. Click "Load unpacked"
4. Select the `dist/` folder

### Build System

The project uses a **3-pass Vite build** (`scripts/build.sh`) with `BUILD_TARGET` environment variable:
- Pass 1: `content` - Content script (page injection)
- Pass 2: `background` - Service worker
- Pass 3: `popup` - Extension popup + static file copying

Each target is built as a **self-contained IIFE bundle** (no dynamic imports). Configuration in `vite.config.ts` maps `BUILD_TARGET` to the appropriate entry point.

## Architecture

### Layered Architecture

```
Platform Layer (Chrome Extension)
    ↓
Adapter Layer (IDocumentAdapter - unified document operations)
    ↓
Core Layer (Autocomplete / Review / Agent engines)
    ↓
Model Provider (single Smart text model - OpenAI-compatible)
```

### Key Abstractions

**`IDocumentAdapter`** (`src/adapters/base/adapter.ts`)
- Unified interface for document operations across platforms
- Handles `contentEditable`, `textarea`, and `input` elements
- Provides: `getText()`, `getCursorPosition()`, `insertText()`, `replaceRange()`, `showGhostText()`, `removeGhostText()`, `acceptGhostText()`
- Event listeners: `onContentChange()`, `onCursorChange()`
- Chrome implementation: `src/adapters/chrome/adapter.ts`

**Site Adapter System** (`src/adapters/sites/`)
- Platform-specific content extraction and editor detection
- `ISiteAdapter` interface with `extractContent()` and `observe()` methods
- Registry pattern (`registry.ts`) matches URL patterns to appropriate adapters
- Specific adapters (e.g., `baidu-ku.ts` for Baidu Wenku) and generic fallback (`generic.ts`)

**Model Provider** (`src/core/models/provider.ts`)
- Multi-model support with three roles:
  - **Smart**: Shared text model for autocomplete, chat, and review
  - **Smart**: Complex tasks and agent chat (e.g., GPT-4, Claude)
  - **Image**: Vision and illustration capabilities (e.g., GPT-4-vision, Gemini-vision)
- OpenAI-compatible API format (custom base URL + API key + model ID)
- Streaming and non-streaming completions
- Token usage tracking per role
- Abort controller for canceling requests

### Core Engines

**Autocomplete Engine** (`src/core/autocomplete/engine.ts`)
- Debounced input (300-500ms configurable)
- Context window: ~800 chars before/after cursor
- Streaming response → ghost text (gray inline suggestion)
- Keyboard: `Tab` to accept, `Esc` to cancel
- Caching for recent completions

**Review Engine** (`src/core/review/engine.ts`)
- Multi-point review mode with accept/reject workflow
- Each `ReviewPoint` has: `originalRange`, `originalText`, `suggestedText`, `reason`, `category`
- Visual: strikethrough (old) + green highlight (new)
- Keyboard: `Tab` accept current, `Esc` reject current, `Ctrl+↑/↓` navigate, `Ctrl+Shift+A` accept all, `Ctrl+Shift+R` reject all

**Agent System** (`src/core/agent/system.ts`)
- Built-in tools: summarize, translate, rewrite, expand, polish, format, explain
- Conversation history within session
- Streaming replies
- Supports custom system prompts

### UI Components

**Content Script** (`src/content/index.ts`)
- Main entry point, injected into all pages
- Manages: autocomplete controller, review overlay, command palette, floating panel
- Focus tracking to auto-attach adapter to editable elements
- Keyboard shortcut handling

**Command Palette** (`src/content/command-palette/`)
- Triggered by `\` at line start or after space
- Quick commands: `/fix`, `/rewrite`, `/translate`, `/summarize`, `/expand`
- Fuzzy search
- Uses selected text as context

**Floating Panel** (`src/content/floating-panel/`)
- Draggable, resizable panel
- Three tabs: Chat (agent), Review (suggestions), Settings (API config)
- Keyboard: `Alt+Shift+D` to toggle visibility

**Ghost Text** (implemented in adapter)
- Semi-transparent gray text following cursor
- Inserted as temporary DOM element
- Removed on `Esc` or continued typing

## Important Implementation Patterns

### Message Passing (Chrome Extension)

Communication between content script and background service worker uses `chrome.runtime.sendMessage` with typed messages (`ExtensionMessage<T>`). Message types defined in `src/shared/types/index.ts`:
- `AUTOCOMPLETE_REQUEST/RESPONSE`
- `REVIEW_REQUEST/RESPONSE`
- `AGENT_MESSAGE/RESPONSE`
- `AGENT_STREAM_CHUNK/END`
- `GET_SETTINGS/UPDATE_SETTINGS/SETTINGS_CHANGED`

Background script (`src/background/index.ts`) handles API calls and streams responses back to content script.

### Settings Storage

`src/shared/storage/settings.ts` wraps `chrome.storage.sync` with:
- Default settings in `DEFAULT_SETTINGS` leave API URL / SK empty and guide the user through setup
- `settingsStorage.get()`, `settingsStorage.set()`, `settingsStorage.onChange()`
- Settings include: model configs (3 roles), feature toggles, debounce timing, context window size

### TypeScript Types

All shared types in `src/shared/types/index.ts`:
- `Position`, `Range`, `DocumentContext`, `ContentChange`
- `ModelRole`, `ModelConfig`, `ChatMessage`, `CompletionRequest/Response`, `StreamChunk`
- `AutocompleteResult`, `ReviewPoint`, `ReviewSession`
- `AgentTool`, `AgentMessage`, `AgentSession`

### Ghost Text Implementation

The Chrome adapter creates ghost text by:
1. Calculating cursor position via `Range` and `getBoundingClientRect()`
2. Inserting an absolutely positioned `<span>` with class `doc-copilot-ghost-text`
3. Styling with gray color (`#888`), transparent background, pointer-events-none
4. Removing on accept (inserting real text) or cancel

For `contentEditable`, insertion uses `Range.insertNode()`. For `textarea/input`, it uses value manipulation with `setSelectionRange()`.

## Platform Support

Currently supports all websites via `contentEditable`, `textarea`, and `input` detection. Tested with:
- Feishu/Lark (如流/飞书)
- Google Docs
- Notion
- Yuque (语雀)
- Tencent Docs (腾讯文档)
- Shimo Docs (石墨文档)
- Confluence
- Any standard HTML forms

Site-specific adapters can be added to `src/adapters/sites/` for enhanced features (e.g., precise cursor positioning in complex editors).

## Development Notes

- All builds target Chrome 110+ (Manifest V3)
- Service Worker (background script) instead of persistent background page
- No sourcemaps in production builds; inline sourcemaps in development
- Path aliases: `@` → `src/`, `@core` → `src/core/`, `@adapters` → `src/adapters/`
- CSS injected programmatically via `src/content/styles.ts` (no separate CSS files)

## Future Extension Plans

- Word Add-in adapter (Office.js)
- WPS Plugin adapter
- Feishu/Lark native adapter (precise cursor API)
- Local model support (Ollama)
- Custom system prompts
- Multi-language UI
