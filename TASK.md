# Task: Site Adapter System + Bug Fixes for Doc Copilot v0.2.0

## Overview

Doc Copilot is a Chrome MV3 extension for AI-assisted document writing. Currently it only works with generic contentEditable/textarea elements. We need to add a **Site Adapter** system that can intelligently extract document content from specific platforms (starting with Baidu Knowledge Base / ku.baidu-int.com), including **read-only mode** support.

## Bug Fix: Tab Not Accepting Ghost Text

### Problem
When autocomplete shows ghost text (gray suggestion), pressing Tab doesn't insert the text.

### Root Cause Analysis
In `src/content/index.ts`, the Tab keydown handler calls `this.autocomplete.accept()`, which calls `this.adapter.acceptGhostText()`. The `acceptGhostText()` method in `ChromeDocumentAdapter` reads the text from `ghostTextElement.dataset.text` and the offset from `ghostTextElement.dataset.offset`, then calls `this.insertText()`.

**The likely issue**: After `removeGhostText()` is called inside `acceptGhostText()`, the ghost element is already gone, so `insertText` may fail. Also, the `insertText` method for contentEditable uses `document.execCommand('insertText')` which requires the editable element to be focused — but focus may have been lost.

### Fix Required
In `ChromeDocumentAdapter.acceptGhostText()`:
1. Read text and offset BEFORE removing ghost element
2. Ensure the target element is focused before inserting
3. For contentEditable: set cursor position at the correct offset, then use `document.execCommand('insertText')`
4. For textarea: directly splice the value and update cursor position

## Architecture: Site Adapter System

### Design Goals
- **Extensible**: Easy to add new site adapters (Feishu, CSDN, Notion, etc.)
- **Layered**: Site adapters provide content extraction; the existing `ChromeDocumentAdapter` handles editing
- **Graceful fallback**: If no site-specific adapter matches, use a generic DOM extractor
- **Read-only support**: Must work even when there's no editable element focused

### New File Structure
```
src/adapters/
  base/
    adapter.ts          (existing - IDocumentAdapter for editing)
  chrome/
    adapter.ts          (existing - ChromeDocumentAdapter)
  sites/
    types.ts            (ISiteAdapter interface)
    registry.ts         (SiteAdapterRegistry - matches URL to adapter)
    generic.ts          (GenericSiteAdapter - fallback, extracts from document.body)
    baidu-ku.ts         (BaiduKuAdapter - ku.baidu-int.com specific)
```

### ISiteAdapter Interface (src/adapters/sites/types.ts)
```typescript
export interface SiteContentResult {
  /** Full document text content */
  fullText: string;
  /** Document title */
  title: string;
  /** Detected language */
  language: string;
  /** Whether currently in edit mode */
  isEditable: boolean;
  /** The editable element, if in edit mode */
  editableElement?: HTMLElement;
  /** The main content container element */
  contentElement: HTMLElement;
  /** Document metadata (author, date, etc.) */
  metadata?: Record<string, string>;
}

export interface ISiteAdapter {
  /** Unique identifier */
  readonly id: string;
  /** Human-readable name */
  readonly name: string;
  /** Check if this adapter should handle the current page */
  matches(url: string, document: Document): boolean;
  /** Extract document content from the page */
  extractContent(document: Document): SiteContentResult | null;
  /** Get the editable element if in edit mode (may return null in read-only) */
  getEditableElement(document: Document): HTMLElement | null;
  /** Observe for mode changes (edit <-> read-only) and content updates */
  observe(document: Document, callback: (content: SiteContentResult) => void): () => void;
}
```

### SiteAdapterRegistry (src/adapters/sites/registry.ts)
```typescript
class SiteAdapterRegistry {
  private adapters: ISiteAdapter[] = [];
  
  register(adapter: ISiteAdapter): void;
  
  /** Find matching adapter for current page, or return generic fallback */
  match(url: string, doc: Document): ISiteAdapter;
  
  /** Get all registered adapters */
  getAll(): ISiteAdapter[];
}
```

### GenericSiteAdapter (src/adapters/sites/generic.ts)
The fallback adapter that works on any page:
- `matches()` → always returns true (lowest priority, used as fallback)
- `extractContent()` → tries to find main content area using heuristics:
  1. Look for `<article>`, `<main>`, `[role="main"]`
  2. Fall back to `document.body`
  3. Strip nav, sidebar, footer, script, style elements
  4. Return cleaned `innerText`
- `getEditableElement()` → returns `document.activeElement` if it's editable, else null

### BaiduKuAdapter (src/adapters/sites/baidu-ku.ts)
Specific adapter for ku.baidu-int.com:
- `matches()` → checks if URL hostname is `ku.baidu-int.com`
- `extractContent()`:
  - **Read mode**: Find the document viewer container. Common selectors to try (probe the DOM):
    - `.article-content`, `.doc-content`, `.reader-content`, `.ql-editor`, `[data-doc-content]`
    - `.ne-viewer-body` (likely NE editor viewer)
    - `#article-content`
    - If none match, walk DOM for the largest text container
  - **Edit mode**: Find the contentEditable editor element:
    - `.ql-editor[contenteditable="true"]`
    - `.ne-editor-body[contenteditable="true"]`
    - `[contenteditable="true"]` within the document area
  - Extract title from page heading (`.doc-title`, `h1`, or `document.title`)
- `getEditableElement()` → returns the contentEditable element in edit mode
- `observe()` → MutationObserver on the content container for live updates

**IMPORTANT**: Since we can't directly test against ku.baidu-int.com (it's an internal site), the adapter should be **robust and probe multiple selectors**. Use a priority-ordered list of CSS selectors and try each one. Log which selector matched for debugging.

## Integration with DocCopilot Main (src/content/index.ts)

### Changes Needed

1. **Import and initialize SiteAdapterRegistry** with all site adapters
2. **On page load**, detect which site adapter matches
3. **Store site content** separately from the editing adapter's content
4. **Modify `getContext()` flow**:
   - If adapter is attached (edit mode): use `ChromeDocumentAdapter.getContext()` as before, but supplement `fullText` with site adapter's extraction
   - If adapter is NOT attached (read-only mode): use site adapter's `extractContent()` to provide context
5. **New method in DocCopilot class**: `getPageContext(): DocumentContext` that works regardless of edit mode
6. **Floating panel should work in read-only mode** — chat and review features should use `getPageContext()` instead of requiring an attached adapter

### Read-Only Mode Behavior
When the page is in read-only mode:
- Autocomplete: disabled (nothing to complete)
- Command palette: disabled (no editor to insert into)
- Floating panel (Chat): **ENABLED** — user can ask questions about the document
- Floating panel (Review): **ENABLED** — can analyze the document (but accept/reject won't work since it's read-only)
- Context menu actions: disabled for editing commands, enabled for summarize/translate/explain

## Model Configuration Update

Update `DEFAULT_SETTINGS` in `src/shared/types/index.ts`:

```typescript
smart: {
  role: 'smart',
  name: 'Smart (Text)',
  baseUrl: '',
  apiKey: '',
  modelId: '',
  maxTokens: 4096,
  temperature: 0.7,
  supportsStreaming: true,
},
```

## Version Bump

Update to v0.2.0 in:
- `package.json`
- `public/manifest.json`
- `src/popup/popup.html` (footer text)

## Build & Verify

After all changes, run `bash scripts/build.sh` and ensure it compiles cleanly.

## Files to Create
- `src/adapters/sites/types.ts`
- `src/adapters/sites/registry.ts`  
- `src/adapters/sites/generic.ts`
- `src/adapters/sites/baidu-ku.ts`

## Files to Modify
- `src/adapters/chrome/adapter.ts` — fix acceptGhostText bug
- `src/content/index.ts` — integrate site adapters, support read-only mode
- `src/content/floating-panel/controller.ts` — work in read-only mode
- `src/shared/types/index.ts` — update DEFAULT_SETTINGS model configs
- `package.json` — version bump
- `public/manifest.json` — version bump
- `src/popup/popup.html` — version in footer

## Constraints
- TypeScript strict mode
- IIFE build (no `type: "module"` anywhere)
- Chrome MV3 compatible
- No external dependencies (pure TypeScript)
- All site adapter selectors should be logged to console when probing (prefixed with `[Doc Copilot]`)
