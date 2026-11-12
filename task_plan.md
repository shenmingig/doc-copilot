# Doc Copilot - Chrome Extension

## Goal
Build a document-domain Copilot as a Chrome extension with autocomplete, review mode, error correction, agent capabilities, and extensible architecture for future Word/WPS support.

## Phases

### Phase 1: Architecture & Project Scaffold [in_progress]
- [ ] Design layered architecture (core → adapter → platform)
- [ ] Create Chrome extension manifest v3 scaffold
- [ ] Set up build tooling (Vite + TypeScript)
- [ ] Create project structure

### Phase 2: Core Engine [pending]
- [ ] Document analysis engine (context extraction)
- [ ] Multi-model provider (OpenAI-compatible API)
- [ ] Autocomplete engine with debounce/caching
- [ ] Correction/rewrite engine
- [ ] Agent framework

### Phase 3: Chrome Extension UI [pending]
- [ ] `\` command palette (slash command)
- [ ] Floating panel (draggable)
- [ ] Settings panel (API config, toggle features)
- [ ] Inline ghost text (gray autocomplete like Copilot)
- [ ] Review mode UI (accept/reject per suggestion)

### Phase 4: Content Script & Page Integration [pending]
- [ ] contentEditable / textarea / input detection
- [ ] Cursor position tracking
- [ ] Ghost text injection
- [ ] Review mode overlay with accept/reject controls

### Phase 5: Agent System [pending]
- [ ] Tool definitions (search, summarize, rewrite, translate, etc.)
- [ ] Conversation memory
- [ ] Streaming responses in floating panel

### Phase 6: Polish & Testing [pending]
- [ ] Keyboard shortcuts (Tab accept, Esc reject, ↑↓ navigate)
- [ ] Performance optimization
- [ ] Error handling
- [ ] README & documentation

## Key Design Decisions
- Manifest V3 (Chrome extension)
- TypeScript + Vite for build
- Shadow DOM for UI isolation
- Adapter pattern for future Word/WPS support
- OpenAI-compatible API format for model providers
