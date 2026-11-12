// ============================================================
// Styles - Injected into page via JS
// ============================================================

export function injectStyles(): void {
  if (document.getElementById('doc-copilot-styles')) return;

  const style = document.createElement('style');
  style.id = 'doc-copilot-styles';
  style.textContent = CSS_TEXT;
  document.head.appendChild(style);
}

const CSS_TEXT = `
/* ============================================
   Doc Copilot Styles — Clean & Minimal
   ============================================ */

/* --- Variables --- */
#doc-copilot-root {
  --dc-bg: #ffffff;
  --dc-bg-secondary: #f7f7f8;
  --dc-bg-hover: #f0f0f1;
  --dc-border: #e5e5e5;
  --dc-text: #1a1a1a;
  --dc-text-secondary: #666666;
  --dc-text-muted: #999999;
  --dc-accent: #5b5fc7;
  --dc-accent-light: #ededfc;
  --dc-user-bubble: #5b5fc7;
  --dc-user-text: #ffffff;
  --dc-ai-bubble: #f0f0f1;
  --dc-ai-text: #1a1a1a;
  --dc-radius: 12px;
  --dc-radius-sm: 8px;
  --dc-shadow: 0 8px 40px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08);
  --dc-shadow-sm: 0 2px 12px rgba(0,0,0,0.1);
  --dc-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --dc-z: 2147483640;
}

/* --- Floating Bubble --- */
.dc-bubble {
  position: fixed;
  bottom: 24px;
  right: 24px;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--dc-accent);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: var(--dc-z);
  box-shadow: 0 4px 16px rgba(91,95,199,0.4);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
  user-select: none;
  -webkit-user-select: none;
}
.dc-bubble:hover {
  transform: scale(1.08);
  box-shadow: 0 6px 24px rgba(91,95,199,0.5);
}
.dc-bubble-active {
  transform: scale(0.92);
  box-shadow: 0 2px 8px rgba(91,95,199,0.3);
}
.dc-bubble-icon {
  font-size: 22px;
  line-height: 1;
}

/* --- Panel --- */
.dc-panel {
  position: fixed;
  bottom: 84px;
  right: 24px;
  width: 380px;
  height: 540px;
  z-index: var(--dc-z);
  background: var(--dc-bg);
  border-radius: 16px;
  box-shadow: var(--dc-shadow);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-family: var(--dc-font);
  font-size: 14px;
  color: var(--dc-text);
  border: 1px solid var(--dc-border);
  resize: none;
  min-width: 320px;
  min-height: 360px;
}

.dc-panel-resizing {
  transition: none !important;
}

.dc-resize-handle {
  position: absolute;
  z-index: 20;
  background: transparent;
}
.dc-resize-n,
.dc-resize-s {
  left: 12px;
  right: 12px;
  height: 8px;
  cursor: ns-resize;
}
.dc-resize-n { top: 0; }
.dc-resize-s { bottom: 0; }
.dc-resize-e,
.dc-resize-w {
  top: 12px;
  bottom: 12px;
  width: 8px;
  cursor: ew-resize;
}
.dc-resize-e { right: 0; }
.dc-resize-w { left: 0; }
.dc-resize-ne,
.dc-resize-se,
.dc-resize-sw,
.dc-resize-nw {
  width: 16px;
  height: 16px;
}
.dc-resize-ne {
  top: 0;
  right: 0;
  cursor: nesw-resize;
}
.dc-resize-se {
  right: 0;
  bottom: 0;
  cursor: nwse-resize;
}
.dc-resize-sw {
  left: 0;
  bottom: 0;
  cursor: nesw-resize;
}
.dc-resize-nw {
  top: 0;
  left: 0;
  cursor: nwse-resize;
}

/* Panel Header */
.dc-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--dc-bg);
  border-bottom: 1px solid var(--dc-border);
  cursor: move;
  user-select: none;
  flex-shrink: 0;
}
.dc-panel-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--dc-text);
  letter-spacing: -0.01em;
}
.dc-panel-actions {
  display: flex;
  gap: 4px;
}
.dc-panel-btn {
  background: none;
  border: none;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--dc-text-muted);
  transition: background 0.15s, color 0.15s;
}
.dc-panel-btn:hover {
  background: var(--dc-bg-hover);
  color: var(--dc-text);
}
.dc-panel-btn-active {
  background: var(--dc-accent-light);
  color: var(--dc-accent);
}

/* Chat Bar */
.dc-chat-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px 8px 16px;
  border-bottom: 1px solid var(--dc-border);
  background: var(--dc-bg);
  flex-shrink: 0;
}
.dc-chat-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dc-text);
}
.dc-chat-bar-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

/* Body */
.dc-panel-body {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
/* --- Chat Tab --- */
.dc-chat {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.dc-chat-messages {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.dc-chat-messages::-webkit-scrollbar {
  width: 4px;
}
.dc-chat-messages::-webkit-scrollbar-thumb {
  background: #d0d0d0;
  border-radius: 2px;
}

/* Welcome */
.dc-chat-welcome {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px 20px;
  text-align: center;
}
.dc-chat-welcome-icon {
  font-size: 32px;
  color: var(--dc-accent);
  opacity: 0.6;
}
.dc-chat-welcome-text {
  font-size: 13px;
  color: var(--dc-text-muted);
  line-height: 1.5;
}
.dc-chat-welcome-text strong,
.dc-chat-welcome-text span {
  display: block;
}
.dc-chat-welcome-text strong {
  color: var(--dc-text);
  font-size: 13px;
  margin-bottom: 3px;
}
.dc-onboarding-btn {
  margin-top: 4px;
  padding: 7px 12px;
  border: none;
  border-radius: 7px;
  background: var(--dc-accent);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  font-family: var(--dc-font);
  cursor: pointer;
}
.dc-onboarding-btn:hover {
  background: #4a4eb3;
}

/* Message Bubbles */
.dc-msg {
  display: flex;
  min-width: 0;
  animation: dc-msg-in 0.2s ease;
}
@keyframes dc-msg-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
.dc-msg-user {
  align-self: stretch;
  justify-content: flex-end;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  padding-left: 12%;
  box-sizing: border-box;
}
.dc-msg-assistant,
.dc-msg-system {
  align-self: stretch;
  width: 100%;
  max-width: 100%;
}

.dc-msg-bubble {
  padding: 10px 14px;
  border-radius: 16px;
  font-size: 13px;
  line-height: 1.6;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
  overflow-wrap: anywhere;
  word-break: break-word;
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
  white-space: normal;
}
.dc-msg-bubble-user {
  background: var(--dc-user-bubble);
  color: var(--dc-user-text);
  border-bottom-right-radius: 4px;
  max-width: 100%;
}
.dc-msg-bubble-user > * {
  max-width: 100%;
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.dc-msg-bubble-user > :first-child { margin-top: 0 !important; }
.dc-msg-bubble-user > :last-child { margin-bottom: 0 !important; }
.dc-msg-bubble-user .dc-p {
  color: inherit;
}
.dc-msg-bubble-ai {
  background: transparent;
  color: var(--dc-ai-text);
  border: none;
  border-radius: 0;
  box-shadow: none;
  width: 100%;
}
.dc-msg-images {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 8px;
  margin-bottom: 8px;
}
.dc-msg-image {
  display: block;
  width: 100%;
  max-height: 180px;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.28);
}
.dc-msg-bubble-ai .dc-msg-image {
  border-color: rgba(0,0,0,0.08);
}

/* Code in bubbles */
.dc-inline-code {
  background: rgba(0,0,0,0.06);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 12px;
  font-family: "SF Mono", Monaco, Consolas, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.dc-msg-bubble-user .dc-inline-code {
  background: rgba(255,255,255,0.2);
}
.dc-code-block {
  background: rgba(0,0,0,0.05);
  border-radius: 6px;
  padding: 8px 10px;
  margin: 6px 0;
  overflow-x: auto;
  max-width: 100%;
  box-sizing: border-box;
  font-size: 12px;
  font-family: "SF Mono", Monaco, Consolas, monospace;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dc-msg-bubble-user .dc-code-block {
  background: rgba(255,255,255,0.15);
}

/* Code language label */
.dc-code-lang {
  display: inline-block;
  font-size: 10px;
  color: rgba(0,0,0,0.4);
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

/* Markdown elements in bubbles */
.dc-msg-bubble h1,
.dc-msg-bubble h2,
.dc-msg-bubble h3,
.dc-msg-bubble h4,
.dc-msg-bubble h5,
.dc-msg-bubble h6 {
  margin: 12px 0 8px 0;
  font-weight: 600;
  line-height: 1.3;
}
.dc-msg-bubble h1:first-child,
.dc-msg-bubble h2:first-child,
.dc-msg-bubble h3:first-child,
.dc-msg-bubble h4:first-child,
.dc-msg-bubble h5:first-child,
.dc-msg-bubble h6:first-child { margin-top: 0; }

.dc-msg-bubble .dc-h1 { font-size: 1.6em; border-bottom: 2px solid rgba(0,0,0,0.1); padding-bottom: 4px; }
.dc-msg-bubble .dc-h2 { font-size: 1.4em; border-bottom: 1px solid rgba(0,0,0,0.08); padding-bottom: 3px; }
.dc-msg-bubble .dc-h3 { font-size: 1.2em; }
.dc-msg-bubble .dc-h4 { font-size: 1.1em; }
.dc-msg-bubble .dc-h5 { font-size: 1.05em; }
.dc-msg-bubble .dc-h6 { font-size: 1em; opacity: 0.9; }

.dc-msg-bubble .dc-ul,
.dc-msg-bubble .dc-ol {
  margin: 8px 0;
  padding-left: 24px;
}
.dc-msg-bubble .dc-li {
  margin: 4px 0;
  line-height: 1.6;
}

.dc-msg-bubble .dc-blockquote {
  margin: 8px 0;
  padding: 8px 12px;
  border-left: 3px solid rgba(0,0,0,0.15);
  background: rgba(0,0,0,0.03);
  border-radius: 0 4px 4px 0;
  font-style: italic;
  color: rgba(0,0,0,0.7);
}
.dc-msg-bubble-user .dc-blockquote {
  background: rgba(255,255,255,0.15);
  border-left-color: rgba(255,255,255,0.3);
  color: rgba(255,255,255,0.9);
}

.dc-msg-bubble .dc-hr {
  margin: 12px 0;
  border: none;
  border-top: 1px solid rgba(0,0,0,0.1);
}

.dc-msg-bubble .dc-link {
  color: #5b5fc7;
  text-decoration: underline;
  text-decoration-style: dotted;
  text-underline-offset: 2px;
}
.dc-msg-bubble .dc-link:hover {
  text-decoration-style: solid;
  color: #4a4eb0;
}
.dc-msg-bubble-user .dc-link {
  color: rgba(255,255,255,0.95);
  text-decoration-color: rgba(255,255,255,0.5);
}

.dc-msg-bubble .dc-img {
  max-width: 100%;
  height: auto;
  border-radius: 6px;
  margin: 8px 0;
  display: block;
}

.dc-msg-bubble .dc-table {
  width: 100%;
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 12px;
  border-radius: 6px;
  overflow: hidden;
  table-layout: fixed;
}
.dc-msg-bubble .dc-th,
.dc-msg-bubble .dc-td {
  padding: 6px 10px;
  border: 1px solid rgba(0,0,0,0.1);
  text-align: left;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.dc-msg-bubble .dc-th {
  background: rgba(0,0,0,0.05);
  font-weight: 600;
}
.dc-msg-bubble-user .dc-th {
  background: rgba(255,255,255,0.15);
  border-color: rgba(255,255,255,0.2);
}
.dc-msg-bubble-user .dc-td {
  border-color: rgba(255,255,255,0.15);
}

/* Refined Markdown rhythm for assistant responses */
.dc-msg-bubble-ai {
  padding: 2px 0 0;
  font-size: 12.5px;
  line-height: 1.68;
}

.dc-msg-bubble-ai > :first-child { margin-top: 0 !important; }
.dc-msg-bubble-ai > :last-child { margin-bottom: 0 !important; }

.dc-msg-bubble .dc-p {
  margin: 8px 0;
}

.dc-msg-bubble-ai .dc-p {
  color: #202124;
}

.dc-msg-bubble .dc-md-gap {
  height: 8px;
}

.dc-msg-bubble-ai strong {
  font-weight: 700;
  color: #111827;
}

.dc-msg-bubble-ai .dc-h1,
.dc-msg-bubble-ai .dc-h2,
.dc-msg-bubble-ai .dc-h3,
.dc-msg-bubble-ai .dc-h4,
.dc-msg-bubble-ai .dc-h5,
.dc-msg-bubble-ai .dc-h6 {
  margin: 12px 0 6px;
  padding: 0;
  border: 0;
  color: #111827;
  line-height: 1.32;
  letter-spacing: 0;
}

.dc-msg-bubble-ai .dc-h1 { font-size: 15px; font-weight: 750; }
.dc-msg-bubble-ai .dc-h2 { font-size: 14px; font-weight: 730; }
.dc-msg-bubble-ai .dc-h3,
.dc-msg-bubble-ai .dc-h4,
.dc-msg-bubble-ai .dc-h5,
.dc-msg-bubble-ai .dc-h6 { font-size: 13px; font-weight: 700; }

.dc-msg-bubble-ai .dc-ul,
.dc-msg-bubble-ai .dc-ol {
  margin: 8px 0 10px;
  padding-left: 22px;
}

.dc-msg-bubble-ai .dc-li {
  margin: 6px 0;
  padding-left: 2px;
}

.dc-msg-bubble-ai .dc-li br {
  display: block;
  content: "";
  margin-top: 4px;
}

.dc-msg-bubble-ai .dc-li::marker {
  color: #6b6fd6;
  font-weight: 700;
}

.dc-msg-bubble-ai .dc-li > strong:first-child {
  display: inline;
  margin-bottom: 0;
  font-size: inherit;
  line-height: inherit;
}

.dc-msg-bubble-ai .dc-blockquote {
  margin: 8px 0;
  padding: 8px 10px;
  border-left: 3px solid #8b8ee8;
  background: #f0f1ff;
  border-radius: 0 8px 8px 0;
  color: #374151;
  font-style: normal;
}

.dc-msg-bubble-ai .dc-inline-code {
  background: #eceef8;
  color: #3840a8;
  border: 1px solid #dde0f3;
  padding: 1px 5px;
  font-size: 11.5px;
}

.dc-msg-bubble-ai .dc-code-block {
  margin: 8px 0;
  padding: 9px 10px;
  background: #151821;
  color: #eef2ff;
  border-radius: 8px;
  border: 1px solid #242938;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
  font-size: 11.5px;
}

.dc-msg-bubble-ai .dc-code-lang {
  color: #9ca3af;
}

.dc-msg-bubble-ai .dc-table {
  margin: 8px 0;
  font-size: 11.5px;
  border: 1px solid #e4e6f0;
  border-radius: 8px;
  overflow: hidden;
  background: #fff;
}

.dc-msg-bubble-ai .dc-th {
  background: #f2f3fb;
  color: #374151;
}

.dc-msg-bubble-ai .dc-th,
.dc-msg-bubble-ai .dc-td {
  border-color: #e4e6f0;
}

.dc-msg-bubble-ai .dc-link {
  color: #4f55c7;
  text-decoration-thickness: 1px;
}

/* Typing indicator */
.dc-typing-dots {
  display: flex;
  gap: 4px;
  padding: 4px 0;
}
.dc-typing-dots span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dc-text-muted);
  animation: dc-dot-bounce 1.2s infinite;
}
.dc-typing-dots span:nth-child(2) { animation-delay: 0.2s; }
.dc-typing-dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes dc-dot-bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30% { transform: translateY(-4px); opacity: 1; }
}
.dc-typing-status {
  font-size: 12px;
  color: var(--dc-text-muted);
  animation: dc-status-fade 0.3s ease;
}
@keyframes dc-status-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* Chat Input */
.dc-chat-input-area {
  padding: 12px 16px;
  border-top: 1px solid var(--dc-border);
  flex-shrink: 0;
}
.dc-chat-attachments {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.dc-chat-attachment {
  position: relative;
  width: 54px;
  height: 54px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--dc-border);
  background: var(--dc-bg-secondary);
}
.dc-chat-attachment img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.dc-chat-attachment-remove {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 50%;
  background: rgba(17, 24, 39, 0.72);
  color: #fff;
  cursor: pointer;
  font-size: 13px;
  line-height: 18px;
  padding: 0;
}
.dc-chat-input-wrapper {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  background: var(--dc-bg-secondary);
  border-radius: 20px;
  padding: 6px 6px 6px 14px;
  border: 1px solid var(--dc-border);
  transition: border-color 0.15s;
}
.dc-chat-input-wrapper:focus-within {
  border-color: var(--dc-accent);
}
.dc-chat-file {
  display: none !important;
  position: fixed !important;
  left: -9999px !important;
  top: 0 !important;
  width: 1px !important;
  height: 1px !important;
  opacity: 0 !important;
  pointer-events: none !important;
  visibility: hidden !important;
}
.dc-chat-attach {
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  color: var(--dc-text-muted);
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 0.15s, color 0.15s;
}
.dc-chat-attach:hover {
  background: var(--dc-bg-hover);
  color: var(--dc-accent);
}
.dc-chat-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 13px;
  font-family: var(--dc-font);
  color: var(--dc-text);
  resize: none;
  max-height: 120px;
  line-height: 1.5;
  padding: 4px 0;
}
.dc-chat-input::placeholder {
  color: var(--dc-text-muted);
}
.dc-chat-send {
  width: 32px;
  height: 32px;
  border: none;
  background: var(--dc-accent);
  color: #fff;
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 0.15s, transform 0.1s;
}
.dc-chat-send:hover {
  background: #4a4eb3;
}
.dc-chat-send:active {
  transform: scale(0.92);
}

/* --- Panel Footer (Token Usage) --- */
.dc-panel-footer {
  padding: 6px 12px;
  border-top: 1px solid var(--dc-border);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  min-width: 0;
}
.dc-status-line {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  color: #6b7280;
  font-size: 11px;
  line-height: 1.2;
  white-space: nowrap;
  cursor: default;
  --dc-status-fill: #2f9e44;
  --dc-status-track: #d5e8d8;
}
.dc-status-line[data-level="mid"] {
  --dc-status-fill: #d9971f;
  --dc-status-track: #f3e4c4;
}
.dc-status-line[data-level="high"] {
  --dc-status-fill: #d64545;
  --dc-status-track: #f6d4d4;
}
.dc-status-model {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1 1 auto;
}
.dc-status-context,
.dc-status-pct,
.dc-status-sep {
  flex: 0 0 auto;
}
.dc-status-sep {
  color: #c5c5cc;
}
.dc-status-pct {
  font-variant-numeric: tabular-nums;
  color: #374151;
}
.dc-status-context {
  font-variant-numeric: tabular-nums;
}
.dc-status-bar {
  position: relative;
  width: 72px;
  height: 10px;
  flex: 0 0 72px;
  background: repeating-linear-gradient(90deg, var(--dc-status-track) 0 2px, transparent 2px 4px);
}
.dc-status-bar-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 0;
  background: repeating-linear-gradient(90deg, var(--dc-status-fill) 0 2px, transparent 2px 4px);
}
.dc-context-tooltip {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  width: 196px;
  padding: 8px 10px;
  background: #1f1f23;
  color: #f4f4f6;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  font-size: 11px;
  line-height: 1.4;
  white-space: normal;
  z-index: 20;
  pointer-events: none;
}
.dc-context-tooltip[hidden] {
  display: none;
}
.dc-context-tooltip-title {
  margin: 6px 0 2px;
  color: #bdbdc7;
  font-size: 10px;
  font-weight: 650;
}
.dc-context-tooltip-title:first-child {
  margin-top: 0;
}
.dc-context-tooltip-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-variant-numeric: tabular-nums;
}
.dc-context-tooltip-row span:first-child {
  color: #d5d5dc;
}
.dc-context-tooltip-note {
  margin-top: 6px;
  color: #a9a9b3;
  font-size: 10px;
  line-height: 1.45;
}

/* --- Function Menu --- */
.dc-function-menu {
  position: absolute;
  top: 48px;
  right: 76px;
  width: 188px;
  background: var(--dc-bg);
  border: 1px solid var(--dc-border);
  border-radius: var(--dc-radius-sm);
  box-shadow: var(--dc-shadow-lg);
  z-index: 12;
  overflow: hidden;
}
.dc-function-list {
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.dc-function-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 8px 9px;
  border: none;
  border-radius: 6px;
  background: transparent;
  font-family: var(--dc-font);
  cursor: pointer;
  text-align: left;
  transition: background 0.15s, color 0.15s;
}
.dc-function-item:hover {
  background: var(--dc-bg-secondary);
}
.dc-function-item:active {
  background: var(--dc-accent-light);
}
.dc-function-item-icon {
  font-size: 15px;
  flex-shrink: 0;
  width: 18px;
  text-align: center;
}
.dc-function-item-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--dc-text);
}
.dc-function-status {
  padding: 7px 9px 8px;
  font-size: 11px;
  line-height: 1.35;
  color: var(--dc-text-muted);
  border-top: 1px solid var(--dc-border);
  transition: color 0.15s;
}
.dc-function-status-ok { color: #059669; }
.dc-function-status-error { color: #dc2626; }

/* --- Settings Drawer (overlay on panel) --- */
.dc-settings-drawer {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--dc-bg);
  z-index: 10;
  flex-direction: column;
  overflow: hidden;
  animation: dc-drawer-slide-in 0.2s ease;
}
@keyframes dc-drawer-slide-in {
  from { transform: translateX(100%); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}
.dc-settings-drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--dc-bg);
  border-bottom: 1px solid var(--dc-border);
  cursor: default;
  flex-shrink: 0;
}
.dc-settings-drawer-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--dc-text);
}
.dc-settings-drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

/* --- History Drawer --- */
.dc-history-drawer {
  position: absolute;
  inset: 0;
  background: var(--dc-bg);
  z-index: 11;
  flex-direction: column;
  overflow: hidden;
  animation: dc-drawer-slide-in 0.2s ease;
}
.dc-history-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--dc-border);
  flex-shrink: 0;
}
.dc-history-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--dc-text);
}
.dc-history-body {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
}
.dc-history-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dc-history-empty {
  padding: 24px 12px;
  color: var(--dc-text-muted);
  font-size: 13px;
  text-align: center;
}
.dc-history-item {
  display: grid;
  grid-template-columns: 1fr 28px;
  align-items: stretch;
  border: 1px solid var(--dc-border);
  border-radius: var(--dc-radius-sm);
  background: var(--dc-bg);
  overflow: hidden;
}
.dc-history-item-active {
  border-color: var(--dc-accent);
  background: var(--dc-accent-light);
}
.dc-history-main {
  border: none;
  background: transparent;
  padding: 9px 10px;
  text-align: left;
  cursor: pointer;
  min-width: 0;
  font-family: var(--dc-font);
}
.dc-history-main:hover {
  background: var(--dc-bg-secondary);
}
.dc-history-preview {
  display: block;
  color: var(--dc-text);
  font-size: 12px;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dc-history-meta {
  display: block;
  color: var(--dc-text-muted);
  font-size: 11px;
  margin-top: 3px;
}
.dc-history-delete {
  border: none;
  border-left: 1px solid var(--dc-border);
  background: transparent;
  color: var(--dc-text-muted);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
}
.dc-history-delete:hover {
  background: #fef2f2;
  color: #dc2626;
}

/* --- References Drawer --- */
.dc-references-drawer {
  position: absolute;
  inset: 0;
  background: var(--dc-bg);
  z-index: 11;
  flex-direction: column;
  overflow: hidden;
  animation: dc-drawer-slide-in 0.2s ease;
}
.dc-references-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--dc-border);
  flex-shrink: 0;
}
.dc-references-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--dc-text);
}
.dc-references-body {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
}
.dc-references-help {
  margin: 0 0 8px;
  padding: 8px 10px;
  border: 1px solid #e8e9f7;
  border-radius: var(--dc-radius-sm);
  background: #f7f7ff;
  color: #5b5f82;
  font-size: 12px;
  line-height: 1.45;
}
.dc-references-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dc-references-empty {
  padding: 24px 12px;
  color: var(--dc-text-muted);
  font-size: 13px;
  text-align: center;
  line-height: 1.5;
}
.dc-reference-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 28px;
  align-items: stretch;
  border: 1px solid var(--dc-border);
  border-radius: var(--dc-radius-sm);
  background: var(--dc-bg);
  overflow: hidden;
}
.dc-reference-item-active {
  border-color: var(--dc-accent);
  background: #f8f8ff;
}
.dc-reference-main {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  min-width: 0;
  padding: 9px 10px;
  cursor: pointer;
  font-family: var(--dc-font);
}
.dc-reference-main:hover {
  background: var(--dc-bg-secondary);
}
.dc-reference-main input {
  width: 14px;
  height: 14px;
  margin: 2px 0 0;
  accent-color: var(--dc-accent);
}
.dc-reference-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 3px;
}
.dc-reference-title {
  color: var(--dc-text);
  font-size: 12px;
  line-height: 1.35;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dc-reference-meta {
  color: var(--dc-text-muted);
  font-size: 11px;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dc-reference-summary {
  color: var(--dc-text-secondary);
  font-size: 11.5px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.dc-reference-delete {
  border: none;
  border-left: 1px solid var(--dc-border);
  background: transparent;
  color: var(--dc-text-muted);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
}
.dc-reference-delete:hover {
  background: #fef2f2;
  color: #dc2626;
}

/* --- Settings Content --- */
.dc-settings {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  position: relative;
}
.dc-advanced-toggle {
  position: absolute;
  top: 14px;
  right: 16px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  border: 1px solid var(--dc-border);
  border-radius: 7px;
  background: var(--dc-bg);
  color: var(--dc-text-secondary);
  font-size: 12px;
  font-weight: 600;
  font-family: var(--dc-font);
  cursor: pointer;
  box-shadow: var(--dc-shadow-sm);
  z-index: 13;
}
.dc-advanced-toggle:hover,
.dc-advanced-toggle-active {
  border-color: var(--dc-accent);
  color: var(--dc-accent);
  background: var(--dc-accent-light);
}
.dc-advanced-toggle[hidden],
.dc-advanced-popover[hidden] {
  display: none !important;
}
.dc-setup-guide {
  padding: 12px;
  border: 1px solid #dedffc;
  border-radius: var(--dc-radius-sm);
  background: #f7f7ff;
}
.dc-setup-guide-title {
  color: #252a78;
  font-size: 13px;
  font-weight: 700;
  margin-bottom: 5px;
}
.dc-setup-guide-text {
  color: #5b5f82;
  font-size: 12px;
  line-height: 1.5;
}
.dc-settings-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dc-settings-heading {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--dc-text-muted);
}
.dc-shortcut-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dc-shortcut-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 28px;
  color: var(--dc-text-secondary);
  font-size: 12px;
}
.dc-shortcut-row span {
  flex: 1;
  min-width: 0;
}
.dc-shortcut-row kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 21px;
  padding: 0 6px;
  border: 1px solid #d7dbe7;
  border-bottom-color: #b7bfce;
  border-radius: 5px;
  background: #f8fafc;
  color: #334155;
  font-family: var(--dc-font);
  font-size: 11px;
  font-weight: 650;
  box-shadow: inset 0 -1px 0 rgba(15,23,42,0.06);
}
.dc-advanced-popover {
  position: absolute;
  top: 46px;
  right: 16px;
  width: min(285px, calc(100% - 32px));
  max-height: min(430px, calc(100vh - 180px));
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--dc-border);
  border-radius: var(--dc-radius-sm);
  background: var(--dc-bg);
  box-shadow: var(--dc-shadow-lg);
  z-index: 12;
}
.dc-advanced-popover-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 2px;
}
.dc-advanced-title {
  color: var(--dc-text);
  font-size: 13px;
  font-weight: 700;
}
.dc-advanced-close {
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dc-text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.dc-advanced-close:hover {
  background: var(--dc-bg-hover);
  color: var(--dc-text);
}
.dc-btn-advanced-save {
  margin-top: 2px;
  flex: none;
  width: 100%;
}
.dc-settings-section-compact {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dc-settings-note {
  margin: -2px 0 8px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dc-text-secondary);
}

.dc-model-incomplete {
  padding: 10px;
  border: 1px solid #f2b24d;
  border-radius: var(--dc-radius-sm);
  background: #fff8ec;
}

/* Fields */
.dc-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dc-field label {
  font-size: 12px;
  color: var(--dc-text-secondary);
  font-weight: 500;
}
.dc-input {
  padding: 7px 10px;
  border: 1px solid var(--dc-border);
  border-radius: 6px;
  font-size: 13px;
  font-family: var(--dc-font);
  outline: none;
  background: var(--dc-bg);
  color: var(--dc-text);
  transition: border-color 0.15s;
}
.dc-input:focus {
  border-color: var(--dc-accent);
}

/* Toggles */
.dc-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--dc-text-secondary);
  cursor: pointer;
}
.dc-toggle input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: var(--dc-accent);
}

/* Buttons */
.dc-settings-buttons {
  display: flex;
  gap: 8px;
}
.dc-btn-save {
  flex: 1;
  padding: 8px 0;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  font-family: var(--dc-font);
  cursor: pointer;
  transition: all 0.15s;
  text-align: center;
}
.dc-btn-save {
  background: var(--dc-accent);
  color: #fff;
  border: 1px solid var(--dc-accent);
}
.dc-btn-save:hover {
  background: #4a4eb3;
}

/* ============================================
   Existing Styles (Ghost Text, Notifications, etc.)
   ============================================ */

/* --- Selection Floating Toolbar --- */

/* Wrapper: lays out [main-bar] vertically, preview panel below when active */
.dc-sel-toolbar-wrapper {
  position: fixed;
  display: none;
  flex-direction: column;
  align-items: stretch;
  z-index: 2147483000;
  pointer-events: auto;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  animation: dc-sel-btn-in 0.12s ease;
}
@keyframes dc-sel-btn-in {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* Main compact bar */
.dc-sel-toolbar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  background: #fff;
  border: 1px solid rgba(0,0,0,0.10);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.06);
  min-width: 308px;
  flex-shrink: 0;
}

/* Star icon — hover trigger */
.dc-sel-toolbar-icon {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  color: #5b5fc7;
  user-select: none;
  -webkit-user-select: none;
  border-radius: 5px;
  transition: background 0.15s, transform 0.15s;
  cursor: default;
}
/* Star rotates only when the JS-managed open class is present */
.dc-sel-toolbar-icon.dc-icon-open {
  background: #ededfc;
  transform: scale(1.12) rotate(15deg);
}
/* Counter-rotate the tag menu to cancel out the icon's 15deg rotation */
.dc-sel-toolbar-icon.dc-icon-open .dc-sel-toolbar-tags {
  transform: translateY(calc(-50% - 14px)) rotate(-15deg);
}

/* Star icon needs relative positioning for the flyout */
.dc-sel-toolbar-icon {
  position: relative;
}

/* Tag container — vertical stack, centred on the star, to its left.
   padding-right bridges the visual gap between the tags and the icon so
   that the mouse never leaves the element while crossing the gap, which
   would previously cause the menu to close prematurely. */
.dc-sel-toolbar-tags {
  position: absolute;
  top: 50%;
  right: 100%;
  transform: translateY(calc(-50% - 14px));
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 5px;
  padding: 6px 10px 6px 0;
  background: transparent;
  border: none;
  box-shadow: none;
  /* Hidden state */
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
}
/* Reveal when icon has dc-icon-open class */
.dc-sel-toolbar-icon.dc-icon-open .dc-sel-toolbar-tags {
  opacity: 1;
  pointer-events: auto;
}

/* Individual tag — pill with arrow tip pointing right toward the star */
.dc-sel-tag {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 6px 16px 6px 14px;
  border: none;
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  color: #5b5fc7;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  box-shadow: 0 2px 12px rgba(0,0,0,0.08), 0 0 0 1px rgba(91,95,199,0.12);
  line-height: 1.4;
  /* Initial state for staggered animation */
  opacity: 0;
  transform: translateX(8px) scale(0.92);
  transition: transform 0.2s cubic-bezier(0.34, 1.4, 0.64, 1),
              opacity 0.15s ease,
              box-shadow 0.15s ease,
              background 0.15s ease;
}



/* Animate in when visible — staggered via --fan-delay */
.dc-sel-toolbar-icon.dc-icon-open .dc-sel-tag {
  opacity: 1;
  transform: translateX(0) scale(1);
  transition-delay: var(--fan-delay, 0ms);
}

.dc-sel-tag:hover {
  background: rgba(255, 255, 255, 1);
  box-shadow: 0 4px 20px rgba(91,95,199,0.2), 0 0 0 2px rgba(91,95,199,0.25);
  transform: translateX(0) scale(1.04);
  z-index: 1;
}

.dc-sel-tag:active {
  transform: translateX(0) scale(0.97);
  box-shadow: 0 2px 8px rgba(91,95,199,0.15), 0 0 0 2px rgba(91,95,199,0.3);
}

.dc-sel-toolbar-input {
  flex: 1;
  border: none;
  outline: none;
  font-size: 13px;
  color: #1a1a1a;
  background: transparent;
  padding: 2px 0;
  min-width: 168px;
}
.dc-sel-toolbar-input::placeholder {
  color: #aaa;
}
.dc-sel-toolbar-loading .dc-sel-toolbar-input::placeholder {
  color: #bbb;
}
.dc-sel-toolbar-send {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 5px;
  background: #5b5fc7;
  color: #fff;
  font-size: 13px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
  line-height: 1;
}
.dc-sel-toolbar-send:hover {
  background: #4a4eb5;
}
.dc-sel-toolbar-loading .dc-sel-toolbar-send {
  background: #aaa;
  cursor: not-allowed;
}
.dc-sel-toolbar-image {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 5px;
  background: #eef2ff;
  color: #4f46e5;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
  line-height: 1;
}
.dc-sel-toolbar-image:hover {
  background: #e0e7ff;
  color: #3730a3;
}
.dc-sel-toolbar-loading .dc-sel-toolbar-image {
  color: #9ca3af;
  background: #f3f4f6;
  cursor: not-allowed;
}
.dc-sel-toolbar.dc-sel-toolbar-caret .dc-sel-toolbar-icon {
  display: none;
}
.dc-caret-image-btn {
  position: fixed;
  z-index: 2147483000;
  width: 28px;
  height: 28px;
  border: 1px solid rgba(0,0,0,0.10);
  border-radius: 8px;
  background: #fff;
  color: #4f46e5;
  box-shadow: 0 4px 16px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.06);
  display: none;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
}
.dc-caret-image-btn:hover {
  background: #eef2ff;
}

/* --- Selection Toolbar: Stream Preview --- */
.dc-sel-preview {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  margin-top: 6px;
  background: #fff;
  border: 1px solid rgba(0,0,0,0.10);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.06);
  min-width: 308px;
  max-width: 480px;
  animation: dc-sel-btn-in 0.12s ease;
}
.dc-sel-preview-header {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
}
.dc-sel-preview-header:hover .dc-sel-preview-label {
  color: #5b5fc7;
}
.dc-sel-preview-chevron {
  font-size: 9px;
  color: #9ca3af;
  flex-shrink: 0;
  transition: color 0.15s;
}
.dc-sel-preview-header:hover .dc-sel-preview-chevron {
  color: #5b5fc7;
}
/* Pulsing dot — animated while generating, solid green when done */
.dc-sel-preview-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #5b5fc7;
  flex-shrink: 0;
  animation: dc-preview-pulse 1.2s ease-in-out infinite;
}
.dc-sel-preview-dot.dc-sel-preview-dot-done {
  background: #16a34a;
  animation: none;
}
@keyframes dc-preview-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%       { opacity: 0.4; transform: scale(0.75); }
}
.dc-sel-preview-label {
  font-size: 12px;
  color: #6b7280;
  flex: 1;
}
.dc-sel-preview-text {
  font-size: 13px;
  line-height: 1.6;
  color: #1a1a1a;
  max-height: 160px;
  overflow-y: auto;
  word-break: break-word;
  white-space: normal;
  border-left: 2px solid #5b5fc7;
  padding-left: 8px;
}
.dc-sel-preview-text p {
  margin: 0 0 6px;
}
.dc-sel-preview-text p:last-child {
  margin-bottom: 0;
}
.dc-sel-preview-text ul,
.dc-sel-preview-text ol {
  margin: 0 0 6px 18px;
  padding: 0;
}
.dc-sel-preview-text li {
  margin: 2px 0;
}
.dc-sel-preview-text h1,
.dc-sel-preview-text h2,
.dc-sel-preview-text h3,
.dc-sel-preview-text h4 {
  margin: 0 0 6px;
  color: #111827;
  font-weight: 700;
  line-height: 1.35;
}
.dc-sel-preview-text h1 { font-size: 16px; }
.dc-sel-preview-text h2 { font-size: 15px; }
.dc-sel-preview-text h3,
.dc-sel-preview-text h4 { font-size: 14px; }
.dc-sel-preview-text blockquote {
  margin: 0 0 6px;
  padding: 2px 0 2px 8px;
  border-left: 2px solid #d1d5db;
  color: #4b5563;
}
.dc-sel-preview-text code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  padding: 1px 4px;
  border-radius: 4px;
  background: #f3f4f6;
}
.dc-sel-preview-text pre {
  margin: 0 0 6px;
  padding: 8px;
  overflow-x: auto;
  border-radius: 6px;
  background: #f3f4f6;
}
.dc-sel-preview-text a {
  color: #4f46e5;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.dc-sel-preview-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
  padding-top: 2px;
}
.dc-sel-preview-btn {
  height: 26px;
  padding: 0 12px;
  border: none;
  border-radius: 5px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
  line-height: 1;
}
.dc-sel-preview-btn-accept {
  background: #5b5fc7;
  color: #fff;
}
.dc-sel-preview-btn-accept:hover {
  background: #4a4eb5;
}
.dc-sel-preview-btn-discard {
  background: #f3f4f6;
  color: #374151;
}
.dc-sel-preview-btn-discard:hover {
  background: #e5e7eb;
}

.dc-sel-image-result {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 360px;
  max-width: min(360px, calc(100vw - 16px));
  margin-top: 6px;
  padding: 8px;
  background: #fff;
  border: 1px solid rgba(0,0,0,0.10);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.06);
  animation: dc-sel-btn-in 0.12s ease;
}
.dc-sel-image-result-img {
  display: block;
  width: 100%;
  height: auto;
  max-height: 280px;
  object-fit: contain;
  border-radius: 6px;
  background: #f8f8fb;
}
.dc-sel-image-result-status {
  font-size: 12px;
  line-height: 1.4;
  color: #6b7280;
}
.dc-sel-image-result-note {
  box-sizing: border-box;
  width: 100%;
  height: 30px;
  padding: 0 8px;
  border: 1px solid rgba(0,0,0,0.10);
  border-radius: 6px;
  outline: none;
  background: #fff;
  color: #1a1a1a;
  font-size: 12px;
}
.dc-sel-image-result-note::placeholder {
  color: #9ca3af;
}
.dc-sel-image-result-note:focus {
  border-color: #5b5fc7;
}
.dc-sel-image-result-actions {
  display: flex;
  flex-shrink: 0;
  gap: 6px;
  justify-content: flex-end;
}
.dc-sel-image-result-btn {
  height: 26px;
  padding: 0 10px;
  border: none;
  border-radius: 5px;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
.dc-sel-image-result-btn-primary {
  background: #5b5fc7;
  color: #fff;
}
.dc-sel-image-result-btn-primary:hover {
  background: #4a4eb5;
}
.dc-sel-image-result-btn-secondary {
  background: #eef2ff;
  color: #4f46e5;
}
.dc-sel-image-result-btn-secondary:hover {
  background: #e0e7ff;
}
.dc-sel-image-result-btn-ghost {
  background: #f3f4f6;
  color: #374151;
}
.dc-sel-image-result-btn-ghost:hover {
  background: #e5e7eb;
}

/* --- Ghost Text (Autocomplete) --- */
.doc-copilot-ghost-text {
  color: #999 !important;
  opacity: 0.55 !important;
  pointer-events: none !important;
  user-select: none !important;
  z-index: 10000 !important;
  font-style: italic;
}

/* --- Notifications --- */
.dc-notification {
  position: fixed;
  top: 20px;
  right: 20px;
  padding: 12px 20px;
  border-radius: 8px;
  font-family: var(--dc-font);
  font-size: 14px;
  z-index: 2147483647;
  box-shadow: 0 4px 16px rgba(0,0,0,0.15);
  animation: dc-slide-in 0.3s ease;
  transition: opacity 0.3s ease;
}
.dc-notification-success {
  background: #ecfdf5;
  color: #065f46;
  border: 1px solid #a7f3d0;
}
.dc-notification-error {
  background: #fef2f2;
  color: #991b1b;
  border: 1px solid #fecaca;
}
.dc-notification-info {
  background: #eff6ff;
  color: #1e40af;
  border: 1px solid #bfdbfe;
}
.dc-notification-fade {
  opacity: 0;
}
@keyframes dc-slide-in {
  from { transform: translateX(100%); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}

/* --- Command Palette --- */
.dc-command-palette {
  position: fixed;
  inset: 0;
  z-index: 2147483646;
  font-family: var(--dc-font);
}
.dc-cp-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0,0,0,0.35);
  backdrop-filter: blur(2px);
}
.dc-cp-dialog {
  position: absolute;
  top: 20%;
  left: 50%;
  transform: translateX(-50%);
  width: 560px;
  max-width: 90vw;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 16px 48px rgba(0,0,0,0.2);
  overflow: hidden;
  animation: dc-scale-in 0.15s ease;
}
@keyframes dc-scale-in {
  from { transform: translateX(-50%) scale(0.95); opacity: 0; }
  to { transform: translateX(-50%) scale(1); opacity: 1; }
}
.dc-cp-input-wrapper {
  display: flex;
  align-items: center;
  padding: 14px 16px;
  border-bottom: 1px solid #e5e7eb;
}
.dc-cp-icon { font-size: 18px; margin-right: 10px; color: #6b7280; }
.dc-cp-input {
  flex: 1;
  border: none;
  outline: none;
  font-size: 16px;
  background: transparent;
  color: #111;
  font-family: inherit;
}
.dc-cp-list { max-height: 360px; overflow-y: auto; }
.dc-cp-item {
  display: flex;
  align-items: center;
  padding: 10px 16px;
  cursor: pointer;
  gap: 12px;
  transition: background 0.1s;
}
.dc-cp-item:hover, .dc-cp-item-selected { background: #f3f4f6; }
.dc-cp-item-icon { font-size: 18px; width: 28px; text-align: center; flex-shrink: 0; }
.dc-cp-item-text { display: flex; flex-direction: column; gap: 2px; }
.dc-cp-item-label { font-size: 14px; font-weight: 600; color: #111; }
.dc-cp-item-desc { font-size: 12px; color: #6b7280; }
.dc-cp-empty { padding: 24px; text-align: center; color: #9ca3af; font-size: 14px; }
.dc-cp-footer {
  display: flex;
  gap: 16px;
  padding: 8px 16px;
  border-top: 1px solid #e5e7eb;
  font-size: 12px;
  color: #9ca3af;
}
.dc-cp-footer kbd {
  display: inline-block;
  padding: 1px 6px;
  background: #f3f4f6;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font-size: 11px;
  font-family: inherit;
}

/* --- Review Overlay --- */
.dc-review-overlay {
  position: fixed;
  top: 60px;
  right: 16px;
  width: 380px;
  max-height: 70vh;
  overflow-y: auto;
  z-index: 2147483640;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-family: var(--dc-font);
}
.dc-review-point {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 12px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  transition: all 0.2s;
}
.dc-review-point.dc-review-focused { border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,0.25); }
.dc-review-point.dc-review-resolved { opacity: 0.5; transform: scale(0.97); }
.dc-review-point.dc-review-accepted { border-color: #10b981; }
.dc-review-point.dc-review-rejected { border-color: #ef4444; }
.dc-review-point-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.dc-review-category {
  display: inline-block;
  padding: 2px 8px;
  background: #eff6ff;
  color: #2563eb;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}
.dc-review-reason { font-size: 12px; color: #6b7280; }
.dc-review-point-content { font-size: 13px; line-height: 1.5; margin-bottom: 8px; }
.dc-label { font-weight: 600; color: #374151; font-size: 11px; margin-right: 4px; }
.dc-strikethrough { text-decoration: line-through; color: #ef4444; background: #fef2f2; padding: 1px 4px; border-radius: 3px; }
.dc-highlight { color: #059669; background: #ecfdf5; padding: 1px 4px; border-radius: 3px; }
.dc-review-point-actions { display: flex; gap: 8px; }
.dc-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
  font-family: inherit;
  color: #374151;
}
.dc-btn:hover { background: #f9fafb; border-color: #9ca3af; }
.dc-btn-primary { background: #3b82f6; color: #fff; border-color: #3b82f6; }
.dc-btn-primary:hover { background: #2563eb; }
.dc-btn-accept { color: #059669; border-color: #a7f3d0; }
.dc-btn-accept:hover { background: #ecfdf5; }
.dc-btn-reject { color: #dc2626; border-color: #fecaca; }
.dc-btn-reject:hover { background: #fef2f2; }
.dc-btn-sm { padding: 4px 10px; font-size: 11px; }

/* --- Review Status Bar --- */
.dc-review-status-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 2147483641;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  background: #1e293b;
  color: #e2e8f0;
  font-family: var(--dc-font);
  font-size: 13px;
  box-shadow: 0 -2px 8px rgba(0,0,0,0.15);
}
.dc-review-status-info { display: flex; align-items: center; gap: 10px; }
.dc-review-status-actions { display: flex; gap: 8px; }
.dc-divider { color: #475569; }
.dc-accepted { color: #34d399; }
.dc-rejected { color: #f87171; }
.dc-pending { color: #fbbf24; }
.dc-hint { color: #94a3b8; font-size: 12px; }
.dc-review-status-bar .dc-btn-sm {
  background: transparent;
  border-color: #475569;
  color: #e2e8f0;
}
.dc-review-status-bar .dc-btn-sm:hover { background: #334155; }

/* @media print: hide extension UI if browser print is triggered by other means */
@media print {
  #doc-copilot-root { display: none !important; }
}

/* --- Thinking block (inside typing indicator) --- */
.dc-thinking-block {
  display: flex;
  flex-direction: column;
  gap: 0;
}
.dc-thinking-toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  width: 100%;
  text-align: left;
}
.dc-thinking-toggle:hover .dc-thinking-label {
  color: var(--dc-accent);
}
.dc-thinking-label {
  font-size: 12px;
  color: var(--dc-text-muted);
  animation: dc-status-fade 0.3s ease;
  flex: 1;
}
.dc-thinking-chevron {
  font-size: 9px;
  color: var(--dc-text-muted);
  transition: color 0.15s;
  flex-shrink: 0;
}
.dc-thinking-text {
  font-size: 12px;
  color: var(--dc-text-secondary);
  background: var(--dc-bg-secondary);
  border-left: 2px solid var(--dc-accent);
  padding: 6px 8px;
  margin-top: 5px;
  border-radius: 0 4px 4px 0;
  line-height: 1.55;
  max-height: 240px;
  overflow-y: auto;
  word-break: break-word;
  animation: dc-status-fade 0.2s ease;
}
.dc-thinking-text .dc-p,
.dc-thinking-text .dc-li {
  margin: 3px 0;
  font-size: 12px;
}
.dc-thinking-text .dc-ul,
.dc-thinking-text .dc-ol {
  margin: 4px 0;
  padding-left: 18px;
}

/* --- Debug Overlay --- */
.dc-debug-overlay {
  position: absolute;
  inset: 0;
  background: #0f1117;
  color: #d1d5db;
  display: flex;
  flex-direction: column;
  z-index: 10;
  border-radius: 12px;
  font-family: 'SFMono-Regular', 'Consolas', 'Liberation Mono', monospace;
  font-size: 10px;
  overflow: hidden;
}
.dc-debug-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 10px;
  background: #1c1f26;
  border-bottom: 1px solid #2d3141;
  flex-shrink: 0;
}
.dc-debug-title {
  font-size: 11px;
  font-weight: 600;
  color: #e5e7eb;
}
.dc-debug-count {
  font-weight: 400;
  color: #6b7280;
  margin-left: 6px;
}
.dc-debug-actions {
  display: flex;
  gap: 5px;
  align-items: center;
}
.dc-debug-copy,
.dc-debug-clear,
.dc-debug-close {
  background: #2d3141;
  border: 1px solid #3d4255;
  color: #9ca3af;
  border-radius: 4px;
  padding: 2px 7px;
  font-size: 10px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.dc-debug-copy:hover,
.dc-debug-clear:hover,
.dc-debug-close:hover {
  background: #3d4255;
  color: #e5e7eb;
}
.dc-debug-body {
  flex: 1;
  overflow-y: auto;
  padding: 6px 0;
}
.dc-debug-empty {
  padding: 20px;
  color: #6b7280;
  text-align: center;
}
.dc-debug-row {
  display: flex;
  gap: 7px;
  padding: 1px 9px;
  line-height: 1.5;
  border-bottom: 1px solid #1c1f26;
}
.dc-debug-row:hover { background: #1c1f26; }
.dc-debug-ts {
  color: #6b7280;
  flex-shrink: 0;
  min-width: 78px;
}
.dc-debug-level {
  flex-shrink: 0;
  min-width: 34px;
  font-weight: 700;
}
.dc-debug-msg {
  flex: 1;
  white-space: pre-wrap;
  word-break: break-all;
}
.dc-debug-log .dc-debug-level  { color: #60a5fa; }
.dc-debug-info .dc-debug-level { color: #34d399; }
.dc-debug-warn .dc-debug-level { color: #fbbf24; }
.dc-debug-error .dc-debug-level { color: #f87171; }
.dc-debug-error .dc-debug-msg   { color: #f87171; }
`;
