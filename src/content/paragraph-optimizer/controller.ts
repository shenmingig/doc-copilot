// ============================================================
// Selection Toolbar Controller
//
// Shows a floating input bar below the selection when text is
// selected inside the editable element.  The user types a free-
// form instruction and presses Enter; an Agent decides whether
// to edit the text or generate an image.
// ============================================================

import { ChromeDocumentAdapter } from '../../adapters/chrome/adapter';
import { AppSettings, DocumentContext, Range, QuickPrompt, DEFAULT_QUICK_PROMPTS } from '../../shared/types/index';
import { settingsStorage } from '../../shared/storage/settings';
import { mergeCurrentDocumentImages, prepareDocumentImagesForModel } from '../document-image-utils';

/** Map Baidu Ku's Slate CSS classes → standard semantic HTML tags */
const SLATE_MARK_MAP: Array<{ selector: string; tag: string }> = [
  { selector: 'strong, [class*="text-decorate-bold"]', tag: 'strong' },
  { selector: 'em, [class*="text-decorate-italic"]', tag: 'em' },
  { selector: '[class*="text-decorate-underline"]', tag: 'u' },
  { selector: '[class*="text-decorate-strikethrough"]', tag: 's' },
  { selector: 'code, [class*="text-decorate-inline-code"]', tag: 'code' },
];

const BAIDU_TABLE_BLOCK_SELECTOR = '.mp-table-wrapper[data-slate-node="element"], .mp-table-wrapper, .mp-table-align.mp-table-root';
const BAIDU_TABLE_FRAME_SELECTOR = '.mp-table-wrapper, .mp-table-container, table.mp-table, .mp-table-align.mp-table-root';
const BAIDU_TABLE_CONTROL_SELECTOR = [
  '.mp-table-control-outer-row',
  '.mp-table-control-inner-row',
  '.mp-table-control-outer-btn',
  '.mp-table-control-outer-tooltip-wrapper',
  '.mp-table-control-outer-col',
  '.mp-table-control-inner-col',
].join(', ');
const BAIDU_TABLE_CELL_SELECTOR = 'td, th, .mp-table-cell-container, span[data-slate-string]';
const TABLE_DRAG_THRESHOLD_PX = 8;
const IMAGE_ANCHOR_BLOCK_SELECTOR = [
  '.mp-table-wrapper[data-slate-node="element"]',
  '.mp-table-wrapper',
  '.mp-paragraph-wrapper',
  '.mp-heading-wrapper',
  '[data-slate-node="element"]',
  '.zone-container.text-editor',
  '.page-block-content',
  '[data-block-id]',
  '[data-docx-id]',
  '.docx-block',
  '.docx-text-block',
  'p',
  'li',
  'blockquote',
  'pre',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
].join(', ');

export class ParagraphOptimizerController {
  private adapter: ChromeDocumentAdapter;
  private editableEl: HTMLElement | null = null;

  // Floating toolbar
  private toolbar: HTMLElement | null = null;
  private toolbarInput: HTMLInputElement | null = null;
  private tagContainer: HTMLElement | null = null;

  // Stream preview area (below the toolbar bar)
  private previewEl: HTMLElement | null = null;
  private previewTextEl: HTMLElement | null = null;
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private progressStartedAt = 0;
  private progressMode: 'text' | 'image' = 'text';
  private imageDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private imageResultEl: HTMLElement | null = null;
  private imageNoteInput: HTMLInputElement | null = null;
  private imageResultOpen = false;
  private imageResultLayoutBound = false;
  private imageSourcePrompt = '';
  private imageGeneratedPrompt = '';

  // Captured at the moment the toolbar appears
  private savedRange: Range | null = null;
  private savedAnchorElement: HTMLElement | null = null;
  private savedSelectedText = '';
  private savedSelectionHtml = '';
  private savedContext: DocumentContext | null = null;
  private toolbarMode: 'selection' | 'block' | 'caret' = 'selection';
  private caretButton: HTMLButtonElement | null = null;
  private pendingCaretBlock: HTMLElement | null = null;
  private caretPoint = { x: 0, y: 0 };

  // Quick prompts
  private quickPrompts: QuickPrompt[] = DEFAULT_QUICK_PROMPTS;
  private enabled = true;
  private contextWindowSize = 800;

  // Shared
  private isProcessing = false;
  private isInputFocused = false;
  private isToolbarPointerDown = false;
  private pendingPointer: {
    target: Node | null;
    downX: number;
    downY: number;
  } | null = null;

  constructor(
    adapter: ChromeDocumentAdapter,
    private readonly contextProvider?: () => DocumentContext | null,
  ) {
    this.adapter = adapter;
    // Load quick prompts from storage asynchronously
    settingsStorage.get().then(s => {
      this.enabled = s.features.selectionToolbar !== false;
      this.contextWindowSize = s.contextWindowSize;
      this.quickPrompts = s.quickPrompts ?? DEFAULT_QUICK_PROMPTS;
      this.refreshTags();
    });
  }

  attach(element: HTMLElement): void {
    if (!this.enabled) return;
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return;
    if (element.closest('#doc-copilot-root, .dc-sel-toolbar-wrapper')) return;
    if (this.editableEl === element) return;
    // Clicking another block or the side panel re-attaches the editor.
    // Keep the in-flight toolbar, anchor, and request until the task ends.
    if (this.isProcessing || this.imageResultOpen || this.isToolbarOpen()) {
      this.editableEl = element;
      return;
    }
    this.detach();
    this.editableEl = element;
    document.addEventListener('selectionchange', this.onSelectionChange);
    window.addEventListener('pointerdown', this.onWindowPointerDown, true);
    document.addEventListener('pointerdown', this.onDocumentPointerDown, true);
    document.addEventListener('pointerup', this.onDocumentPointerUp, true);
    document.addEventListener('keydown', this.onDocumentKeyDown, true);
  }

  detach(): void {
    if (this.isProcessing || this.imageResultOpen) return;
    document.removeEventListener('selectionchange', this.onSelectionChange);
    window.removeEventListener('pointerdown', this.onWindowPointerDown, true);
    document.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
    document.removeEventListener('pointerup', this.onDocumentPointerUp, true);
    document.removeEventListener('keydown', this.onDocumentKeyDown, true);
    this.hideCaretButton();
    this.editableEl = null;
    this.pendingPointer = null;
    this.savedAnchorElement = null;
    this.hideToolbar();
  }

  dispose(): void {
    this.isProcessing = false;
    this.imageResultOpen = false;
    this.stopProgressTimer();
    this.clearImageDeadline();
    this.detach();
    this.toolbar?.remove();
    this.caretButton?.remove();
    this.toolbar = null;
    this.caretButton = null;
    this.pendingCaretBlock = null;
    this.toolbarInput = null;
    this.tagContainer = null;
  }

  // ─── Public: optimize from right-click context menu ────────────────────────

  async optimizeSelection(): Promise<void> {
    return this.runWithPrompt('优化');
  }

  /** Called when settings change to refresh the tag buttons. */
  updateQuickPrompts(prompts: QuickPrompt[] | undefined): void {
    if (Array.isArray(prompts) && prompts.length > 0) {
      this.quickPrompts = prompts;
    } else {
      this.quickPrompts = DEFAULT_QUICK_PROMPTS;
    }
    this.refreshTags();
  }

  updateSettings(settings: AppSettings): void {
    this.enabled = settings.features.selectionToolbar !== false;
    this.contextWindowSize = settings.contextWindowSize;
    this.updateQuickPrompts(settings.quickPrompts);
    if (!this.enabled) {
      this.hideToolbar();
    }
  }

  // ─── Selection tracking ─────────────────────────────────────────────────────

  private onSelectionChange = (): void => {
    if (!this.enabled || this.isProcessing || this.imageResultOpen || !this.editableEl) return;

    // Don't hide while the user is interacting with the toolbar. Some editors
    // fire selectionchange before the toolbar button/input receives its event.
    if (this.isInputFocused || this.isInteractingWithToolbar()) {
      return;
    }

    if (this.hasEditableSelection()) {
      this.showToolbar();
    }
  };

  private onWindowPointerDown = (e: PointerEvent): void => {
    if (!this.isPointInsideOpenToolbar(e.clientX, e.clientY)) return;
    this.holdToolbarInteraction();
    const path = e.composedPath();
    if (this.toolbar && path.includes(this.toolbar)) return;

    // A page overlay can sit above the toolbar visually and steal the hit.
    // Keep the toolbar open and forward the click to the control underneath.
    e.preventDefault();
    e.stopPropagation();
    const hit = this.toolbarElementAt(e.clientX, e.clientY);
    if (hit instanceof HTMLInputElement) {
      hit.focus();
    } else if (hit instanceof HTMLElement) {
      hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY }));
    }
  };

  private onDocumentPointerDown = (e: PointerEvent): void => {
    const target = e.target as Node | null;
    this.pendingPointer = {
      target,
      downX: e.clientX,
      downY: e.clientY,
    };
    if (target && this.caretButton?.contains(target)) {
      this.holdToolbarInteraction();
      return;
    }
    if (!this.toolbar || this.toolbar.style.display === 'none') return;

    if (this.isEventInsideToolbar(e)) {
      this.holdToolbarInteraction();
      return;
    }

    // Baidu Ku table selection uses custom controls/overlays and often keeps
    // window.getSelection() collapsed. Let pointerup decide the new table state
    // instead of hiding the toolbar immediately on table-frame clicks.
    if (target && this.findSelectedTableBlock(target, { x: e.clientX, y: e.clientY }, false)) {
      return;
    }

    if (!this.isProcessing && !this.imageResultOpen) {
      this.hideToolbar();
    }
  };

  private onDocumentPointerUp = (e: PointerEvent): void => {
    if (!this.enabled || this.isProcessing || this.imageResultOpen || !this.editableEl) return;
    if (this.isInputFocused || this.isInteractingWithToolbar()) return;

    const pending = this.pendingPointer;
    this.pendingPointer = null;
    const target = pending?.target ?? (e.target as Node | null);
    if (!target) return;

    const point = { x: e.clientX, y: e.clientY };
    const moved = pending
      ? Math.hypot(e.clientX - pending.downX, e.clientY - pending.downY) > TABLE_DRAG_THRESHOLD_PX
      : false;

    window.setTimeout(() => {
      if (!this.enabled || this.isProcessing || this.imageResultOpen || !this.editableEl) return;
      if (this.hasEditableSelection()) {
        this.hideCaretButton();
        return;
      }

      const table = this.findSelectedTableBlock(target, point, moved);
      if (table) {
        this.hideCaretButton();
        this.showToolbarForBlock(table, '对选中表格说点什么... (Enter 发送)');
        return;
      }

      if (moved || (target && this.caretButton?.contains(target))) return;
      const block = this.findCaretTextBlock(target);
      if (block) this.showCaretButton(block, point);
      else this.hideCaretButton();
    }, 80);
  };

  /** Returns true when there is a non-collapsed selection inside editableEl. */
  private hasEditableSelection(): boolean {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    return !!(this.editableEl && this.editableEl.contains(range.commonAncestorContainer));
  }

  private findSelectedTableBlock(
    target: Node,
    point?: { x: number; y: number },
    allowCellSelection = false,
  ): HTMLElement | null {
    if (!this.editableEl) return null;

    const element = target instanceof HTMLElement ? target : target.parentElement;
    const candidates: HTMLElement[] = [];
    if (element) candidates.push(element);

    const topElement = point ? document.elementFromPoint(point.x, point.y) : element;
    const topIsPlainCell = topElement instanceof HTMLElement
      && !!topElement.closest(BAIDU_TABLE_CELL_SELECTOR)
      && !topElement.closest(BAIDU_TABLE_CONTROL_SELECTOR);
    if (!allowCellSelection && topIsPlainCell) return null;

    if (point) {
      const pointedElements = typeof document.elementsFromPoint === 'function'
        ? document.elementsFromPoint(point.x, point.y)
        : [document.elementFromPoint(point.x, point.y)].filter(Boolean);

      pointedElements.forEach((el) => {
        if (el instanceof HTMLElement) candidates.push(el);
      });
    }

    let hasCellCandidate = false;
    for (const candidate of candidates) {
      hasCellCandidate = hasCellCandidate || !!candidate.closest(BAIDU_TABLE_CELL_SELECTOR);
      const table = this.findTableBlockFromElement(candidate, allowCellSelection);
      if (table) return table;
    }

    if (point && (allowCellSelection || !hasCellCandidate)) {
      return this.findTableBlockNearPoint(point);
    }

    return null;
  }

  private findTableBlockFromElement(element: HTMLElement, allowCellSelection: boolean): HTMLElement | null {
    const fromTableControls = element.closest(BAIDU_TABLE_CONTROL_SELECTOR);
    const fromTableFrame = element.closest(BAIDU_TABLE_FRAME_SELECTOR);
    const fromTableCell = element.closest(BAIDU_TABLE_CELL_SELECTOR);
    if (!fromTableControls && !fromTableFrame && !(allowCellSelection && fromTableCell)) return null;

    // A plain click inside a cell should keep normal table editing quiet. Dragging
    // across cells is treated as a table selection because Baidu Ku stores that
    // selection outside the browser's native Selection API.
    if (!allowCellSelection && !fromTableControls && fromTableCell) return null;

    const wrapper = element.closest('.mp-table-wrapper[data-slate-node="element"], .mp-table-wrapper') as HTMLElement | null;
    if (wrapper && this.editableEl?.contains(wrapper)) return wrapper;

    const table = element.closest('table.mp-table') as HTMLElement | null;
    const tableWrapper = table?.closest('.mp-table-wrapper') as HTMLElement | null;
    if (tableWrapper && this.editableEl?.contains(tableWrapper)) return tableWrapper;

    const root = element.closest('.mp-table-align.mp-table-root') as HTMLElement | null;
    const rootWrapper = root?.querySelector('.mp-table-wrapper') as HTMLElement | null;
    if (rootWrapper && this.editableEl?.contains(rootWrapper)) return rootWrapper;
    if (root && this.editableEl?.contains(root)) return root;

    return null;
  }

  private findTableBlockNearPoint(point: { x: number; y: number }): HTMLElement | null {
    if (!this.editableEl) return null;

    const tables = Array.from(this.editableEl.querySelectorAll(BAIDU_TABLE_BLOCK_SELECTOR)) as HTMLElement[];
    return tables.find((table) => {
      const rect = table.getBoundingClientRect();
      return point.x >= rect.left - 24
        && point.x <= rect.right + 24
        && point.y >= rect.top - 24
        && point.y <= rect.bottom + 24;
    }) ?? null;
  }

  private extractTableText(block: HTMLElement): string {
    const table = block.querySelector('table');
    if (table) {
      const rows = Array.from(table.querySelectorAll('tr'))
        .map(row => Array.from(row.querySelectorAll('th,td'))
          .map(cell => this.normalizeBlockText((cell as HTMLElement).innerText || cell.textContent || ''))
          .filter(Boolean))
        .filter(row => row.length > 0);

      if (rows.length) {
        return rows.map(row => `| ${row.join(' | ')} |`).join('\n');
      }
    }

    return this.normalizeBlockText(block.innerText || block.textContent || '');
  }

  private extractTableHtml(block: HTMLElement): string {
    const table = block.querySelector('table');
    return table?.outerHTML || '';
  }

  private normalizeBlockText(text: string): string {
    return text
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ─── Toolbar UI ──────────────────────────────────────────────────────────────

  private showToolbar(): void {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    this.toolbarMode = 'selection';
    this.hideCaretButton();

    // Capture selection state now before the DOM changes
    this.savedSelectedText = this.adapter.getSelectedText().trim();
    this.savedRange = this.adapter.getSelectionRange();
    const selRange = sel.getRangeAt(0);
    this.savedAnchorElement = this.findSelectionImageAnchor(selRange);
    this.savedSelectionHtml = this.extractSemanticHtml(selRange.cloneContents());
    this.savedContext = this.contextProvider?.() ?? this.adapter.getContext(undefined, this.contextWindowSize);

    this.showToolbarAtRect(rect, '对选中内容说点什么... (Enter 发送)');
  }

  private showToolbarForBlock(block: HTMLElement, placeholder: string): void {
    const rect = block.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;

    const selectedText = this.extractTableText(block);
    if (!selectedText) return;

    const elementRange = this.adapter.getElementRange(block);
    if (!elementRange) return;

    this.savedSelectedText = selectedText;
    this.savedRange = elementRange;
    this.savedAnchorElement = block;
    this.savedSelectionHtml = this.extractTableHtml(block);
    this.savedContext = this.contextProvider?.() ?? this.adapter.getContext(undefined, this.contextWindowSize);

    this.toolbarMode = 'block';
    this.hideCaretButton();
    this.showToolbarAtRect(rect, placeholder);
  }

  private showToolbarAtRect(rect: DOMRect, placeholder: string): void {
    if (!this.toolbar) {
      this.createToolbar();
    }

    // Position the wrapper: anchor on the main bar (right part of wrapper)
    // The tag flyout grows to the left via CSS, so we position by the bar's right edge.
    const bar = this.toolbar!.querySelector('.dc-sel-toolbar') as HTMLElement;
    const barWidth = bar?.offsetWidth || 280;
    const gap = 8;
    let top = rect.bottom + gap;
    if (top + 44 > window.innerHeight - 8) {
      top = rect.top - 44 - gap;
    }
    // Center the main bar under the selection
    const idealLeft = rect.left + rect.width / 2 - barWidth / 2;
    const left = Math.max(8, Math.min(idealLeft, window.innerWidth - barWidth - 8));

    this.toolbar!.style.top = `${Math.max(8, top)}px`;
    this.toolbar!.style.left = `${left}px`;
    this.toolbar!.style.display = 'flex';
    bar?.classList.toggle('dc-sel-toolbar-caret', this.toolbarMode === 'caret');

    // Clear previous input
    if (this.toolbarInput) {
      this.toolbarInput.value = '';
      this.toolbarInput.placeholder = placeholder;
    }
    const imageBtn = this.toolbar!.querySelector('.dc-sel-toolbar-image') as HTMLElement | null;
    if (imageBtn) imageBtn.title = this.imageTitleForMode();
  }

  private submitToolbarPrompt(): void {
    const prompt = this.toolbarInput?.value.trim() || '';
    if (this.toolbarMode === 'caret') {
      this.runWithPrompt(prompt ? `配图：${prompt}` : '配图');
      return;
    }
    if (prompt) this.runWithPrompt(prompt);
  }

  private placeholderForMode(): string {
    if (this.toolbarMode === 'caret') return '根据当前段落生成配图，可补充要求... (Enter 发送)';
    if (this.toolbarMode === 'block') return '对选中表格说点什么... (Enter 发送)';
    return '对选中内容说点什么... (Enter 发送)';
  }

  private imageTitleForMode(): string {
    if (this.toolbarMode === 'caret') return '根据当前段落生成配图，显示在下方并复制，不插入文档';
    if (this.toolbarMode === 'block') return '根据表格生成配图，显示在下方并复制，不插入文档';
    return '根据选中内容生成配图，显示在下方并复制，不替换原文';
  }

  private onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.imageResultOpen && !this.isProcessing && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      this.hideToolbar();
      return;
    }
    if (this.isProcessing || this.isInputFocused) return;
    const target = event.target as Node | null;
    if (target && (this.toolbar?.contains(target) || this.caretButton?.contains(target))) return;
    if (!this.caretButton || this.caretButton.style.display === 'none') return;
    this.hideCaretButton();
  };

  private showCaretButton(block: HTMLElement, point: { x: number; y: number }): void {
    this.pendingCaretBlock = block;
    this.caretPoint = point;
    if (!this.caretButton) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dc-caret-image-btn';
      button.title = '根据这段直接生成配图';
      button.innerHTML = `
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3 2.5h10A1.5 1.5 0 0114.5 4v8A1.5 1.5 0 0113 13.5H3A1.5 1.5 0 011.5 12V4A1.5 1.5 0 013 2.5z" stroke="currentColor" stroke-width="1.25"/>
          <path d="M3.7 11l2.1-2.1a1 1 0 011.4 0L8.5 10.2l1.1-1.1a1 1 0 011.4 0l1.4 1.4" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="11.2" cy="5.4" r="1" fill="currentColor"/>
        </svg>`;
      button.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const anchor = this.pendingCaretBlock;
        this.hideCaretButton();
        if (!anchor || !anchor.isConnected) {
          this.showNotification('插入位置已失效，请重新点击段落', 'info');
          return;
        }
        this.showToolbarForCaret(anchor);
        void this.runWithPrompt('配图');
      });
      document.body.appendChild(button);
      this.caretButton = button;
    }

    const size = 28;
    const left = Math.max(8, Math.min(point.x + 12, window.innerWidth - size - 8));
    const top = Math.max(8, Math.min(point.y - size / 2, window.innerHeight - size - 8));
    this.caretButton.style.left = `${left}px`;
    this.caretButton.style.top = `${top}px`;
    this.caretButton.style.display = 'flex';
  }

  private hideCaretButton(): void {
    if (!this.caretButton) return;
    this.caretButton.style.display = 'none';
  }

  private showToolbarForCaret(block: HTMLElement): void {
    this.toolbarMode = 'caret';
    this.savedSelectedText = this.blockBrief(block) || '当前插入位置';
    this.savedAnchorElement = block;
    this.savedRange = this.adapter.getElementRange(block);
    this.savedSelectionHtml = '';
    this.savedContext = this.contextProvider?.() ?? this.adapter.getContext(undefined, this.contextWindowSize);

    const rect = block.getBoundingClientRect();
    const usable = rect.width > 0 && rect.height > 0
      ? rect
      : new DOMRect(this.caretPoint.x, this.caretPoint.y, 1, 1);
    this.showToolbarAtRect(usable, this.placeholderForMode());
  }

  private findCaretTextBlock(target: Node | null): HTMLElement | null {
    if (!this.editableEl || !target) return null;
    const element = target instanceof HTMLElement ? target : target.parentElement;
    if (!element || !this.editableEl.contains(element)) return null;
    if (element.closest('.dc-sel-toolbar-wrapper, .dc-caret-image-btn, #doc-copilot-root')) return null;
    if (element.closest('table, .mp-table-wrapper, .mp-table-align')) return null;

    const block = element.closest(
      '.block[data-block-id], .docx-text-block, .docx-block, [data-slate-node="element"], p, li, h1, h2, h3, h4, h5, h6',
    ) as HTMLElement | null;
    if (!block || block === this.editableEl || !this.editableEl.contains(block)) return null;
    if (block.classList.contains('docx-page-block') || block.classList.contains('root-block') || block.classList.contains('page-block')) {
      return null;
    }
    return block;
  }

  private blockBrief(block: HTMLElement): string {
    const own = this.normalizeBlockText(block.innerText || block.textContent || '');
    if (own.length >= 12) return own.slice(0, 500);
    const previous = this.neighborBlockText(block.previousElementSibling);
    const next = this.neighborBlockText(block.nextElementSibling);
    return [previous, own, next].filter(Boolean).join('\n').slice(0, 500);
  }

  private neighborBlockText(node: Element | null): string {
    const element = node instanceof HTMLElement ? node : null;
    if (!element) return '';
    return this.normalizeBlockText(element.innerText || element.textContent || '').slice(0, 180);
  }

  private findSelectionImageAnchor(range: globalThis.Range): HTMLElement | null {
    if (!this.editableEl) return null;

    const endElement = range.endContainer instanceof HTMLElement
      ? range.endContainer
      : range.endContainer.parentElement;
    const startElement = range.startContainer instanceof HTMLElement
      ? range.startContainer
      : range.startContainer.parentElement;

    const endBlock = this.findImageAnchorFromElement(endElement);
    if (endBlock) return endBlock;

    return this.findImageAnchorFromElement(startElement);
  }

  private findImageAnchorFromElement(element: HTMLElement | null): HTMLElement | null {
    const block = element?.closest(IMAGE_ANCHOR_BLOCK_SELECTOR) as HTMLElement | null;
    if (!block || !this.editableEl?.contains(block) || block === this.editableEl) return null;
    return block;
  }

  private createToolbar(): void {
    // Wrapper for positioning
    const wrapper = document.createElement('div');
    wrapper.className = 'dc-sel-toolbar-wrapper';

    // Main toolbar bar
    const bar = document.createElement('div');
    bar.className = 'dc-sel-toolbar';

    const icon = document.createElement('span');
    icon.className = 'dc-sel-toolbar-icon';
    icon.textContent = '✦';
    icon.title = '快捷操作';

    // Tag flyout (vertical menu, appears on icon hover)
    const tags = document.createElement('div');
    tags.className = 'dc-sel-toolbar-tags';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'dc-sel-toolbar-input';
    input.autocomplete = 'off';
    input.spellcheck = false;

    const sendBtn = document.createElement('button');
    sendBtn.className = 'dc-sel-toolbar-send';
    sendBtn.innerHTML = '↵';
    sendBtn.title = '发送 (Enter)';

    const imageBtn = document.createElement('button');
    imageBtn.className = 'dc-sel-toolbar-image';
    imageBtn.title = '根据选中内容生成配图，显示在下方并复制，不替换原文';
    imageBtn.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M3 2.5h10A1.5 1.5 0 0114.5 4v8A1.5 1.5 0 0113 13.5H3A1.5 1.5 0 011.5 12V4A1.5 1.5 0 013 2.5z" stroke="currentColor" stroke-width="1.25"/>
        <path d="M3.7 11l2.1-2.1a1 1 0 011.4 0L8.5 10.2l1.1-1.1a1 1 0 011.4 0l1.4 1.4" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="11.2" cy="5.4" r="1" fill="currentColor"/>
      </svg>`;

    // Open menu when hovering the star icon
    icon.addEventListener('mouseenter', () => {
      icon.classList.add('dc-icon-open');
    });
    // Close menu only when the mouse leaves both the icon AND the tag flyout
    icon.addEventListener('mouseleave', (e) => {
      const to = e.relatedTarget as Node | null;
      if (to && tags.contains(to)) return;
      icon.classList.remove('dc-icon-open');
    });
    tags.addEventListener('mouseleave', (e) => {
      const to = e.relatedTarget as Node | null;
      if (to && icon.contains(to)) return;
      icon.classList.remove('dc-icon-open');
    });

    // Always prevent mousedown from collapsing the editor selection.
    // For the input, manually call focus() so it still receives focus
    // without the browser's default mousedown-focus behaviour clearing the selection.
    const markToolbarPointerDown = () => {
      this.holdToolbarInteraction();
    };

    wrapper.addEventListener('pointerdown', markToolbarPointerDown, true);

    wrapper.addEventListener('mousedown', (e) => {
      const target = e.target as HTMLElement;
      markToolbarPointerDown();
      if (!target.classList.contains('dc-sel-image-result-note')) {
        e.preventDefault();
      }
      if (target instanceof HTMLInputElement) {
        target.focus();
      }
    });

    // Track input focus so selectionchange never hides the toolbar while typing
    input.addEventListener('focus', () => { this.isInputFocused = true; });
    input.addEventListener('blur', () => { this.isInputFocused = false; });

    // Track IME composition state to prevent Enter from sending during composition
    let isComposing = false;
    input.addEventListener('compositionstart', () => { isComposing = true; });
    input.addEventListener('compositionend', () => { isComposing = false; });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
        e.preventDefault();
        e.stopPropagation();
        this.submitToolbarPrompt();
      } else if (e.key === 'Escape' && !this.isProcessing) {
        e.preventDefault();
        this.hideToolbar();
      }
    });

    sendBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.submitToolbarPrompt();
    });

    sendBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.submitToolbarPrompt();
    });

    imageBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const prompt = input.value.trim();
      this.runWithPrompt(prompt ? `配图：${prompt}` : '配图');
    });

    imageBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const prompt = input.value.trim();
      this.runWithPrompt(prompt ? `配图：${prompt}` : '配图');
    });

    // Structure: bar contains [icon (with tags inside), input, sendBtn]
    icon.appendChild(tags);
    bar.appendChild(icon);
    bar.appendChild(input);
    bar.appendChild(imageBtn);
    bar.appendChild(sendBtn);

    wrapper.appendChild(bar);
    document.body.appendChild(wrapper);

    this.toolbar = wrapper;
    this.toolbarInput = input;
    this.tagContainer = tags;

    // Populate tags immediately
    this.refreshTags();
  }

  /** Re-renders the quick-prompt tag buttons inside the tag flyout. */
  private refreshTags(): void {
    if (!this.tagContainer) return;
    this.tagContainer.innerHTML = '';

    this.quickPrompts.forEach((qp, i) => {
      const btn = document.createElement('button');
      btn.className = 'dc-sel-tag';
      btn.textContent = qp.label;
      btn.title = qp.prompt;

      // Staggered animation delay
      btn.style.setProperty('--fan-delay', `${i * 35}ms`);

      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.runWithPrompt(qp.prompt);
      });
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.runWithPrompt(qp.prompt);
      });
      this.tagContainer!.appendChild(btn);
    });
  }

  private hideToolbar(): void {
    if (this.isProcessing) return;
    this.imageResultOpen = false;
    this.clearImageResult();
    if (this.toolbar) this.toolbar.style.display = 'none';
    this.stopProgressTimer();
    this.hidePreview();
    this.hideCaretButton();
  }

  private isInteractingWithToolbar(): boolean {
    if (this.isToolbarPointerDown) return true;
    const active = document.activeElement;
    return !!(this.toolbar && active instanceof Node && this.toolbar.contains(active));
  }

  private isToolbarOpen(): boolean {
    return !!this.toolbar && this.toolbar.style.display !== 'none';
  }

  private holdToolbarInteraction(): void {
    this.isToolbarPointerDown = true;
    window.setTimeout(() => { this.isToolbarPointerDown = false; }, 800);
  }

  private isEventInsideToolbar(e: PointerEvent): boolean {
    const path = e.composedPath();
    if (this.toolbar && path.some(node => node === this.toolbar)) return true;
    return this.isPointInsideOpenToolbar(e.clientX, e.clientY);
  }

  private isPointInsideOpenToolbar(x: number, y: number): boolean {
    if (!this.isToolbarOpen() || !this.toolbar) return false;
    const rect = this.toolbar.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  private toolbarElementAt(x: number, y: number): Element | null {
    if (!this.toolbar) return null;
    const elements = typeof document.elementsFromPoint === 'function'
      ? document.elementsFromPoint(x, y)
      : [document.elementFromPoint(x, y)].filter((element): element is Element => !!element);
    return elements.find(element =>
      this.toolbar?.contains(element)
      && element !== this.toolbar
      && !(element instanceof HTMLElement && element.classList.contains('dc-sel-toolbar'))
    ) ?? null;
  }

  private setToolbarLoading(loading: boolean): void {
    if (!this.toolbar || !this.toolbarInput) return;
    const bar = this.toolbar.querySelector('.dc-sel-toolbar') as HTMLElement | null;
    if (loading) {
      this.toolbarInput.readOnly = true;
      this.toolbarInput.placeholder = '处理中...';
      bar?.classList.add('dc-sel-toolbar-loading');
    } else {
      this.toolbarInput.readOnly = false;
      this.toolbarInput.placeholder = this.placeholderForMode();
      bar?.classList.remove('dc-sel-toolbar-loading');
    }
  }

  // ─── Core logic — streaming mode ────────────────────────────────────────────

  private async runWithPrompt(
    userPrompt: string,
    options?: { preserveImageSource?: boolean },
  ): Promise<void> {
    if (this.isProcessing) return;

    const selectedText = this.savedSelectedText;
    const range = this.savedRange;

    if (!selectedText || selectedText.length < 1) {
      this.showNotification(this.toolbarMode === 'caret' ? '请先点击要配图的段落' : '请先选中需要处理的文本', 'info');
      return;
    }

    this.isProcessing = true;
    this.imageResultOpen = false;
    this.clearImageResult();
    this.setToolbarLoading(true);
    const isImagePrompt = this.isImagePrompt(userPrompt);
    if (isImagePrompt && !options?.preserveImageSource) {
      this.imageSourcePrompt = userPrompt;
    }
    this.progressMode = isImagePrompt ? 'image' : 'text';
    this.showPreview('');
    if (isImagePrompt) {
      this.startProgressTimer();
      this.armImageDeadline();
    }

    let documentImages = this.savedContext?.documentImages ?? [];
    if (isImagePrompt) {
      this.updatePreview('正在读取文档已有图片风格...');
      try {
        const mergedImages = mergeCurrentDocumentImages(documentImages);
        documentImages = await prepareDocumentImagesForModel(mergedImages);
        if (documentImages.length) {
          this.updatePreview(`已读取 ${documentImages.length} 张正文参考图，正在分析配色和风格...`);
        } else {
          this.updatePreview('未读取到可用于模型参考的正文图片，将根据上下文生成配图...');
        }
      } catch (error) {
        console.warn('[Doc Copilot] Failed to prepare document images for image prompt:', error);
        documentImages = [];
      }
    }

    // Fire-and-forget: background will push STREAM_CHUNK / STREAM_END messages
    chrome.runtime.sendMessage({
      type: 'SELECTION_ACTION_REQUEST',
      payload: {
        prompt: userPrompt,
        selectedText,
        selectedHtml: this.savedSelectionHtml,
        title: document.title,
        textBefore: this.savedContext?.textBefore ?? '',
        textAfter: this.savedContext?.textAfter ?? '',
        fullText: this.savedContext?.fullText ?? null,
        documentImages,
      },
    }).catch(() => {
      // Background returned an error synchronously (e.g. no handler)
      this.onStreamEnd({ error: '请求失败，请重试' });
    });
  }

  /** Called by content/index.ts when a SELECTION_ACTION_STREAM_CHUNK arrives */
  onStreamChunk(_delta: string, fullText: string): void {
    if (!this.isProcessing) return;
    if (this.progressMode === 'image' && fullText.includes('正在生成配图')) {
      this.startProgressTimer();
      return;
    }
    this.updatePreview(fullText);
  }

  /** Called by content/index.ts when a SELECTION_ACTION_STREAM_END arrives */
  onStreamEnd(result: {
    action?: string;
    result?: string;
    resultHtml?: string;
    imageUrl?: string;
    replaceSelection?: boolean;
    generatedPrompt?: string;
    error?: string;
  }): void {
    if (!this.isProcessing) return;

    this.isProcessing = false;
    this.setToolbarLoading(false);
    this.stopProgressTimer();
    this.clearImageDeadline();

    if (result.error) {
      this.hidePreview();
      this.showNotification(result.error, 'error');
      return;
    }

    if (result.action === 'image') {
      this.hidePreview();
      if (!result.imageUrl) {
        this.showNotification('图像模型没有返回图片', 'error');
        return;
      }
      this.showImageResult(result.imageUrl, result.generatedPrompt || '');
      return;
    }

    // edit action: mark preview as done, then apply after a short delay
    const range = this.savedRange;
    if (!range) {
      this.hidePreview();
      this.showNotification('无法获取选中范围，请重新选中后再试', 'error');
      return;
    }

    const resultText = (result.result ?? '').trim();
    const resultHtml = (result.resultHtml ?? '').trim();
    const savedText = this.savedSelectedText;

    if (!resultText || resultText === savedText) {
      this.hidePreview();
      this.showNotification('内容已是最佳状态', 'info');
      return;
    }

    this.updatePreview(resultHtml || resultText);

    // Mark preview as "done" — show accept/discard buttons
    this.finalizePreview(range, resultText, resultHtml);
  }

  // ─── Stream preview area ────────────────────────────────────────────────────

  /** Create or show the preview panel below the toolbar bar, with empty content. */
  private showPreview(initialText: string): void {
    if (!this.toolbar) return;

    if (!this.previewEl) {
      const preview = document.createElement('div');
      preview.className = 'dc-sel-preview';

      const header = document.createElement('div');
      header.className = 'dc-sel-preview-header';
      header.title = '点击折叠/展开';

      const dot = document.createElement('span');
      dot.className = 'dc-sel-preview-dot';

      const label = document.createElement('span');
      label.className = 'dc-sel-preview-label';
      label.textContent = this.progressMode === 'image' ? '正在生成配图...' : 'AI 正在生成...';

      const chevron = document.createElement('span');
      chevron.className = 'dc-sel-preview-chevron';
      chevron.textContent = '▼';

      header.appendChild(dot);
      header.appendChild(label);
      header.appendChild(chevron);

      const text = document.createElement('div');
      text.className = 'dc-sel-preview-text';

      // Toggle collapse on header click
      header.addEventListener('click', () => {
        const collapsed = text.hidden;
        text.hidden = !collapsed;
        chevron.textContent = collapsed ? '▼' : '▶';
      });

      preview.appendChild(header);
      preview.appendChild(text);
      this.toolbar.appendChild(preview);

      this.previewEl = preview;
      this.previewTextEl = text;
      this.renderPreviewContent(initialText);
    } else {
      if (this.previewTextEl) {
        this.previewTextEl.hidden = false;
        this.renderPreviewContent(initialText);
      }
      const label = this.previewEl.querySelector('.dc-sel-preview-label') as HTMLElement | null;
      if (label) label.textContent = this.progressMode === 'image' ? '正在生成配图...' : 'AI 正在生成...';
      const dot = this.previewEl.querySelector('.dc-sel-preview-dot') as HTMLElement | null;
      dot?.classList.remove('dc-sel-preview-dot-done');
      const chevron = this.previewEl.querySelector('.dc-sel-preview-chevron') as HTMLElement | null;
      if (chevron) chevron.textContent = '▼';
      // Remove action buttons if re-using
      this.previewEl.querySelector('.dc-sel-preview-actions')?.remove();
      this.previewEl.style.display = 'flex';
    }
  }

  /** Update the streaming text content in place. */
  private updatePreview(fullText: string): void {
    if (!this.previewTextEl) return;
    this.renderPreviewContent(fullText);
    // Auto-scroll to bottom
    this.previewTextEl.scrollTop = this.previewTextEl.scrollHeight;
  }

  private startProgressTimer(): void {
    if (this.progressTimer) return;
    this.progressStartedAt = Date.now();
    this.updateImageProgress();
    this.progressTimer = setInterval(() => this.updateImageProgress(), 5000);
  }

  private stopProgressTimer(): void {
    if (!this.progressTimer) return;
    clearInterval(this.progressTimer);
    this.progressTimer = null;
  }

  private armImageDeadline(): void {
    this.clearImageDeadline();
    this.imageDeadlineTimer = setTimeout(() => {
      if (!this.isProcessing || this.progressMode !== 'image') return;
      this.onStreamEnd({ error: '图像生成超过 3 分钟还没有返回，已停止等待。请再试一次。' });
    }, 180_000);
  }

  private clearImageDeadline(): void {
    if (!this.imageDeadlineTimer) return;
    clearTimeout(this.imageDeadlineTimer);
    this.imageDeadlineTimer = null;
  }

  private updateImageProgress(): void {
    if (!this.isProcessing || this.progressMode !== 'image') return;
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - this.progressStartedAt) / 1000));
    const stage = elapsedSeconds < 10
      ? '正在提交图像请求'
      : elapsedSeconds < 30
        ? '图像模型正在生成'
        : elapsedSeconds < 90
          ? '图像生成仍在进行'
          : '图像接口响应较慢，即将停止等待';
    const elapsed = this.formatElapsed(elapsedSeconds);
    this.updatePreview(`${stage}\n已等待 ${elapsed}\n\n可以点击页面其他位置，生成会继续。通常 20-90 秒会返回，超过 3 分钟会自动停止。`);
    const label = this.previewEl?.querySelector('.dc-sel-preview-label') as HTMLElement | null;
    if (label) label.textContent = `${stage} · ${elapsed}`;
  }

  private isImagePrompt(prompt: string): boolean {
    const normalized = prompt.trim().toLowerCase();
    return /^(?:配图|插图|生成图片|生图|画图|图片)(?:\s|$|[:：,，。.!！?？])/.test(normalized)
      || /^(?:image|img|illustration|draw)(?:\s|$|[:：,，。.!！?？])/.test(normalized);
  }

  private formatElapsed(seconds: number): string {
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
  }

  private renderPreviewContent(raw: string): void {
    if (!this.previewTextEl) return;
    this.previewTextEl.innerHTML = this.toSafeRenderedHtml(raw);
  }

  private showImageResult(imageUrl: string, generatedPrompt: string): void {
    if (!this.toolbar) return;
    this.imageGeneratedPrompt = generatedPrompt;
    this.imageResultOpen = true;
    this.clearImageResult();

    const card = document.createElement('div');
    card.className = 'dc-sel-image-result';

    const image = document.createElement('img');
    image.className = 'dc-sel-image-result-img';
    image.alt = '生成的配图';

    const status = document.createElement('div');
    status.className = 'dc-sel-image-result-status';
    status.textContent = '正在复制到剪贴板...';

    const note = document.createElement('input');
    note.type = 'text';
    note.className = 'dc-sel-image-result-note';
    note.placeholder = '补充修改意见，例如更扁平、少文字。Enter 重新生成';
    note.autocomplete = 'off';
    note.spellcheck = false;

    const actions = document.createElement('div');
    actions.className = 'dc-sel-image-result-actions';
    actions.append(
      this.createImageResultButton('复制', 'dc-sel-image-result-btn-primary', () => {
        void this.copyGeneratedImage(imageUrl, false);
      }),
      this.createImageResultButton('重新生成', 'dc-sel-image-result-btn-secondary', () => {
        this.regenerateImage();
      }),
      this.createImageResultButton('关闭', 'dc-sel-image-result-btn-ghost', () => {
        this.hideToolbar();
      }),
    );

    card.append(image, status, note, actions);
    this.toolbar.appendChild(card);
    this.imageResultEl = card;
    this.imageNoteInput = note;

    let composing = false;
    note.addEventListener('compositionstart', () => { composing = true; });
    note.addEventListener('compositionend', () => { composing = false; });
    note.addEventListener('focus', () => { this.isInputFocused = true; });
    note.addEventListener('blur', () => {
      if (document.activeElement !== this.toolbarInput) this.isInputFocused = false;
    });
    note.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !composing) {
        event.preventDefault();
        event.stopPropagation();
        this.regenerateImage();
      }
    });
    image.addEventListener('load', () => this.keepToolbarInViewport());
    this.bindImageResultLayout();
    void this.renderGeneratedImage(image, imageUrl).catch((error) => {
      console.warn('[Doc Copilot] Failed to draw generated image:', error);
      image.alt = '图片无法显示';
      if (status.textContent && /正在复制|复制失败|请点复制/.test(status.textContent)) {
        status.textContent = '图片无法显示，请点重新生成';
      }
      this.keepToolbarInViewport();
    });
    void this.copyGeneratedImage(imageUrl, true);
  }

  private createImageResultButton(
    label: string,
    className: string,
    action: () => void,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `dc-sel-image-result-btn ${className}`;
    button.textContent = label;
    const run = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      action();
    };
    button.addEventListener('mousedown', run);
    button.addEventListener('click', run);
    return button;
  }

  private regenerateImage(): void {
    if (this.isProcessing) return;
    const note = this.imageNoteInput?.value.trim() || '';
    const source = (this.imageSourcePrompt || '配图').trim();
    const lines = [source];
    if (note) lines.push(`修改意见：${note}`);
    if (this.imageGeneratedPrompt) lines.push(`上一版提示词：${this.imageGeneratedPrompt}`);
    const prompt = lines.join('\n');
    const prefixed = this.isImagePrompt(prompt) ? prompt : `配图：${prompt}`;
    void this.runWithPrompt(prefixed, { preserveImageSource: true });
  }

  private async copyGeneratedImage(url: string, automatic: boolean): Promise<void> {
    const card = this.imageResultEl;
    const setStatus = (message: string) => {
      if (!card || this.imageResultEl !== card) return;
      const status = card.querySelector('.dc-sel-image-result-status');
      if (status) status.textContent = message;
    };
    if (!automatic) setStatus('正在复制...');
    const copied = await this.writeImageToClipboard(url);
    if (copied) {
      setStatus(automatic ? '已复制到剪贴板，可直接粘贴' : '已复制到剪贴板');
      return;
    }
    setStatus(automatic ? '自动复制失败，请点复制' : '复制失败，请再试一次');
  }

  private async renderGeneratedImage(slot: HTMLImageElement, url: string): Promise<void> {
    const blob = await this.imageSourceBlob(url);
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = document.createElement('canvas');
      canvas.className = 'dc-sel-image-result-img';
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('canvas unavailable');
      context.drawImage(bitmap, 0, 0);
      slot.replaceWith(canvas);
    } finally {
      bitmap.close();
    }
    this.keepToolbarInViewport();
  }

  private async imageSourceBlob(url: string): Promise<Blob> {
    if (url.startsWith('data:')) return this.blobFromDataUrl(url);
    try {
      return await this.blobFromRemoteUrl(url);
    } catch (error) {
      const response = await chrome.runtime.sendMessage({
        type: 'FETCH_IMAGE_DATA_URL',
        payload: { url },
      }) as { dataUrl?: string; error?: string };
      if (!response?.dataUrl) throw new Error(response?.error || (error as Error).message);
      return this.blobFromDataUrl(response.dataUrl);
    }
  }

  private async writeImageToClipboard(url: string): Promise<boolean> {
    // Generation often finishes after the user has clicked the sidebar or another
    // window. The page clipboard API rejects that; the extension copies instead.
    const copiedInPage = await this.writePngInPage(url);
    if (copiedInPage) return true;
    try {
      const pngDataUrl = await this.imageUrlToPngDataUrl(url);
      return await this.writePngViaExtension(pngDataUrl);
    } catch (error) {
      console.warn('[Doc Copilot] Failed to copy generated image:', error);
      return false;
    }
  }

  private async writePngInPage(url: string): Promise<boolean> {
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return false;
      window.focus();
      await navigator.clipboard.write([
        new ClipboardItem({
          'image/png': this.imageUrlToPngBlob(url),
        }),
      ]);
      return true;
    } catch (error) {
      console.warn('[Doc Copilot] Page clipboard write failed:', error);
      return false;
    }
  }

  private async writePngViaExtension(dataUrl: string): Promise<boolean> {
    const response = await chrome.runtime.sendMessage({
      type: 'COPY_IMAGE_TO_CLIPBOARD',
      payload: { dataUrl },
    }) as { ok?: boolean; error?: string } | undefined;
    if (response?.ok) return true;
    console.warn('[Doc Copilot] Extension clipboard write failed:', response?.error || response);
    return false;
  }

  private async imageUrlToPngDataUrl(url: string): Promise<string> {
    try {
      return await this.blobToDataUrl(await this.imageUrlToPngBlob(url));
    } catch (error) {
      if (url.startsWith('data:')) throw error;
      const response = await chrome.runtime.sendMessage({
        type: 'FETCH_IMAGE_DATA_URL',
        payload: { url },
      }) as { dataUrl?: string; error?: string };
      if (!response?.dataUrl) throw new Error(response?.error || (error as Error).message);
      return await this.blobToDataUrl(await this.imageUrlToPngBlob(response.dataUrl));
    }
  }

  private blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'));
      reader.readAsDataURL(blob);
    });
  }

  private async imageUrlToPngBlob(url: string): Promise<Blob> {
    const blob = url.startsWith('data:')
      ? await this.blobFromDataUrl(url)
      : await this.blobFromRemoteUrl(url);
    if (blob.type === 'image/png') return blob;
    return this.convertBlobToPng(blob);
  }

  private async blobFromDataUrl(url: string): Promise<Blob> {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
    if (!match) throw new Error('invalid image data url');
    const mime = match[1] || 'application/octet-stream';
    const payload = match[3] || '';
    if (match[2]) {
      const binary = atob(payload.replace(/\s+/g, ''));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return new Blob([bytes], { type: mime });
    }
    return new Blob([decodeURIComponent(payload)], { type: mime });
  }

  private async blobFromRemoteUrl(url: string): Promise<Blob> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`image fetch failed: ${response.status}`);
    return response.blob();
  }

  private async convertBlobToPng(blob: Blob): Promise<Blob> {
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('canvas unavailable');
      context.drawImage(bitmap, 0, 0);
      const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!png) throw new Error('png conversion failed');
      return png;
    } finally {
      bitmap.close();
    }
  }

  private clearImageResult(): void {
    this.unbindImageResultLayout();
    this.imageResultEl?.remove();
    this.imageResultEl = null;
    this.imageNoteInput = null;
  }

  private bindImageResultLayout(): void {
    if (this.imageResultLayoutBound) return;
    this.imageResultLayoutBound = true;
    window.addEventListener('resize', this.keepToolbarInViewport);
  }

  private unbindImageResultLayout(): void {
    if (!this.imageResultLayoutBound) return;
    this.imageResultLayoutBound = false;
    window.removeEventListener('resize', this.keepToolbarInViewport);
  }

  private keepToolbarInViewport = (): void => {
    const toolbar = this.toolbar;
    if (!toolbar || toolbar.style.display === 'none') return;
    const margin = 8;
    const image = toolbar.querySelector('.dc-sel-image-result-img') as HTMLImageElement | null;
    if (image) image.style.maxHeight = '';

    const place = () => {
      const rect = toolbar.getBoundingClientRect();
      let top = rect.top;
      let left = rect.left;
      const maxBottom = window.innerHeight - margin;
      if (rect.bottom > maxBottom) {
        top -= rect.bottom - maxBottom;
      }
      if (top < margin) top = margin;
      if (rect.right > window.innerWidth - margin) {
        left = window.innerWidth - rect.width - margin;
      }
      if (left < margin) left = margin;
      toolbar.style.top = `${Math.round(top)}px`;
      toolbar.style.left = `${Math.round(left)}px`;
    };

    place();
    if (!image) return;

    const fitted = toolbar.getBoundingClientRect();
    const overflow = fitted.bottom - (window.innerHeight - margin);
    if (overflow > 1) {
      const nextHeight = Math.max(64, Math.floor(image.getBoundingClientRect().height - overflow));
      image.style.maxHeight = `${nextHeight}px`;
      place();
    }
  };

  /** Hide and detach the preview area. */
  private hidePreview(): void {
    if (this.previewEl) {
      this.previewEl.remove();
      this.previewEl = null;
      this.previewTextEl = null;
    }
  }

  /**
   * Called when streaming is complete.
   * Transitions the preview from "generating" to "done" state,
   * and shows Accept / Discard action buttons.
   */
  private finalizePreview(range: Range, resultText: string, resultHtml: string): void {
    if (!this.previewEl || !this.previewTextEl) return;

    // Update header to "done" state
    const label = this.previewEl.querySelector('.dc-sel-preview-label') as HTMLElement | null;
    if (label) label.textContent = '生成完成';
    const dot = this.previewEl.querySelector('.dc-sel-preview-dot') as HTMLElement | null;
    dot?.classList.add('dc-sel-preview-dot-done');

    // Action buttons row
    const actions = document.createElement('div');
    actions.className = 'dc-sel-preview-actions';

    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'dc-sel-preview-btn dc-sel-preview-btn-accept';
    acceptBtn.textContent = '替换';

    const discardBtn = document.createElement('button');
    discardBtn.className = 'dc-sel-preview-btn dc-sel-preview-btn-discard';
    discardBtn.textContent = '放弃';

    const applyResult = () => {
      const safeHtml = resultHtml ? this.toSafeRenderedHtml(resultHtml) : '';
      if (safeHtml) {
        this.adapter.replaceRangeWithHtml(range, safeHtml, resultText);
      } else {
        this.adapter.replaceRange(range, resultText);
      }
      this.hideToolbar();
    };

    acceptBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      applyResult();
    });

    discardBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.hideToolbar();
    });

    actions.appendChild(acceptBtn);
    actions.appendChild(discardBtn);
    this.previewEl.appendChild(actions);

    // Prevent toolbar wrapper mousedown from stealing focus
    actions.addEventListener('mousedown', (e) => e.preventDefault());
  }

  private toSafeRenderedHtml(raw: string): string {
    const text = (raw || '').trim();
    if (!text) return '';

    const withoutFence = text
      .replace(/^```(?:html|markdown|md)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const html = /<[a-z][\s\S]*>/i.test(withoutFence)
      ? withoutFence
      : this.markdownToHtml(withoutFence);

    return this.sanitizeHtml(html);
  }

  private markdownToHtml(markdown: string): string {
    const lines = markdown.replace(/\r\n/g, '\n').split('\n');
    const html: string[] = [];
    let paragraph: string[] = [];
    let listType: 'ul' | 'ol' | null = null;

    const closeParagraph = () => {
      if (!paragraph.length) return;
      html.push(`<p>${paragraph.map(line => this.renderInlineMarkdown(line)).join('<br>')}</p>`);
      paragraph = [];
    };

    const closeList = () => {
      if (!listType) return;
      html.push(`</${listType}>`);
      listType = null;
    };

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        closeParagraph();
        closeList();
        continue;
      }

      const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
      if (heading) {
        closeParagraph();
        closeList();
        const level = Math.min(heading[1].length, 4);
        html.push(`<h${level}>${this.renderInlineMarkdown(heading[2])}</h${level}>`);
        continue;
      }

      const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
      if (bullet) {
        closeParagraph();
        if (listType !== 'ul') {
          closeList();
          html.push('<ul>');
          listType = 'ul';
        }
        html.push(`<li>${this.renderInlineMarkdown(bullet[1])}</li>`);
        continue;
      }

      const ordered = /^\d+[.)]\s+(.+)$/.exec(trimmed);
      if (ordered) {
        closeParagraph();
        if (listType !== 'ol') {
          closeList();
          html.push('<ol>');
          listType = 'ol';
        }
        html.push(`<li>${this.renderInlineMarkdown(ordered[1])}</li>`);
        continue;
      }

      closeList();
      paragraph.push(line);
    }

    closeParagraph();
    closeList();
    return html.join('');
  }

  private renderInlineMarkdown(text: string): string {
    let html = this.escapeHtml(text);
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    return html;
  }

  private sanitizeHtml(html: string): string {
    const template = document.createElement('template');
    template.innerHTML = html;

    const allowedTags = new Set([
      'P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'CODE', 'PRE',
      'UL', 'OL', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'A',
    ]);

    const walk = (node: Node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          const el = child as HTMLElement;
          if (!allowedTags.has(el.tagName)) {
            el.replaceWith(...Array.from(el.childNodes));
            continue;
          }

          for (const attr of Array.from(el.attributes)) {
            const name = attr.name.toLowerCase();
            const value = attr.value;
            const keepHref = el.tagName === 'A'
              && name === 'href'
              && /^(https?:|mailto:)/i.test(value);
            if (!keepHref) {
              el.removeAttribute(attr.name);
            }
          }

          if (el.tagName === 'A') {
            el.setAttribute('target', '_blank');
            el.setAttribute('rel', 'noopener noreferrer');
          }
        }
        walk(child);
      }
    };

    walk(template.content);
    return template.innerHTML;
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private extractSemanticHtml(source: HTMLElement | DocumentFragment): string {
    const clone = source.cloneNode(true) as HTMLElement | DocumentFragment;
    const root = clone instanceof DocumentFragment
      ? (() => { const d = document.createElement('div'); d.appendChild(clone); return d; })()
      : clone;

    root.querySelectorAll(
      'span[data-slate-zero-width], span[data-slate-placeholder], ' +
      '.mp-list-item-bullet, .mp-block-code-top-bar, .mp-heading-order-container'
    ).forEach(el => el.remove());

    for (const { selector, tag } of SLATE_MARK_MAP) {
      root.querySelectorAll(selector).forEach(el => {
        const replacement = document.createElement(tag);
        replacement.innerHTML = el.innerHTML;
        el.replaceWith(replacement);
      });
    }

    root.querySelectorAll(
      'span[data-slate-node], span[data-slate-leaf], span[data-slate-string]'
    ).forEach(span => span.replaceWith(...Array.from(span.childNodes)));

    const html = root.innerHTML.trim();
    const hasMarkup = /<(strong|em|u|s|code)[^>]*>/i.test(html);
    return hasMarkup ? html : '';
  }

  private showNotification(msg: string, type: 'error' | 'info' | 'success'): void {
    const el = document.createElement('div');
    el.className = `dc-notification dc-notification-${type}`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => {
      el.classList.add('dc-notification-fade');
      setTimeout(() => el.remove(), 300);
    }, 3000);
  }
}
