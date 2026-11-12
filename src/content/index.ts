// ============================================================
// Content Script - Main entry point for page integration
// ============================================================

import { ChromeDocumentAdapter } from '../adapters/chrome/adapter';
import { AutocompleteController } from './autocomplete-controller';
import { ReviewOverlayController } from './review-overlay/controller';
import { CommandPaletteController } from './command-palette/controller';
import { FloatingPanelController } from './floating-panel/controller';
import { ParagraphOptimizerController } from './paragraph-optimizer/controller';
import { AppSettings, ExtensionMessage, DocumentContext, ToolCallRequestMessage, ToolCallResultMessage, Range, Position } from '../shared/types/index';
import { settingsStorage } from '../shared/storage/settings';
import { injectStyles } from './styles';
import { siteAdapterRegistry } from '../adapters/sites/registry';
import { BaiduKuAdapter } from '../adapters/sites/baidu-ku';
import { FeishuAdapter } from '../adapters/sites/feishu';
import { CsdnAdapter } from '../adapters/sites/csdn';
import { MimoDocsAdapter } from '../adapters/sites/mimo-docs';
import { WechatMpAdapter } from '../adapters/sites/wechat-mp';
import { ZhihuAdapter } from '../adapters/sites/zhihu';
import { GenericSiteAdapter } from '../adapters/sites/generic';
import { ISiteAdapter, SiteContentResult } from '../adapters/sites/types';

const SKIP_CONTENT_TYPE_PATTERNS = [
  'application/json',
  'application/ld+json',
  'application/geo+json',
  'application/manifest+json',
  'application/x-ndjson',
  'application/javascript',
  'text/json',
  'text/javascript',
];

const JSON_URL_PATTERN = /\.(json|geojson|har|jsonl|ndjson|map)(?:[?#].*)?$/i;
const JSON_VIEWER_PRO_EXTENSION_ID = 'eifflpmocdbdmepbjaopkkhbfmdgijcc';
const JSON_VIEWER_MARKERS = [
  '#rbrahul-awesome-json',
  '#json-viewer',
  '.jv-logo-title',
  '.jv-toolbar',
  '.jv-code-editor',
  '.json-input-section',
  '.tab-container ul.json-dict',
  '.tab-container ol.json-array',
  'ul.json-dict',
  'ol.json-array',
  '.searchbar .search-input',
];

const SENSITIVE_PATH_PATTERN = /(?:^|\/)(?:login|sign-?in|sign-?up|register|passport|oauth|authorize|checkout|payment|pay)(?:\/|$)/i;
const INTEGRATION_MARKER = '__docCopilotContentInitialized';

function shouldSkipPageIntegration(doc: Document, href: string): { skip: boolean; reason?: string } {
  try {
    const url = new URL(href);
    if (SENSITIVE_PATH_PATTERN.test(url.pathname)) {
      return { skip: true, reason: 'sensitive-path' };
    }
  } catch {
    return { skip: true, reason: 'invalid-url' };
  }

  if (doc.querySelector('input[type="password"]')) {
    return { skip: true, reason: 'password-form' };
  }
  const contentType = (doc.contentType || '').toLowerCase();
  if (SKIP_CONTENT_TYPE_PATTERNS.some(type => contentType.includes(type))) {
    return { skip: true, reason: `content-type:${contentType}` };
  }

  if (looksLikeJsonViewerDocument(doc)) {
    return { skip: true, reason: 'json-viewer' };
  }

  if (JSON_URL_PATTERN.test(href) && looksLikeRawJsonDocument(doc)) {
    return { skip: true, reason: 'raw-json-url' };
  }

  if (looksLikeRawJsonDocument(doc)) {
    return { skip: true, reason: 'raw-json-document' };
  }

  return { skip: false };
}

function looksLikeJsonViewerDocument(doc: Document): boolean {
  if (JSON_VIEWER_MARKERS.some(selector => doc.querySelector(selector))) {
    return true;
  }

  return Array.from(doc.querySelectorAll('link[href], script[src]')).some((node) => {
    const url = node instanceof HTMLLinkElement ? node.href : (node as HTMLScriptElement).src;
    return url.includes(`chrome-extension://${JSON_VIEWER_PRO_EXTENSION_ID}/`);
  });
}

function looksLikeRawJsonDocument(doc: Document): boolean {
  const body = doc.body;
  if (!body) return false;

  const visibleChildren = Array.from(body.children).filter((child) => {
    const tag = child.tagName.toLowerCase();
    return tag !== 'script' && tag !== 'style' && tag !== 'link';
  });

  if (visibleChildren.length > 1) return false;

  const onlyChild = visibleChildren[0];
  if (onlyChild && onlyChild.tagName.toLowerCase() !== 'pre') return false;

  const text = (onlyChild?.textContent || body.textContent || '').trim();
  if (text.length < 2) return false;

  const first = text[0];
  const last = text[text.length - 1];
  if (!((first === '{' && last === '}') || (first === '[' && last === ']'))) {
    return false;
  }

  // Cheap structural check; avoid JSON.parse on very large API responses.
  const head = text.slice(0, 2000);
  return first === '{'
    ? /"[^"]+"\s*:/.test(head)
    : /^\[\s*(\{|\[|"|-?\d|true|false|null)/.test(head);
}

class DocCopilot {
  private adapter: ChromeDocumentAdapter;
  private autocomplete: AutocompleteController;
  private reviewOverlay: ReviewOverlayController;
  private commandPalette: CommandPaletteController;
  private floatingPanel: FloatingPanelController;
  private paragraphOptimizer: ParagraphOptimizerController;
  private settings!: AppSettings;

  // Site adapter system
  private siteAdapter: ISiteAdapter;
  private siteContent: SiteContentResult | null = null;
  private siteObserverCleanup: (() => void) | null = null;

  constructor() {
    this.adapter = new ChromeDocumentAdapter();
    this.autocomplete = new AutocompleteController(this.adapter);
    this.reviewOverlay = new ReviewOverlayController(this.adapter);
    this.commandPalette = new CommandPaletteController(this.adapter);

    // Initialize site adapters
    this.initializeSiteAdapters();

    // Match current page to appropriate site adapter
    this.siteAdapter = siteAdapterRegistry.match(window.location.href, document);
    console.log(`[Doc Copilot] Using site adapter: ${this.siteAdapter.id} (${this.siteAdapter.name})`);

    this.floatingPanel = new FloatingPanelController(this.adapter, this.siteAdapter);
    this.paragraphOptimizer = new ParagraphOptimizerController(this.adapter, () => this.getPageContext());
  }

  private initializeSiteAdapters(): void {
    // Register specific site adapters first (higher priority)
    siteAdapterRegistry.register(new BaiduKuAdapter());
    siteAdapterRegistry.register(new FeishuAdapter());
    siteAdapterRegistry.register(new CsdnAdapter());
    siteAdapterRegistry.register(new MimoDocsAdapter());
    siteAdapterRegistry.register(new WechatMpAdapter());
    siteAdapterRegistry.register(new ZhihuAdapter());
    // Generic adapter must be registered last as fallback
    siteAdapterRegistry.register(new GenericSiteAdapter());
  }

  async init(): Promise<void> {
    // Inject styles
    injectStyles();

    // Load settings
    this.settings = await settingsStorage.get();
    this.autocomplete.updateSettings(this.settings);
    this.paragraphOptimizer.updateSettings(this.settings);

    // Setup focus tracking to auto-attach adapter
    this.setupFocusTracking();

    // Setup keyboard shortcuts
    this.setupKeyboardShortcuts();

    // Listen for messages from background
    this.setupMessageListener();

    // Listen for settings changes
    settingsStorage.onChange((settings) => {
      this.settings = settings;
      this.autocomplete.updateSettings(settings);
      this.paragraphOptimizer.updateSettings(settings);
    });

    // Initialize site content extraction
    this.initializeSiteContent();

    console.log('[Doc Copilot] Content script initialized');
  }

  private initializeSiteContent(): void {
    // Extract initial content
    this.siteContent = this.siteAdapter.extractContent(document);
    if (this.siteContent) {
      console.log(`[Doc Copilot] Site content extracted: ${this.siteContent.isEditable ? 'edit mode' : 'read-only mode'}`);
      this.attachEditableElement(this.siteContent.editableElement);
    }

    // Set up observer for content updates
    this.siteObserverCleanup = this.siteAdapter.observe(document, (content) => {
      this.siteContent = content;
      console.log(`[Doc Copilot] Site content updated: ${content.isEditable ? 'edit mode' : 'read-only mode'}`);

      // Auto-attach adapter if we enter edit mode
      if (content.isEditable && content.editableElement) {
        this.attachEditableElement(content.editableElement);
      }
    });
  }

  /**
   * Get page context that works in both edit and read-only modes.
   * If an adapter is attached (edit mode), uses adapter's context.
   * Otherwise (read-only mode), uses site adapter's extracted content.
   */
  getPageContext(): DocumentContext | null {
    if (!this.adapter.isAttached() && this.siteContent?.isEditable && this.siteContent.editableElement) {
      this.attachEditableElement(this.siteContent.editableElement);
    }

    const attachedElement = this.adapter.getAttachedElement();
    if (attachedElement?.closest('#doc-copilot-root')) {
      return this.getSiteContentContext();
    }

    // If adapter is attached (edit mode), use its context
    if (this.adapter.isAttached()) {
      const adapterContext = this.adapter.getContext();
      // Augment with site content's fullText if available and adapter's is null
      if (!adapterContext.fullText && this.siteContent?.fullText) {
        adapterContext.fullText = this.siteContent.fullText;
      }
      if (this.siteContent?.documentImages?.length) {
        adapterContext.documentImages = this.siteContent.documentImages;
      }
      return adapterContext;
    }

    // Read-only mode: use site adapter's content
    return this.getSiteContentContext();
  }

  private getSiteContentContext(): DocumentContext | null {
    if (!this.siteContent) {
      return null;
    }

    return {
      textBefore: this.siteContent.fullText.slice(-this.settings.contextWindowSize),
      textAfter: '',
      selectedText: '',
      fullText: this.siteContent.fullText,
      cursorPosition: { line: 0, character: 0, offset: 0 },
      language: this.siteContent.language,
      title: this.siteContent.title,
      documentImages: this.siteContent.documentImages,
      elementType: 'unknown',
    };
  }

  private setupFocusTracking(): void {
    const attachFromTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      if (target.closest('#doc-copilot-root, .dc-sel-toolbar-wrapper')) return false;

      const editable = this.resolveEditableTarget(target);
      if (editable) {
        this.attachEditableElement(editable);
        return true;
      }
      return false;
    };

    const attachFromSelection = (): boolean => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return false;

      const anchor = sel.anchorNode;
      const anchorElement = anchor instanceof HTMLElement ? anchor : anchor?.parentElement;
      if (!anchorElement || anchorElement.closest('#doc-copilot-root, .dc-sel-toolbar-wrapper')) {
        return false;
      }

      const directEditable = this.resolveEditableTarget(anchorElement);
      if (directEditable) {
        this.attachEditableElement(directEditable);
        return true;
      }

      const siteEditable = this.siteAdapter.getEditableElement(document);
      if (siteEditable && (siteEditable === anchorElement || siteEditable.contains(anchorElement))) {
        this.attachEditableElement(siteEditable);
        return true;
      }

      return false;
    };

    const attachAndNotifyInput = (target: EventTarget | null) => {
      if (attachFromTarget(target)) {
        this.autocomplete.notifyInputSignal();
      }
    };

    document.addEventListener('focusin', (e) => {
      const target = e.target as HTMLElement;
      // The selection toolbar is part of the paragraph optimizer flow; focusing
      // its input must not detach the optimizer or the toolbar disappears.
      if (target.closest('.dc-sel-toolbar-wrapper')) {
        this.autocomplete.disable();
        return;
      }

      // Ignore Doc Copilot's panel UI. The chat textarea is not a document editor.
      if (target.closest('#doc-copilot-root')) {
        const attachedElement = this.adapter.getAttachedElement();
        if (attachedElement?.closest('#doc-copilot-root')) {
          this.adapter.detach();
        }
        this.autocomplete.disable();
        this.paragraphOptimizer.detach();
        return;
      }

      attachFromTarget(target);
    });

    // Slate-based editors can be swapped in when switching from read-only to
    // edit mode. Some IME commits arrive as beforeinput/composition events
    // before focus tracking sees the fresh editor, so attach opportunistically.
    document.addEventListener('beforeinput', (e) => attachAndNotifyInput(e.target), true);
    document.addEventListener('input', (e) => attachAndNotifyInput(e.target), true);
    document.addEventListener('compositionend', (e) => attachAndNotifyInput(e.target), true);
    document.addEventListener('keyup', (e) => attachAndNotifyInput(e.target), true);
    document.addEventListener('selectionchange', () => {
      if (attachFromSelection()) {
        if (window.getSelection()?.isCollapsed) {
          this.autocomplete.notifyCursorSignal();
        }
      }
    });
    document.addEventListener('mouseup', (e) => {
      if (attachFromTarget(e.target) || attachFromSelection()) {
        if (window.getSelection()?.isCollapsed) {
          this.autocomplete.notifyCursorSignal();
        }
      }
    }, true);

    document.addEventListener('focusout', () => {
      // Small delay to handle focus switching between our UI and the editor
      setTimeout(() => {
        const active = document.activeElement;
        // Don't detach if focus moved to the selection toolbar input
        if (active && active.classList.contains('dc-sel-toolbar-input')) return;
        const selectionToolbar = document.querySelector('.dc-sel-toolbar-wrapper') as HTMLElement | null;
        if (selectionToolbar && getComputedStyle(selectionToolbar).display !== 'none') return;
        if (!active || active === document.body) {
          this.autocomplete.hideGhostText();
          this.paragraphOptimizer.detach();
        }
      }, 200);
    });
  }

  private attachEditableElement(element?: HTMLElement | null): void {
    if (!element) return;

    const current = this.adapter.getAttachedElement();
    if (current !== element) {
      this.adapter.attach(element);
    }
    this.autocomplete.enable(this.settings.features.autocomplete);
    this.paragraphOptimizer.attach(element);
  }

  private resolveEditableTarget(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof HTMLElement)) return null;

    const siteEditable = this.siteAdapter.getEditableElement(document);
    if (siteEditable && (siteEditable === target || siteEditable.contains(target))) {
      return siteEditable;
    }
    if (siteEditable && this.isHiddenEditorProxy(target)) {
      return siteEditable;
    }
    if (this.isHiddenEditorProxy(target)) {
      return null;
    }

    if (target instanceof HTMLTextAreaElement) return target;
    if (target instanceof HTMLInputElement && target.type === 'text') return target;

    if (target.isContentEditable) {
      const rootEditable = target.closest('[contenteditable="true"]');
      return (rootEditable as HTMLElement | null) || target;
    }

    const editableAncestor = target.closest('[contenteditable="true"]');
    return editableAncestor as HTMLElement | null;
  }

  private isHiddenEditorProxy(target: HTMLElement): boolean {
    if (!(target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)) {
      return false;
    }

    const className = String(target.className || '');
    if (/selection-hidden|hidden-textarea|docx-selection/i.test(className)) {
      return true;
    }

    const rect = target.getBoundingClientRect();
    const style = getComputedStyle(target);
    return style.display === 'none'
      || style.visibility === 'hidden'
      || Number(style.opacity || '1') === 0
      || rect.width <= 2
      || rect.height <= 2
      || rect.right <= 0
      || rect.bottom <= 0
      || rect.left >= window.innerWidth
      || rect.top >= window.innerHeight;
  }

  private setupKeyboardShortcuts(): void {
    // Capture phase listener for Tab — must run before Slate/editors consume it
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.shiftKey) {
        if (this.autocomplete.hasGhostText()) {
          e.preventDefault();
          e.stopImmediatePropagation();
          this.autocomplete.accept();
          return;
        }
        if (this.reviewOverlay.isActive()) {
          e.preventDefault();
          e.stopImmediatePropagation();
          this.reviewOverlay.acceptCurrent();
          return;
        }
      }
    }, true); // <-- capture phase

    // Bubble phase listener for everything else
    document.addEventListener('keydown', (e) => {
      // Escape to close overlays
      if (e.key === 'Escape') {
        if (this.commandPalette.isVisible()) {
          e.preventDefault();
          this.commandPalette.hide();
          return;
        }
        if (this.reviewOverlay.isActive()) {
          e.preventDefault();
          this.reviewOverlay.rejectCurrent();
          return;
        }
        if (this.autocomplete.hasGhostText()) {
          e.preventDefault();
          this.autocomplete.dismiss();
          return;
        }
      }

      // Tab — already handled in capture phase above, skip here

      // Ctrl+↑/↓ to navigate review points
      if (this.reviewOverlay.isActive() && e.ctrlKey) {
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          this.reviewOverlay.previousPoint();
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.reviewOverlay.nextPoint();
          return;
        }
      }

      // Ctrl+Shift+A to accept all review points
      if (e.ctrlKey && e.shiftKey && e.key === 'A') {
        if (this.reviewOverlay.isActive()) {
          e.preventDefault();
          this.reviewOverlay.acceptAll();
          return;
        }
      }

      // Ctrl+Shift+R to reject all review points
      if (e.ctrlKey && e.shiftKey && e.key === 'R') {
        if (this.reviewOverlay.isActive()) {
          e.preventDefault();
          this.reviewOverlay.rejectAll();
          return;
        }
      }

      // Alt+Shift+D to toggle floating panel
      if (e.altKey && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        this.floatingPanel.toggle();
        return;
      }
    }, true); // capture phase — intercept before Slate/editors
  }

  private setupMessageListener(): void {
    chrome.runtime.onMessage.addListener(
      (message: ExtensionMessage, _sender, sendResponse) => {
        if (message.type === 'TOOL_CALL_REQUEST') {
          const req = message as unknown as ToolCallRequestMessage;
          this.handleToolCallRequest(req)
            .then(() => sendResponse({ ok: true }))
            .catch(() => sendResponse({ ok: false }));
          return true; // async response
        }
        this.handleExternalMessage(message);
        sendResponse({ received: true });
      },
    );
  }

  private handleExternalMessage(message: ExtensionMessage): void {
    switch (message.type) {
      case 'COMMAND':
        this.handleCommand((message.payload as { command: string }).command);
        break;
      case 'CONTEXT_MENU_ACTION':
        this.handleContextMenuAction(message.payload as { action: string; selectedText?: string });
        break;
      case 'SETTINGS_CHANGED':
        this.settings = { ...this.settings, ...(message.payload as Partial<AppSettings>) };
        this.autocomplete.updateSettings(this.settings);
        this.paragraphOptimizer.updateQuickPrompts(this.settings.quickPrompts);
        break;
      case 'SELECTION_ACTION_STREAM_CHUNK':
        this.paragraphOptimizer.onStreamChunk(
          (message.payload as { delta: string; fullText: string }).delta,
          (message.payload as { delta: string; fullText: string }).fullText,
        );
        break;
      case 'SELECTION_ACTION_STREAM_END':
        this.paragraphOptimizer.onStreamEnd(
          message.payload as { action?: string; result?: string; resultHtml?: string; imageUrl?: string; error?: string },
        );
        break;
    }
  }

  private handleCommand(command: string): void {
    switch (command) {
      case 'toggle-panel':
        this.floatingPanel.toggle();
        break;
      case 'trigger-autocomplete':
        this.autocomplete.triggerManual();
        break;
      case 'open-settings':
        this.floatingPanel.openSettings();
        break;
    }
  }

  private handleContextMenuAction(payload: { action: string; selectedText?: string }): void {
    switch (payload.action) {
      case 'command:optimize-selection':
        if (this.settings.features.selectionToolbar === false) break;
        this.paragraphOptimizer.optimizeSelection();
        break;
      case 'command:fix':
        this.commandPalette.executeCommand('fix');
        break;
      case 'command:rewrite':
        this.commandPalette.executeCommand('rewrite');
        break;
      case 'command:review':
        this.reviewOverlay.startReview('correct');
        break;
    }
  }

  // ================================================================
  // Tool Call Execution (for Agent Function Calling)
  // ================================================================

  private async handleToolCallRequest(req: ToolCallRequestMessage): Promise<void> {
    const { callId, toolName, args } = req;
    let success = true;
    let result: string;

    try {
      result = await this.executeEditingTool(toolName, args);
    } catch (err) {
      success = false;
      result = err instanceof Error ? err.message : String(err);
    }

    chrome.runtime.sendMessage({
      type: 'TOOL_CALL_RESULT',
      callId,
      success,
      result,
    } as ToolCallResultMessage);
  }

  private async executeEditingTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    this.ensureEditableAttached();

    switch (toolName) {
      case 'insert_at_cursor': {
        const text = args.text as string;
        if (!this.adapter.isAttached()) throw new Error('编辑器未附着，无法插入文本');
        const ctx = this.adapter.getContext();
        if (!ctx.cursorPosition) throw new Error('无法获取光标位置');
        const beforeText = this.getRangeSearchText();
        this.adapter.insertText(ctx.cursorPosition, text);
        await this.assertTextChanged(beforeText, '插入未生效，请先点击正文建立真实光标后重试');
        return `已在光标处插入内容（${text.length} 字）`;
      }

      case 'replace_selection': {
        const text = args.text as string;
        if (!this.adapter.isAttached()) throw new Error('编辑器未附着，无法替换文本');
        const range = this.adapter.getSelectionRange();
        if (!range) throw new Error('当前没有选中文本');
        const beforeText = this.getRangeSearchText();
        this.adapter.replaceRange(range, text);
        await this.assertTextChanged(beforeText, '替换未生效，请重新选中文本后重试');
        return `已替换选中内容（新内容 ${text.length} 字）`;
      }

      case 'replace_text': {
        const findText = args.find_text as string;
        const replaceText = args.replace_text as string;
        const occurrence = (args.occurrence as number) ?? 1;
        if (!this.adapter.isAttached()) throw new Error('编辑器未附着，无法替换文本');
        const range = this.findTextRange(findText, occurrence);
        if (!range) throw new Error(`未在文档中找到：「${findText.slice(0, 30)}」`);
        const beforeText = this.getRangeSearchText();
        this.adapter.replaceRange(range, replaceText);
        await this.assertTextChanged(beforeText, '替换未生效，目标文本可能不在当前可编辑视口内');
        return `已将「${findText.slice(0, 30)}」替换为「${replaceText.slice(0, 30)}」`;
      }

      default:
        throw new Error(`未知工具: ${toolName}`);
    }
  }

  private ensureEditableAttached(): void {
    const attachedElement = this.adapter.getAttachedElement();
    if (attachedElement && !attachedElement.closest('#doc-copilot-root, .dc-sel-toolbar-wrapper')) {
      return;
    }

    const editable = this.siteAdapter.getEditableElement(document)
      || (this.siteContent?.isEditable ? this.siteContent.editableElement : null);
    if (editable) {
      this.attachEditableElement(editable);
    }
  }

  /**
   * Search for the nth occurrence of findText in the full document text
   * and return a Range that can be passed to adapter.replaceRange().
   */
  private findTextRange(findText: string, occurrence = 1): Range | null {
    const fullText = this.getRangeSearchText();
    if (!fullText) return null;

    let idx = -1;
    let searchFrom = 0;
    for (let i = 0; i < occurrence; i++) {
      idx = fullText.indexOf(findText, searchFrom);
      if (idx === -1) return null;
      searchFrom = idx + 1;
    }

    const makePosition = (offset: number): Position => {
      const before = fullText.slice(0, offset);
      const lines = before.split('\n');
      return {
        line: lines.length - 1,
        character: lines[lines.length - 1].length,
        offset,
      };
    };

    return {
      start: makePosition(idx),
      end: makePosition(idx + findText.length),
    };
  }

  private getRangeSearchText(): string {
    const attachedElement = this.adapter.getAttachedElement();
    if (
      attachedElement
      && !(attachedElement instanceof HTMLTextAreaElement)
      && !(attachedElement instanceof HTMLInputElement)
    ) {
      return attachedElement.textContent || this.adapter.getText();
    }
    return this.adapter.getText();
  }

  private async assertTextChanged(beforeText: string, message: string): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 50));
    const afterText = this.getRangeSearchText();
    if (afterText === beforeText) {
      throw new Error(message);
    }
  }
}

// --- Initialize ---
const integrationWindow = window as typeof window & { [INTEGRATION_MARKER]?: boolean };
const skipIntegration = integrationWindow[INTEGRATION_MARKER]
  ? { skip: true, reason: 'already-initialized' }
  : shouldSkipPageIntegration(document, window.location.href);
if (skipIntegration.skip) {
  console.log(`[Doc Copilot] Skipped page integration (${skipIntegration.reason})`);
} else {
  integrationWindow[INTEGRATION_MARKER] = true;
  const copilot = new DocCopilot();
  copilot.init().catch(console.error);

  // Export getPageContext for floating panel access
  (window as any).docCopilotGetPageContext = () => copilot.getPageContext();
}
