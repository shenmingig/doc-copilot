// ============================================================
// Chrome Document Adapter - Handles contentEditable & textarea
// ============================================================

import { IDocumentAdapter } from '../base/adapter';
import {
  Position,
  Range,
  DocumentContext,
  ContentChange,
  Disposable,
} from '../../shared/types/index';
import { detectLanguage } from '../../shared/utils/index';

const EDITABLE_TEXT_BLOCK_SELECTOR = [
  '[data-slate-node="element"]',
  '.mp-paragraph-wrapper',
  '.mp-heading-wrapper',
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

export class ChromeDocumentAdapter implements IDocumentAdapter {
  readonly platform = 'chrome' as const;

  private element: HTMLElement | null = null;
  private ghostTextElement: HTMLElement | null = null;
  private contentChangeCallbacks: Array<(change: ContentChange) => void> = [];
  private cursorChangeCallbacks: Array<(pos: Position) => void> = [];
  private mutationObserver: MutationObserver | null = null;
  private disposables: Array<() => void> = [];
  private ignoreMutationsUntil = 0;
  private lastActiveBlock: HTMLElement | null = null;
  private lastActiveBlockAt = 0;

  private get isTextarea(): boolean {
    return this.element instanceof HTMLTextAreaElement || this.element instanceof HTMLInputElement;
  }

  canAttach(): boolean {
    const active = document.activeElement;
    if (!active) return false;
    if (active instanceof HTMLTextAreaElement) return true;
    if (active instanceof HTMLInputElement && active.type === 'text') return true;
    if ((active as HTMLElement).isContentEditable) return true;
    return false;
  }

  attach(element: HTMLElement): void {
    this.detach();
    this.element = element;
    this.setupListeners();
  }

  detach(): void {
    this.disposables.forEach(d => d());
    this.disposables = [];
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.removeGhostText();
    this.element = null;
    this.lastActiveBlock = null;
    this.lastActiveBlockAt = 0;
  }

  isAttached(): boolean {
    return this.element !== null;
  }

  getAttachedElement(): HTMLElement | null {
    return this.element;
  }

  shouldPreserveImageSelection(): boolean {
    return this.isFeishuEditor();
  }

  getText(): string {
    if (!this.element) return '';
    if (this.isTextarea) {
      return (this.element as HTMLTextAreaElement).value;
    }
    return this.element.innerText || this.element.textContent || '';
  }

  getSelectedText(): string {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return '';
    if (!this.isTextarea) {
      if (!this.element || sel.rangeCount === 0) return '';
      const range = sel.getRangeAt(0);
      if (!this.isNodeInsideElement(range.startContainer) || !this.isNodeInsideElement(range.endContainer)) {
        return '';
      }
    }
    return sel.toString();
  }

  getCursorPosition(): Position {
    if (!this.element) return { line: 0, character: 0, offset: 0 };

    if (this.isTextarea) {
      const el = this.element as HTMLTextAreaElement;
      const offset = el.selectionStart;
      const textBefore = el.value.slice(0, offset);
      const lines = textBefore.split('\n');
      return {
        line: lines.length - 1,
        character: lines[lines.length - 1].length,
        offset,
      };
    }

    // contentEditable
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      return this.getActiveBlockCursorPosition() || { line: 0, character: 0, offset: 0 };
    }

    const range = sel.getRangeAt(0);
    if (!this.isNodeInsideElement(range.startContainer)) {
      return this.getActiveBlockCursorPosition() || { line: 0, character: 0, offset: 0 };
    }

    const offset = this.getOffsetInElement(this.element, range.startContainer, range.startOffset);
    const text = this.getText();
    const textBefore = text.slice(0, offset);
    const lines = textBefore.split('\n');

    return {
      line: lines.length - 1,
      character: lines[lines.length - 1].length,
      offset,
    };
  }

  getSelectionRange(): Range | null {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !this.element) return null;

    if (this.isTextarea) {
      const el = this.element as HTMLTextAreaElement;
      const text = el.value;
      const start = el.selectionStart;
      const end = el.selectionEnd;

      return {
        start: this.offsetToPosition(text, start),
        end: this.offsetToPosition(text, end),
      };
    }

    const range = sel.getRangeAt(0);
    if (!this.isNodeInsideElement(range.startContainer) || !this.isNodeInsideElement(range.endContainer)) {
      return null;
    }

    const startOffset = this.getOffsetInElement(this.element, range.startContainer, range.startOffset);
    const endOffset = this.getOffsetInElement(this.element, range.endContainer, range.endOffset);
    const text = this.getText();

    return {
      start: this.offsetToPosition(text, startOffset),
      end: this.offsetToPosition(text, endOffset),
    };
  }

  getElementRange(target: HTMLElement): Range | null {
    if (!this.element || !this.element.contains(target)) return null;

    const startOffset = this.getTextOffsetBeforeNode(this.element, target);
    const endOffset = this.getTextOffsetAfterNode(this.element, target);
    if (startOffset === null || endOffset === null || endOffset <= startOffset) return null;

    const text = this.getText();
    return {
      start: this.offsetToPosition(text, startOffset),
      end: this.offsetToPosition(text, endOffset),
    };
  }

  insertText(position: Position, text: string): void {
    if (!this.element) return;

    if (this.isTextarea) {
      const el = this.element as HTMLTextAreaElement;
      const before = el.value.slice(0, position.offset);
      const after = el.value.slice(position.offset);
      el.value = before + text + after;
      el.selectionStart = el.selectionEnd = position.offset + text.length;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    // contentEditable
    const sel = window.getSelection();
    if (!sel) return;

    this.setCursorAtOffset(position.offset);
    this.insertViaInputEvent(text);
  }

  replaceRange(range: Range, text: string): void {
    if (!this.element) return;

    if (this.isTextarea) {
      const el = this.element as HTMLTextAreaElement;
      const before = el.value.slice(0, range.start.offset);
      const after = el.value.slice(range.end.offset);
      el.value = before + text + after;
      el.selectionStart = el.selectionEnd = range.start.offset + text.length;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    // contentEditable
    const sel = window.getSelection();
    if (!sel) return;

    // Select the range
    const nativeRange = document.createRange();
    const startResult = this.getNodeAtOffset(this.element, range.start.offset);
    const endResult = this.getNodeAtOffset(this.element, range.end.offset);

    if (startResult && endResult) {
      nativeRange.setStart(startResult.node, startResult.offset);
      nativeRange.setEnd(endResult.node, endResult.offset);
      sel.removeAllRanges();
      sel.addRange(nativeRange);
      this.insertViaInputEvent(text);
    }
  }

  /**
   * Replace a range with rich HTML content, preserving formatting.
   * Tries ClipboardEvent paste (Slate.js handles text/html via its paste handler),
   * then falls back to plain text insertion.
   */
  replaceRangeWithHtml(range: Range, html: string, plainFallback: string): void {
    if (!this.element || this.isTextarea) {
      this.replaceRange(range, plainFallback);
      return;
    }

    const sel = window.getSelection();
    if (!sel) { this.replaceRange(range, plainFallback); return; }

    const startResult = this.getNodeAtOffset(this.element, range.start.offset);
    const endResult = this.getNodeAtOffset(this.element, range.end.offset);
    if (!startResult || !endResult) { this.replaceRange(range, plainFallback); return; }

    const nativeRange = document.createRange();
    nativeRange.setStart(startResult.node, startResult.offset);
    nativeRange.setEnd(endResult.node, endResult.offset);
    sel.removeAllRanges();
    sel.addRange(nativeRange);

    // Try 1: ClipboardEvent('paste') — Slate.js listens for paste events and
    // deserialises text/html into its own node model, preserving bold/italic etc.
    try {
      const dt = new DataTransfer();
      dt.setData('text/html', html);
      dt.setData('text/plain', plainFallback);
      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      const notPrevented = this.element.dispatchEvent(pasteEvent);
      if (!notPrevented) {
        // Slate called preventDefault() → it handled the paste, we're done
        return;
      }
    } catch (_) { /* ignore */ }

    // Try 2: beforeinput insertFromPaste — newer Slate versions use this instead
    try {
      const dt = new DataTransfer();
      dt.setData('text/html', html);
      dt.setData('text/plain', plainFallback);
      const inputEvent = new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertFromPaste',
        dataTransfer: dt,
      });
      const notPrevented = this.element.dispatchEvent(inputEvent);
      if (!notPrevented) {
        return;
      }
    } catch (_) { /* ignore */ }

    // Fallback: plain text insertion
    this.insertViaInputEvent(plainFallback);
  }

  showGhostText(position: Position, text: string): void {
    this.removeGhostText();
    if (!this.element || !text) return;

    if (this.isTextarea) {
      this.showGhostTextTextarea(position, text);
    } else {
      this.showGhostTextContentEditable(position, text);
    }
  }

  removeGhostText(): void {
    if (this.ghostTextElement) {
      this.ghostTextElement.remove();
      this.ghostTextElement = null;
    }
    // Also remove any inline ghost spans
    document.querySelectorAll('.doc-copilot-ghost-text').forEach(el => el.remove());
  }

  acceptGhostText(): void {
    const ghost = this.ghostTextElement;
    if (!ghost) return;

    // Read text and offset BEFORE removing ghost element
    const text = ghost.dataset.text || '';
    const offset = parseInt(ghost.dataset.offset || '0', 10);
    this.removeGhostText();

    if (!text || !this.element) return;

    if (this.isTextarea) {
      // For textarea: directly splice the value and update cursor position
      const el = this.element as HTMLTextAreaElement;
      const before = el.value.slice(0, offset);
      const after = el.value.slice(offset);
      el.value = before + text + after;
      el.selectionStart = el.selectionEnd = offset + text.length;
      el.focus();
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // For contentEditable (including Slate.js):
      // Slate listens to 'beforeinput' InputEvent, not execCommand.
      // We dispatch a synthetic 'insertText' InputEvent.
      (this.getInputEventTarget() || this.element).focus();
      this.setCursorAtOffset(offset);
      this.insertViaInputEvent(text);
    }
  }

  insertImage(url: string, alt = '', range?: Range | null): boolean {
    if (!this.element || this.isTextarea) return false;
    if (this.shouldPreserveImageSelection()) {
      // Feishu rejects image paste unless it lands in a fresh text block.
      // Callers must use insertImageAfterElement(), which verifies the image.
      console.warn('[Doc Copilot] Feishu image insertion needs an anchor paragraph.');
      return false;
    }
    this.element.focus();

    const insertionRange = range ? this.getImageInsertionRange(range) : this.getCurrentCollapsedRangeInsideElement();
    if (insertionRange && window.getSelection()) {
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(insertionRange.cloneRange());
    }

    if (this.isCsdnMarkdownEditor()) {
      // CSDN cannot transfer a data: URL embedded in Markdown. Its editor does,
      // however, accept a pasted image File and uploads it through its own image
      // pipeline. Prefer that path for generated Base64 images.
      if (url.startsWith('data:image/') && this.insertImageViaPaste(url, alt)) {
        return true;
      }
      const position = range?.end ?? this.getCursorPosition();
      const markdown = `\n![${alt || '图片'}](${url})\n`;
      this.insertText(position, markdown);
      return true;
    }

    if (this.insertImageViaPaste(url, alt)) {
      return true;
    }

    const container = this.createImageContainer(url, alt);

    if (insertionRange) {
      this.insertNodeAfterRange(insertionRange, container);
      this.element.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }

    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const nativeRange = sel.getRangeAt(0);
      nativeRange.collapse(false);
      this.insertNodeWithBreaks(nativeRange, container);
      nativeRange.setStartAfter(container);
      nativeRange.setEndAfter(container);
      sel.removeAllRanges();
      sel.addRange(nativeRange);
    } else {
      this.element.appendChild(container);
    }
    this.element.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  insertImageReplacingRange(url: string, alt = '', range?: Range | null): boolean {
    if (!this.element || this.isTextarea) return false;
    this.element.focus();

    const replacementRange = range ? this.nativeRangeFromTextRange(range) : this.getCurrentRangeInsideElement();
    if (replacementRange && window.getSelection()) {
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(replacementRange.cloneRange());
    }

    if (this.isCsdnMarkdownEditor()) {
      if (url.startsWith('data:image/') && this.insertImageViaPaste(url, alt)) {
        return true;
      }
      const markdown = `![${alt || '图片'}](${url})`;
      if (range) this.replaceRange(range, markdown);
      else this.insertText(this.getCursorPosition(), markdown);
      return true;
    }

    if (this.shouldPreserveImageSelection()) {
      console.warn('[Doc Copilot] Feishu image replacement is disabled to preserve selected text.');
      return false;
    }

    if (this.insertImageViaPaste(url, alt)) {
      return true;
    }

    const container = this.createImageContainer(url, alt);
    if (replacementRange) {
      replacementRange.deleteContents();
      this.insertNodeWithBreaks(replacementRange, container);
      replacementRange.setStartAfter(container);
      replacementRange.setEndAfter(container);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(replacementRange);
      }
      this.element.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }

    return this.insertImage(url, alt);
  }

  insertImageAfterElement(url: string, alt = '', anchor: HTMLElement, preserveText = ''): boolean | Promise<boolean> {
    if (this.shouldPreserveImageSelection()) {
      return this.insertFeishuImageBelow(url, alt, anchor, preserveText);
    }

    if (!this.element || this.isTextarea || !this.element.contains(anchor)) {
      return this.insertImage(url, alt);
    }

    this.element.focus();
    const block = this.findImageInsertionBlock(anchor);
    if (!block?.parentNode || block === this.element || !this.element.contains(block)) {
      return this.insertImage(url, alt);
    }

    const insertionRange = this.createRangeAfter(block);
    this.selectNativeRange(insertionRange);

    if (this.insertImageViaPaste(url, alt)) {
      return true;
    }

    const container = this.createImageContainer(url, alt);
    this.insertNodeAfterRange(insertionRange, container);
    this.element.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  getContext(cursorPos?: Position, windowSize: number = 800): DocumentContext {
    const fullText = this.getText();
    const selectionContext = this.getSelectionContextText();
    const blockContext = selectionContext ? null : this.getActiveBlockCursorContext();
    const pos = cursorPos || blockContext?.position || this.getCursorPosition();
    const selectedText = this.getSelectedText();

    const textBeforeSource = selectionContext?.textBefore ?? blockContext?.textBefore ?? fullText.slice(0, pos.offset);
    const textAfterSource = selectionContext?.textAfter ?? blockContext?.textAfter ?? fullText.slice(pos.offset);
    const textBefore = this.cleanContextText(
      textBeforeSource.slice(Math.max(0, textBeforeSource.length - windowSize)),
    );
    const textAfter = this.cleanContextText(textAfterSource.slice(0, windowSize));
    const cleanFullText = this.cleanContextText(fullText);

    let elementType: DocumentContext['elementType'] = 'unknown';
    if (this.element instanceof HTMLTextAreaElement) elementType = 'textarea';
    else if (this.element instanceof HTMLInputElement) elementType = 'input';
    else if (this.element?.isContentEditable) elementType = 'contenteditable';

    return {
      textBefore,
      textAfter,
      selectedText: this.cleanContextText(selectedText),
      fullText: cleanFullText.length < 10000 ? cleanFullText : null,
      cursorPosition: pos,
      language: detectLanguage(cleanFullText.slice(0, 500)),
      title: document.title,
      elementType,
    };
  }

  onContentChange(callback: (change: ContentChange) => void): Disposable {
    this.contentChangeCallbacks.push(callback);
    return {
      dispose: () => {
        this.contentChangeCallbacks = this.contentChangeCallbacks.filter(cb => cb !== callback);
      },
    };
  }

  onCursorChange(callback: (pos: Position) => void): Disposable {
    this.cursorChangeCallbacks.push(callback);
    return {
      dispose: () => {
        this.cursorChangeCallbacks = this.cursorChangeCallbacks.filter(cb => cb !== callback);
      },
    };
  }

  dispose(): void {
    this.detach();
    this.contentChangeCallbacks = [];
    this.cursorChangeCallbacks = [];
  }

  // --- Private Helpers ---

  private setupListeners(): void {
    if (!this.element) return;

    // Input event for content changes
    const onInput = () => {
      const pos = this.getCursorPosition();
      const change: ContentChange = {
        range: { start: pos, end: pos },
        text: '',
        timestamp: Date.now(),
      };
      this.contentChangeCallbacks.forEach(cb => cb(change));
    };

    // Selection change for cursor tracking
    const onSelectionChange = () => {
      if (!this.element) return;
      // Only fire if this element is focused
      if (document.activeElement !== this.element &&
          !this.element.contains(document.activeElement)) return;

      const pos = this.getCursorPosition();
      this.cursorChangeCallbacks.forEach(cb => cb(pos));
    };

    this.element.addEventListener('input', onInput);
    document.addEventListener('selectionchange', onSelectionChange);

    this.disposables.push(
      () => this.element?.removeEventListener('input', onInput),
      () => document.removeEventListener('selectionchange', onSelectionChange),
    );

    // MutationObserver for contentEditable
    if (!this.isTextarea) {
      this.mutationObserver = new MutationObserver((records) => {
        if (Date.now() < this.ignoreMutationsUntil) return;
        this.rememberActiveBlockFromMutations(records);
        onInput();
      });
      this.mutationObserver.observe(this.element, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
  }

  private showGhostTextTextarea(position: Position, text: string): void {
    if (!this.element) return;
    const el = this.element as HTMLTextAreaElement;

    // Create an overlay div that mirrors textarea positioning
    const rect = el.getBoundingClientRect();
    const styles = window.getComputedStyle(el);

    // Create a mirror div to calculate cursor pixel position
    const mirror = document.createElement('div');
    mirror.style.cssText = `
      position: absolute;
      visibility: hidden;
      white-space: pre-wrap;
      word-wrap: break-word;
      overflow: hidden;
      font: ${styles.font};
      padding: ${styles.padding};
      border: ${styles.border};
      width: ${styles.width};
      line-height: ${styles.lineHeight};
      letter-spacing: ${styles.letterSpacing};
    `;
    mirror.textContent = el.value.slice(0, position.offset);

    // Add a span to measure cursor position
    const cursorSpan = document.createElement('span');
    cursorSpan.textContent = '|';
    mirror.appendChild(cursorSpan);
    document.body.appendChild(mirror);

    const cursorRect = cursorSpan.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();
    document.body.removeChild(mirror);

    const relativeTop = cursorRect.top - mirrorRect.top;
    const relativeLeft = cursorRect.left - mirrorRect.left;

    // Create ghost text overlay
    this.ghostTextElement = document.createElement('div');
    this.ghostTextElement.className = 'doc-copilot-ghost-text';
    this.ghostTextElement.dataset.text = text;
    this.ghostTextElement.dataset.offset = String(position.offset);
    this.ghostTextElement.style.cssText = `
      position: fixed;
      top: ${rect.top + relativeTop - el.scrollTop}px;
      left: ${rect.left + relativeLeft}px;
      color: #999;
      opacity: 0.6;
      font: ${styles.font};
      line-height: ${styles.lineHeight};
      letter-spacing: ${styles.letterSpacing};
      pointer-events: none;
      z-index: 10000;
      white-space: pre-wrap;
      max-width: ${rect.right - (rect.left + relativeLeft)}px;
    `;
    this.ghostTextElement.textContent = text;
    document.body.appendChild(this.ghostTextElement);
  }

  private showGhostTextContentEditable(position: Position, text: string): void {
    if (!this.element) return;

    let rect: DOMRect | null = null;

    const currentRange = this.getCurrentCollapsedRangeInsideElement();
    const currentPosition = currentRange ? this.getCursorPosition() : null;
    if (currentRange && currentPosition?.offset === position.offset) {
      rect = this.getCaretRect(currentRange);
    }

    if (!rect) {
      const offsetResult = this.getNodeAtOffset(this.element, position.offset);
      if (offsetResult) {
        const range = document.createRange();
        range.setStart(offsetResult.node, offsetResult.offset);
        range.collapse(true);
        rect = this.getCaretRect(range);
      }
    }

    if (!rect || (!rect.width && !rect.height)) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        rect = this.getCaretRect(sel.getRangeAt(0));
      }
    }

    if (!rect) return;

    if (!rect.width && !rect.height) {
      // Collapsed cursor, use element position
      const elRect = this.element.getBoundingClientRect();
      this.createGhostOverlay(text, position.offset, elRect.left, elRect.top);
    } else {
      this.createGhostOverlay(text, position.offset, rect.right || rect.left, rect.top);
    }
  }

  private createGhostOverlay(text: string, offset: number, left: number, top: number): void {
    const styles = this.element ? window.getComputedStyle(this.element) : null;

    this.ghostTextElement = document.createElement('span');
    this.ghostTextElement.className = 'doc-copilot-ghost-text';
    this.ghostTextElement.dataset.text = text;
    this.ghostTextElement.dataset.offset = String(offset);
    this.ghostTextElement.style.cssText = `
      position: fixed;
      top: ${top}px;
      left: ${left}px;
      color: #999;
      opacity: 0.6;
      font: ${styles?.font || 'inherit'};
      pointer-events: none;
      z-index: 10000;
      white-space: pre-wrap;
    `;
    this.ghostTextElement.textContent = text;
    document.body.appendChild(this.ghostTextElement);
  }

  private offsetToPosition(text: string, offset: number): Position {
    const before = text.slice(0, offset);
    const lines = before.split('\n');
    return {
      line: lines.length - 1,
      character: lines[lines.length - 1].length,
      offset,
    };
  }

  private getOffsetInElement(root: Node, targetNode: Node, targetOffset: number): number {
    let offset = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

    let node = walker.nextNode();
    while (node) {
      if (node === targetNode) {
        return offset + targetOffset;
      }
      offset += node.textContent?.length || 0;
      node = walker.nextNode();
    }

    return offset;
  }

  private getSelectionContextText(): { textBefore: string; textAfter: string } | null {
    if (!this.element || this.isTextarea) return null;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;

    const range = sel.getRangeAt(0);
    if (
      !this.isNodeInsideElement(range.startContainer) ||
      !this.isNodeInsideElement(range.endContainer)
    ) {
      return null;
    }

    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(this.element);
    beforeRange.setEnd(range.startContainer, range.startOffset);

    const afterRange = document.createRange();
    afterRange.selectNodeContents(this.element);
    afterRange.setStart(range.endContainer, range.endOffset);

    const textAfter = afterRange.toString();
    return {
      textBefore: beforeRange.toString(),
      textAfter: this.isRangeAtEndOfTextBlock(range) && textAfter ? `\n${textAfter}` : textAfter,
    };
  }

  private isNodeInsideElement(node: Node): boolean {
    return !!this.element && (node === this.element || this.element.contains(node));
  }

  private getActiveBlockCursorContext(): { position: Position; textBefore: string; textAfter: string } | null {
    const block = this.getRecentActiveBlock();
    if (!block || !this.element) return null;

    const endOffset = this.getTextOffsetAfterNode(this.element, block);
    if (endOffset === null) return null;

    const text = this.getText();
    const position = this.offsetToPosition(text, endOffset);

    try {
      const beforeRange = document.createRange();
      beforeRange.selectNodeContents(this.element);
      beforeRange.setEndAfter(block);

      const afterRange = document.createRange();
      afterRange.selectNodeContents(this.element);
      afterRange.setStartAfter(block);

      const textAfter = afterRange.toString();
      return {
        position,
        textBefore: beforeRange.toString(),
        textAfter: textAfter ? `\n${textAfter}` : '',
      };
    } catch {
      return {
        position,
        textBefore: text.slice(0, endOffset),
        textAfter: '',
      };
    }
  }

  private getActiveBlockCursorPosition(): Position | null {
    return this.getActiveBlockCursorContext()?.position ?? null;
  }

  private getRecentActiveBlock(): HTMLElement | null {
    if (!this.element || !this.lastActiveBlock) return null;
    if (!this.lastActiveBlock.isConnected || !this.element.contains(this.lastActiveBlock)) return null;
    if (Date.now() - this.lastActiveBlockAt > 15_000) return null;
    return this.lastActiveBlock;
  }

  private rememberActiveBlockFromMutations(records: MutationRecord[]): void {
    for (const record of records) {
      const block = this.findEditableTextBlock(record.target);
      if (block) {
        this.rememberActiveBlock(block);
        return;
      }

      for (const node of Array.from(record.addedNodes)) {
        const addedBlock = this.findEditableTextBlock(node);
        if (addedBlock) {
          this.rememberActiveBlock(addedBlock);
          return;
        }
      }
    }
  }

  private rememberActiveBlock(block: HTMLElement): void {
    this.lastActiveBlock = block;
    this.lastActiveBlockAt = Date.now();
  }

  private findEditableTextBlock(node: Node): HTMLElement | null {
    if (!this.element) return null;

    const element = node instanceof HTMLElement ? node : node.parentElement;
    const block = element?.closest(EDITABLE_TEXT_BLOCK_SELECTOR) as HTMLElement | null;
    if (!block || block === this.element || !this.element.contains(block)) return null;
    return block;
  }

  private isRangeAtEndOfTextBlock(range: globalThis.Range): boolean {
    const block = this.findEditableTextBlock(range.endContainer);
    if (!block) return false;

    try {
      const rest = document.createRange();
      rest.setStart(range.endContainer, range.endOffset);
      rest.setEndAfter(block);
      return this.cleanContextText(rest.toString()).trim().length === 0;
    } catch {
      return false;
    }
  }

  private getNodeAtOffset(root: Node, targetOffset: number): { node: Node; offset: number } | null {
    let currentOffset = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let lastTextNode: Node | null = null;

    let node = walker.nextNode();
    while (node) {
      const len = node.textContent?.length || 0;
      lastTextNode = node;

      if (targetOffset <= currentOffset) {
        return { node, offset: 0 };
      }

      if (targetOffset < currentOffset + len) {
        return { node, offset: targetOffset - currentOffset };
      }

      currentOffset += len;
      node = walker.nextNode();
    }

    if (lastTextNode) {
      return { node: lastTextNode, offset: lastTextNode.textContent?.length || 0 };
    }

    return null;
  }

  private nativeRangeFromTextRange(range: Range): globalThis.Range | null {
    if (!this.element) return null;

    const startResult = this.getNodeAtOffset(this.element, range.start.offset);
    const endResult = this.getNodeAtOffset(this.element, range.end.offset);
    if (!startResult || !endResult) return null;

    const nativeRange = document.createRange();
    nativeRange.setStart(startResult.node, startResult.offset);
    nativeRange.setEnd(endResult.node, endResult.offset);
    return nativeRange;
  }

  private getImageInsertionRange(range: Range): globalThis.Range | null {
    const nativeRange = this.nativeRangeFromTextRange(range);
    if (!nativeRange || !this.element) return nativeRange;

    // Prefer inserting after the containing block so generated images land
    // below the selected paragraph/title instead of replacing inline content.
    const endBlock = this.findClosestEditableBlock(nativeRange.endContainer);
    const startBlock = this.findClosestEditableBlock(nativeRange.startContainer);
    const block = endBlock || startBlock;

    if (block && block !== this.element && block.parentNode) {
      if (this.shouldPreserveImageSelection()) {
        const insertionBlock = this.findImageInsertionBlock(block) || block;
        const editor = this.getFeishuBlockEditor(insertionBlock) || this.getFeishuBlockEditor(block);
        if (editor) return this.createCollapsedRangeAtEnd(editor);
      }

      const insertionRange = document.createRange();
      insertionRange.setStartAfter(this.findImageInsertionBlock(block) || block);
      insertionRange.collapse(true);
      return insertionRange;
    }

    nativeRange.collapse(false);
    return nativeRange;
  }

  private findClosestEditableBlock(node: Node): HTMLElement | null {
    if (!this.element) return null;

    const element = node instanceof HTMLElement ? node : node.parentElement;
    const tableBlock = element?.closest(
      '.mp-table-wrapper[data-slate-node="element"], .mp-table-align.mp-table-root',
    ) as HTMLElement | null;
    if (tableBlock && this.element.contains(tableBlock) && tableBlock !== this.element) {
      return tableBlock;
    }

    const block = element?.closest(EDITABLE_TEXT_BLOCK_SELECTOR) as HTMLElement | null;

    if (!block || !this.element.contains(block)) return null;
    if (block === this.element) return null;
    return block;
  }

  private findImageInsertionBlock(anchor: HTMLElement): HTMLElement | null {
    if (!this.element) return null;

    const feishuBlock = anchor.closest('.block[data-block-id], .block[class*="docx-"][data-block-id]') as HTMLElement | null;
    if (feishuBlock && this.element.contains(feishuBlock) && feishuBlock !== this.element) {
      return feishuBlock;
    }

    const tableRoot = anchor.closest(
      '.mp-table-wrapper, .mp-table-align.mp-table-root, table.mp-table',
    ) as HTMLElement | null;
    if (tableRoot && this.element.contains(tableRoot)) {
      const card = tableRoot.closest('.mp-card') as HTMLElement | null;
      if (card && this.element.contains(card) && card !== this.element) return card;

      const slateCard = tableRoot.closest('.slate-card') as HTMLElement | null;
      if (slateCard && this.element.contains(slateCard) && slateCard !== this.element) return slateCard;

      const root = tableRoot.closest('.mp-table-align.mp-table-root') as HTMLElement | null;
      if (root && this.element.contains(root) && root !== this.element) return root;

      const wrapper = tableRoot.closest('.mp-table-wrapper') as HTMLElement | null;
      if (wrapper && this.element.contains(wrapper) && wrapper !== this.element) return wrapper;
    }

    return this.findClosestEditableBlock(anchor) || anchor;
  }

  private isFeishuEditor(): boolean {
    if (!this.element) return false;
    if (/(\.|^)(feishu\.(cn|com)|larksuite\.com|larkoffice\.com)$/i.test(window.location.hostname)) return true;
    return !!this.element.querySelector('.docx-selection-hidden-textarea')
      || !!document.querySelector('.docx-selection-hidden-textarea');
  }

  private prepareFeishuPasteSelection(
    range: globalThis.Range | null,
    anchorBlock?: HTMLElement | null,
    preferredTarget?: HTMLElement | null,
  ): HTMLElement | null {
    if (!this.element || !range) return null;

    const pasteTarget = preferredTarget || this.getFeishuPasteTarget(range, anchorBlock) || this.getInputEventTarget() || this.element;
    try {
      pasteTarget.focus({ preventScroll: true });
    } catch {
      pasteTarget.focus();
    }
    this.collapseEditorSelection();
    this.selectNativeRange(range);
    this.collapseHiddenTextareaSelection();

    document.dispatchEvent(new Event('selectionchange'));
    return pasteTarget;
  }

  private createRangeAfter(block: HTMLElement): globalThis.Range {
    const range = document.createRange();
    range.setStartAfter(block);
    range.collapse(true);
    return range;
  }

  private collapseEditorSelection(): void {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    selection.collapseToEnd();
  }

  private collapseHiddenTextareaSelection(): void {
    const hiddenTextarea = document.querySelector('.docx-selection-hidden-textarea') as HTMLTextAreaElement | null;
    if (!hiddenTextarea) return;
    if (hiddenTextarea.selectionStart === hiddenTextarea.selectionEnd) return;

    const caret = hiddenTextarea.selectionEnd ?? hiddenTextarea.selectionStart ?? 0;
    try {
      hiddenTextarea.setSelectionRange(caret, caret);
      hiddenTextarea.dispatchEvent(new Event('select', { bubbles: true }));
    } catch {
      // Some editor builds expose a readonly hidden textarea; selection reset is best effort.
    }
  }

  private restoreTextIfMissing(block: HTMLElement, preserveText: string): void {
    const probeSource = (preserveText || block.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
    const probe = probeSource.slice(0, 80);
    if (probe.length < 2) return;

    window.setTimeout(() => {
      const haystack = (document.body.innerText || '').replace(/\s+/g, ' ');
      if (haystack.includes(probe.slice(0, Math.min(24, probe.length)))) return;

      const editor = block.isConnected
        ? (this.getFeishuBlockEditor(block) || block)
        : (this.getInputEventTarget() || this.element);
      if (!editor) return;

      const range = document.createRange();
      try {
        range.selectNodeContents(editor);
        range.collapse(true);
      } catch {
        return;
      }
      this.selectNativeRange(range);
      this.insertViaInputEvent(probeSource);
    }, 400);
  }

  private async insertFeishuImageBelow(
    url: string,
    alt: string,
    anchor: HTMLElement,
    preserveText: string,
  ): Promise<boolean> {
    if (!this.element || this.isTextarea || !this.element.contains(anchor)) return false;

    const sourceBlock = this.findNearestLeafFeishuBlock(anchor) || anchor;
    const anchorBlock = this.resolveFeishuImageAnchor(anchor);
    if (!anchorBlock || !this.element.contains(anchorBlock)) return false;

    try {
      const before = this.countFeishuImages(this.element);
      this.collapseEditorSelection();
      this.collapseHiddenTextareaSelection();

      const created = await this.createEmptyParagraphAfter(anchorBlock);
      if (created && this.pasteImageIntoFeishuBlock(url, alt, created, 'start')
        && await this.waitForImageIncrease(before, 400)) {
        this.restoreTextIfMissing(sourceBlock, preserveText);
        return true;
      }

      // One fallback: retry the new paragraph, otherwise paste after the anchor once.
      const retried = created
        ? this.pasteImageIntoFeishuBlock(url, alt, created, 'start')
        : this.pasteFeishuImageFallback(url, alt, anchorBlock);
      const appeared = retried ? await this.waitForImageIncrease(before, 400) : false;
      this.restoreTextIfMissing(sourceBlock, preserveText);
      return appeared;
    } catch (error) {
      console.warn('[Doc Copilot] Feishu image insertion failed.', error);
      this.restoreTextIfMissing(sourceBlock, preserveText);
      return false;
    }
  }

  private async createEmptyParagraphAfter(block: HTMLElement): Promise<HTMLElement | null> {
    const existing = this.findFollowingEmptyTextBlock(block);
    if (existing) return existing;

    const before = this.snapshotFeishuBlockIds();
    if (!this.isRestrictedFeishuImageBlock(block)) {
      const editor = this.getFeishuBlockEditor(block);
      if (editor) {
        this.pressEnterAt(editor, 'end');
        const created = await this.waitForCreatedBlock(before, block, 240);
        if (created) return created;
      }
    }

    const next = this.findNextFlowBlock(block);
    if (next && !this.isRestrictedFeishuImageBlock(next) && !this.isFeishuImageBlock(next)) {
      const editor = this.getFeishuBlockEditor(next);
      if (editor) {
        this.pressEnterAt(editor, 'start');
        const created = await this.waitForCreatedBlock(before, block, 240);
        if (created) return created;
      }
    }

    const host = this.getFeishuParagraphHost(block);
    if (!host) return null;
    const boundary = this.createRangeAfter(block);
    this.collapseEditorSelection();
    this.selectNativeRange(boundary);
    this.focusWithoutScroll(host);
    this.dispatchInsertParagraph(host);
    return this.waitForCreatedBlock(before, block, 240);
  }

  private pasteFeishuImageFallback(url: string, alt: string, anchor: HTMLElement): boolean {
    const next = this.findNextFlowBlock(anchor);
    if (next && !this.isRestrictedFeishuImageBlock(next) && !this.isFeishuImageBlock(next)) {
      return this.pasteImageIntoFeishuBlock(url, alt, next, 'start');
    }
    if (!this.isRestrictedFeishuImageBlock(anchor) && !this.isFeishuImageBlock(anchor)) {
      return this.pasteImageIntoFeishuBlock(url, alt, anchor, 'end');
    }
    return false;
  }

  private pasteImageIntoFeishuBlock(
    url: string,
    alt: string,
    block: HTMLElement,
    where: 'start' | 'end',
  ): boolean {
    if (!this.element?.contains(block) || this.isRestrictedFeishuImageBlock(block) || this.isFeishuImageBlock(block)) {
      return false;
    }
    const editor = this.getFeishuBlockEditor(block);
    if (!editor || this.isRestrictedFeishuEditor(editor)) return false;
    const range = where === 'end'
      ? this.createCollapsedRangeAtEnd(editor)
      : this.createCollapsedRangeAtStart(editor);
    this.collapseEditorSelection();
    this.prepareFeishuPasteSelection(range, block, editor);
    return this.insertImageViaPaste(url, alt, editor);
  }

  private pressEnterAt(editor: HTMLElement, where: 'start' | 'end'): void {
    this.focusWithoutScroll(editor);
    const range = where === 'start'
      ? this.createCollapsedRangeAtStart(editor)
      : this.createCollapsedRangeAtEnd(editor);
    this.collapseEditorSelection();
    this.selectNativeRange(range);
    this.collapseHiddenTextareaSelection();
    this.dispatchInsertParagraph(editor);
  }

  private dispatchInsertParagraph(target: HTMLElement): void {
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    try {
      Object.defineProperty(event, 'keyCode', { get: () => 13 });
      Object.defineProperty(event, 'which', { get: () => 13 });
    } catch {
      // keyCode is read-only in some browsers; Enter still travels on event.key.
    }
    const handled = !target.dispatchEvent(event);
    if (handled) return;
    try {
      target.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertParagraph',
      }));
    } catch {
      // Ignore editors that do not expose InputEvent construction.
    }
  }

  private findNearestLeafFeishuBlock(anchor: HTMLElement): HTMLElement | null {
    if (!this.element || !this.element.contains(anchor)) return null;
    let current = (anchor.matches('.block[data-block-id]')
      ? anchor
      : anchor.closest('.block[data-block-id]')) as HTMLElement | null;
    if (!current || !this.element.contains(current) || this.isFeishuPageBlock(current)) return null;

    while (current) {
      const descendant = this.findChildBlockContaining(current, anchor);
      if (!descendant || descendant === current) break;
      current = descendant;
    }
    return current;
  }

  private findChildBlockContaining(container: HTMLElement, anchor: HTMLElement): HTMLElement | null {
    for (const child of Array.from(container.children)) {
      if (!(child instanceof HTMLElement) || (child !== anchor && !child.contains(anchor))) continue;
      if (child.matches('.block[data-block-id]') && !this.isFeishuPageBlock(child)) return child;
      const nested = child.querySelector('.block[data-block-id]') as HTMLElement | null;
      if (nested && !this.isFeishuPageBlock(nested) && (nested === anchor || nested.contains(anchor))) {
        return nested;
      }
    }
    return null;
  }

  private resolveFeishuImageAnchor(anchor: HTMLElement): HTMLElement | null {
    let block = this.findNearestLeafFeishuBlock(anchor);
    if (!block) {
      const closest = anchor.closest('.block[data-block-id]') as HTMLElement | null;
      if (closest && this.element?.contains(closest) && !this.isFeishuPageBlock(closest)) block = closest;
    }
    if (!block || !this.element?.contains(block) || this.isFeishuPageBlock(block)) return null;
    return this.outermostRestrictedFeishuBlock(block) || block;
  }

  private outermostRestrictedFeishuBlock(block: HTMLElement): HTMLElement | null {
    let current: HTMLElement | null = block;
    let restricted: HTMLElement | null = null;
    let guard = 0;
    while (current && this.element?.contains(current) && guard < 8) {
      guard += 1;
      if (this.isFeishuPageBlock(current)) break;
      if (this.isRestrictedFeishuImageBlock(current)) restricted = current;
      const parent = current.parentElement?.closest('.block[data-block-id]') as HTMLElement | null;
      if (!parent || parent === current) break;
      current = parent;
    }
    return restricted;
  }

  private isFeishuPageBlock(block: HTMLElement): boolean {
    const type = (block.getAttribute('data-block-type') || '').toLowerCase();
    return type === 'page'
      || block.classList.contains('docx-page-block')
      || block.classList.contains('root-block')
      || (block.classList.contains('page-block') && block === this.element);
  }

  private isRestrictedFeishuImageBlock(block: HTMLElement): boolean {
    if (this.isFeishuPageBlock(block)) return false;
    const signature = `${block.getAttribute('data-block-type') || ''} ${block.getAttribute('data-type') || ''} ${String(block.className || '')}`.toLowerCase();
    if (/(^|[^a-z0-9])(code|table|sheet|bitable|equation|latex|diagram|whiteboard|mindmap|mind-map|mindnote|heading\d*|title)([^a-z0-9]|$)/.test(signature)) {
      return true;
    }
    const structural = block.querySelector('table, pre, .ace-code');
    if (!structural) return false;
    return structural.closest('.block[data-block-id]') === block;
  }

  private isRestrictedFeishuEditor(editor: HTMLElement): boolean {
    const owner = editor.closest('.block[data-block-id]') as HTMLElement | null;
    if (owner && this.isRestrictedFeishuImageBlock(owner)) return true;
    const signature = `${String(editor.className || '')} ${editor.parentElement?.className || ''}`.toLowerCase();
    return /(^|[^a-z0-9])(code|table|sheet|equation|diagram|heading)([^a-z0-9]|$)/.test(signature)
      || !!editor.closest('pre, table, .code-block, .docx-code-block');
  }

  private isFeishuImageBlock(block: HTMLElement): boolean {
    const signature = `${block.getAttribute('data-block-type') || ''} ${String(block.className || '')}`.toLowerCase();
    return /(^|[^a-z0-9])(image|img)([^a-z0-9]|$)/.test(signature);
  }

  private findFollowingEmptyTextBlock(block: HTMLElement): HTMLElement | null {
    const next = this.findNextFlowBlock(block);
    if (!next || this.isRestrictedFeishuImageBlock(next) || this.isFeishuImageBlock(next)) return null;
    if (!this.getFeishuBlockEditor(next)) return null;
    const text = (next.innerText || next.textContent || '').replace(/[\u200B-\u200D\uFEFF\s]/g, '');
    return text ? null : next;
  }

  private findNextFlowBlock(block: HTMLElement): HTMLElement | null {
    const fromSibling = (node: Element | null): HTMLElement | null => {
      if (!(node instanceof HTMLElement)) return null;
      if (node.matches('.block[data-block-id]') && !this.isFeishuPageBlock(node)) return node;
      const nested = node.querySelector('.block[data-block-id]') as HTMLElement | null;
      if (nested && !this.isFeishuPageBlock(nested) && !block.contains(nested)) return nested;
      return null;
    };
    const direct = fromSibling(block.nextElementSibling);
    if (direct) return direct;
    const parentNext = fromSibling(block.parentElement?.nextElementSibling || null);
    if (parentNext) return parentNext;
    if (!this.element) return null;
    const all = Array.from(this.element.querySelectorAll('.block[data-block-id]')) as HTMLElement[];
    const index = all.indexOf(block);
    for (let i = index + 1; i < all.length; i++) {
      if (!this.isFeishuPageBlock(all[i]) && !block.contains(all[i]) && !all[i].contains(block)) return all[i];
    }
    return null;
  }

  private getFeishuParagraphHost(block: HTMLElement): HTMLElement | null {
    const page = block.closest('.page-block, .docx-page-block, .root-block') as HTMLElement | null;
    if (page && this.element?.contains(page)) return page;
    return this.element;
  }

  private snapshotFeishuBlockIds(): Set<string> {
    const ids = new Set<string>();
    this.element?.querySelectorAll('.block[data-block-id]').forEach(node => {
      const id = node.getAttribute('data-block-id');
      if (id) ids.add(id);
    });
    return ids;
  }

  private findCreatedFeishuBlock(before: Set<string>, anchor: HTMLElement): HTMLElement | null {
    if (!this.element) return null;
    const created = Array.from(this.element.querySelectorAll('.block[data-block-id]')).filter((node): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) return false;
      const id = node.getAttribute('data-block-id') || '';
      return !!id && !before.has(id) && !anchor.contains(node);
    });
    const following = created.filter(node => !!(anchor.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING));
    const pool = following.length ? following : created;
    return pool.find(node => !this.isRestrictedFeishuImageBlock(node) && !!this.getFeishuBlockEditor(node)) || null;
  }

  private countFeishuImages(root: HTMLElement): number {
    const seen = new Set<HTMLElement>();
    root.querySelectorAll('img, [data-block-type="image"], [data-block-type="image_block"], .docx-image-block, .docx-image, .image-block').forEach(node => {
      if (!(node instanceof HTMLElement)) return;
      if (node.closest('#doc-copilot-root, .dc-sel-toolbar-wrapper, .dc-notification')) return;
      const owner = node.closest('.block[data-block-id], .docx-image-block, .image-block') as HTMLElement | null;
      seen.add(owner && root.contains(owner) ? owner : node);
    });
    return seen.size;
  }

  private async waitForImageIncrease(before: number, timeoutMs: number): Promise<boolean> {
    const found = await this.waitFor(() => {
      if (!this.element) return null;
      return this.countFeishuImages(this.element) > before ? true : null;
    }, timeoutMs);
    return found === true;
  }

  private waitForCreatedBlock(before: Set<string>, anchor: HTMLElement, timeoutMs: number): Promise<HTMLElement | null> {
    return this.waitFor(() => this.findCreatedFeishuBlock(before, anchor), timeoutMs);
  }

  private waitFor<T>(read: () => T | null | undefined | false, timeoutMs: number, intervalMs = 40): Promise<T | null> {
    return new Promise(resolve => {
      const start = Date.now();
      const tick = () => {
        let value: T | null | undefined | false = null;
        try {
          value = read();
        } catch {
          value = null;
        }
        if (value) {
          resolve(value);
          return;
        }
        if (Date.now() - start >= timeoutMs) {
          resolve(null);
          return;
        }
        window.setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  private focusWithoutScroll(target: HTMLElement): void {
    try {
      target.focus({ preventScroll: true });
    } catch {
      try {
        target.focus();
      } catch {
        // The editor may expose a non-focusable block wrapper.
      }
    }
  }

  private getFeishuBlockEditor(block: HTMLElement | null): HTMLElement | null {
    if (!block || !this.element?.contains(block) || this.isRestrictedFeishuImageBlock(block)) return null;
    const direct: HTMLElement[] = [];
    block.querySelectorAll('[contenteditable="true"], .zone-container.text-editor').forEach(candidate => {
      if (!(candidate instanceof HTMLElement) || !this.element?.contains(candidate)) return;
      const owner = candidate.closest('.block[data-block-id]');
      if (owner && owner !== block) return;
      direct.push(candidate);
    });
    const editable = direct.find(editor => !this.isRestrictedFeishuEditor(editor)
      && /text-editor|ace-line|docx-text/.test(String(editor.className || '')))
      || direct.find(editor => !this.isRestrictedFeishuEditor(editor));
    if (editable) return editable;
    if (!block.querySelector('.block[data-block-id]')
      && !this.isRestrictedFeishuEditor(block)
      && (block.getAttribute('contenteditable') === 'true' || block.isContentEditable)) {
      return block;
    }
    return null;
  }

  private createCollapsedRangeAtStart(target: HTMLElement): globalThis.Range {
    const range = document.createRange();
    const first = this.walkFeishuTextNodes(target).next().value as Text | undefined;
    if (first) {
      range.setStart(first, 0);
      range.collapse(true);
      return range;
    }
    range.selectNodeContents(target);
    range.collapse(true);
    return range;
  }

  private createCollapsedRangeAtEnd(target: HTMLElement): globalThis.Range {
    const range = document.createRange();
    let lastText: Text | null = null;
    for (const node of this.walkFeishuTextNodes(target)) {
      if (node.textContent) lastText = node;
    }

    if (lastText) {
      range.setStart(lastText, lastText.textContent?.length || 0);
    } else {
      range.selectNodeContents(target);
      range.collapse(false);
      return range;
    }
    range.collapse(true);
    return range;
  }

  private *walkFeishuTextNodes(target: HTMLElement): Generator<Text> {
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, {
      acceptNode: (node: Node) => {
        const parent = node.parentElement;
        if (parent?.closest('[data-doc-copilot-probe], .doc-copilot-ghost-text')) return NodeFilter.FILTER_REJECT;
        const owner = parent?.closest('.block[data-block-id]') as HTMLElement | null;
        if (owner && owner !== target && target.contains(owner)) return NodeFilter.FILTER_REJECT;
        if (parent?.closest('pre, table, .code-block, .docx-code-block') && !target.closest('.docx-code-block, .code-block, pre')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node = walker.nextNode();
    while (node) {
      yield node as Text;
      node = walker.nextNode();
    }
  }

  private getFeishuPasteTarget(range: globalThis.Range, anchorBlock?: HTMLElement | null): HTMLElement | null {
    if (!this.element) return null;

    const node = range.startContainer;
    const element = node instanceof HTMLElement ? node : node.parentElement;
    const block = anchorBlock || element?.closest('.block[data-block-id]') as HTMLElement | null;
    if (block && (this.isRestrictedFeishuImageBlock(block) || this.isFeishuImageBlock(block))) return null;
    const currentEditor = block ? this.getFeishuBlockEditor(block) : null;
    if (currentEditor && this.element.contains(currentEditor)) return currentEditor;

    const editable = element?.closest('[contenteditable="true"]') as HTMLElement | null;
    if (editable && this.element.contains(editable) && !this.isRestrictedFeishuEditor(editable)) return editable;
    return null;
  }

  private selectNativeRange(range: globalThis.Range): void {
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(range.cloneRange());
  }

  private getTextOffsetBeforeNode(root: Node, target: Node): number | null {
    let offset = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (target.contains(node)) return offset;
      offset += node.textContent?.length || 0;
      node = walker.nextNode();
    }
    return null;
  }

  private getTextOffsetAfterNode(root: Node, target: Node): number | null {
    let offset = 0;
    let endOffset: number | null = null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const len = node.textContent?.length || 0;
      offset += len;
      if (target.contains(node)) endOffset = offset;
      node = walker.nextNode();
    }
    return endOffset;
  }

  private createImageContainer(url: string, alt: string): HTMLElement {
    const container = document.createElement('div');
    container.className = 'doc-copilot-inserted-image';
    container.setAttribute('contenteditable', 'false');
    container.style.margin = '12px 0';
    container.style.lineHeight = '0';

    const img = document.createElement('img');
    img.src = url;
    img.alt = alt;
    img.style.maxWidth = '100%';
    img.style.height = 'auto';
    img.style.display = 'block';
    container.appendChild(img);
    return container;
  }

  private insertNodeAfterRange(range: globalThis.Range, node: Node): void {
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);

    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  private insertNodeWithBreaks(range: globalThis.Range, node: Node): void {
    const after = document.createElement('br');
    const before = document.createElement('br');
    range.insertNode(after);
    range.insertNode(node);
    range.insertNode(before);
  }

  private insertImageViaPaste(url: string, alt: string, targetOverride?: HTMLElement | null): boolean {
    if (!this.element) return false;

    const target = targetOverride && this.element.contains(targetOverride)
      ? targetOverride
      : this.element;
    const escapedUrl = this.escapeHtmlAttr(url);
    const escapedAlt = this.escapeHtmlAttr(alt);
    const html = `<p><img src="${escapedUrl}" alt="${escapedAlt}" /></p>`;
    const file = this.dataUrlToFile(url);

    try {
      const dt = new DataTransfer();
      dt.setData('text/html', html);
      dt.setData('text/plain', alt || '[图片]');
      if (file) dt.items.add(file);
      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      const notPrevented = target.dispatchEvent(pasteEvent);
      if (!notPrevented) {
        target.dispatchEvent(new Event('input', { bubbles: true }));
        if (target !== this.element) {
          this.element.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
      }
    } catch (_) { /* ignore */ }

    try {
      const dt = new DataTransfer();
      dt.setData('text/html', html);
      dt.setData('text/plain', alt || '[图片]');
      if (file) dt.items.add(file);
      const inputEvent = new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertFromPaste',
        dataTransfer: dt,
      });
      const notPrevented = target.dispatchEvent(inputEvent);
      if (!notPrevented) {
        target.dispatchEvent(new Event('input', { bubbles: true }));
        if (target !== this.element) {
          this.element.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
      }
    } catch (_) { /* ignore */ }

    return false;
  }

  private dataUrlToFile(dataUrl: string): File | null {
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
    if (!match) return null;

    try {
      const mimeType = match[1] || 'image/png';
      const binary = atob(match[2]);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const ext = mimeType.includes('jpeg') ? 'jpg'
        : mimeType.includes('webp') ? 'webp'
          : mimeType.includes('gif') ? 'gif'
            : 'png';
      return new File([bytes], `doc-copilot-image.${ext}`, { type: mimeType });
    } catch {
      return null;
    }
  }

  private escapeHtmlAttr(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private cleanContextText(text: string): string {
    return text.replace(/[\u200B-\u200D\uFEFF]/g, '');
  }

  private getCurrentCollapsedRangeInsideElement(): globalThis.Range | null {
    if (!this.element) return null;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;

    const range = sel.getRangeAt(0);
    if (!this.isNodeInsideElement(range.startContainer)) return null;

    return range;
  }

  private getCurrentRangeInsideElement(): globalThis.Range | null {
    if (!this.element) return null;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;

    const range = sel.getRangeAt(0);
    if (!this.isNodeInsideElement(range.startContainer) || !this.isNodeInsideElement(range.endContainer)) {
      return null;
    }

    return range;
  }

  private getCaretRect(range: globalThis.Range): DOMRect | null {
    if (!this.element) return null;

    const clientRects = range.getClientRects();
    for (let i = 0; i < clientRects.length; i++) {
      const rect = clientRects[i];
      if (rect.width || rect.height) return rect;
    }

    const boundingRect = range.getBoundingClientRect();
    if (boundingRect.width || boundingRect.height) return boundingRect;

    const blockRect = this.getClosestEditableBlockRect(range.startContainer);
    if (blockRect) return blockRect;

    return this.measureCollapsedRange(range);
  }

  private getClosestEditableBlockRect(node: Node): DOMRect | null {
    const element = node instanceof HTMLElement ? node : node.parentElement;
    const block = element?.closest(
      '[data-slate-node="element"], .mp-paragraph-wrapper, .mp-heading-wrapper, [data-block-id], [data-docx-id], .docx-block, .docx-text-block, p, li, [contenteditable="true"]',
    ) as HTMLElement | null;

    if (!block || !this.element?.contains(block)) return null;

    const rect = block.getBoundingClientRect();
    if (!rect.width && !rect.height) return null;

    const styles = window.getComputedStyle(block);
    const paddingLeft = parseFloat(styles.paddingLeft || '0') || 0;
    return new DOMRect(
      rect.left + paddingLeft,
      rect.top,
      0,
      rect.height,
    );
  }

  private measureCollapsedRange(range: globalThis.Range): DOMRect | null {
    if (!range.collapsed || !this.element) return null;

    const marker = document.createElement('span');
    marker.className = 'doc-copilot-caret-probe';
    marker.setAttribute('data-doc-copilot-probe', 'true');
    marker.textContent = '\u200b';
    marker.style.cssText = [
      'display:inline-block',
      'width:0',
      'height:1em',
      'overflow:hidden',
      'line-height:inherit',
      'vertical-align:baseline',
      'pointer-events:none',
      'opacity:0',
    ].join(';');

    try {
      const probeRange = range.cloneRange();
      this.ignoreMutationsUntil = Date.now() + 80;
      probeRange.insertNode(marker);
      const rect = marker.getBoundingClientRect();
      marker.remove();
      return rect.width || rect.height ? rect : null;
    } catch {
      marker.remove();
      return null;
    }
  }

  /**
   * Insert text via InputEvent — compatible with Slate.js and other modern editors.
   * Slate listens to 'beforeinput' events with inputType 'insertText'.
   */
  private insertViaInputEvent(text: string): void {
    if (!this.element) return;
    const target = this.getInputEventTarget() || this.element;

    // Dispatch beforeinput event (Slate.js primary handler)
    const beforeInputEvent = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
    });
    const accepted = target.dispatchEvent(beforeInputEvent);

    // If beforeinput was not cancelled, also fire input event
    if (accepted) {
      // Try execCommand as a secondary path (non-Slate editors)
      document.execCommand('insertText', false, text);
    }

    // Always fire input event to notify any observers
    const inputEvent = new InputEvent('input', {
      bubbles: true,
      cancelable: false,
      inputType: 'insertText',
      data: text,
    });
    target.dispatchEvent(inputEvent);
    if (target !== this.element) {
      this.element.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  private isCsdnMarkdownEditor(): boolean {
    return !!this.element
      && this.element.matches('pre.editor__inner')
      && window.location.hostname === 'editor.csdn.net';
  }

  private getInputEventTarget(): HTMLElement | null {
    if (!this.element || this.isTextarea) return this.element;

    const active = document.activeElement;
    if (active instanceof HTMLElement && this.element.contains(active)) {
      const editable = active.closest('[contenteditable="true"]') as HTMLElement | null;
      if (editable && this.element.contains(editable)) return editable;
      if (active.isContentEditable) return active;
    }

    const sel = window.getSelection();
    const node = sel?.rangeCount ? sel.getRangeAt(0).startContainer : null;
    const element = node instanceof HTMLElement ? node : node?.parentElement;
    const selectionEditable = element?.closest('[contenteditable="true"]') as HTMLElement | null;
    if (selectionEditable && this.element.contains(selectionEditable)) {
      return selectionEditable;
    }

    return this.element;
  }

  private setCursorAtOffset(offset: number): void {
    if (!this.element) return;

    const result = this.getNodeAtOffset(this.element, offset);
    if (!result) return;

    const range = document.createRange();
    range.setStart(result.node, result.offset);
    range.collapse(true);

    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
}
