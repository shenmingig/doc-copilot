// ============================================================
// Autocomplete Controller - Manages ghost text in the page
// ============================================================

import { ChromeDocumentAdapter } from '../adapters/chrome/adapter';
import { AppSettings, DocumentContext, AutocompleteResult, isModelConfigComplete } from '../shared/types/index';
import { debounce } from '../shared/utils/index';
import { Disposable } from '../shared/types/index';

export class AutocompleteController {
  private adapter: ChromeDocumentAdapter;
  private enabled = false;
  private currentResult: AutocompleteResult | null = null;
  private debounceMs = 400;
  private settings: AppSettings | null = null;
  private contentDisposable: Disposable | null = null;
  private cursorDisposable: Disposable | null = null;
  private keyupCleanup: (() => void) | null = null;
  private inputSignalCleanup: (() => void) | null = null;
  private listeningElement: HTMLElement | null = null;
  private pendingRequest: AbortController | null = null;
  private requestSeq = 0;

  private debouncedTrigger: ReturnType<typeof debounce>;

  constructor(adapter: ChromeDocumentAdapter) {
    this.adapter = adapter;
    this.debouncedTrigger = debounce(() => this.triggerAutocomplete(), this.debounceMs);
  }

  enable(active: boolean): void {
    if (active && !this.enabled) {
      this.enabled = true;
      this.setupListeners();
    } else if (active && this.enabled) {
      this.refreshInputSignalListeners();
    } else if (!active && this.enabled) {
      this.disable();
    }
  }

  disable(): void {
    this.enabled = false;
    this.dismiss();
    this.contentDisposable?.dispose();
    this.cursorDisposable?.dispose();
    this.contentDisposable = null;
    this.cursorDisposable = null;
    this.keyupCleanup?.();
    this.keyupCleanup = null;
    this.inputSignalCleanup?.();
    this.inputSignalCleanup = null;
    this.listeningElement = null;
    this.debouncedTrigger.cancel();
  }

  updateSettings(settings: AppSettings): void {
    this.settings = settings;
    this.debounceMs = settings.autocompleteDebounceMs;
    this.debouncedTrigger = debounce(() => this.triggerAutocomplete(), this.debounceMs);

    if (!settings.features.autocomplete && this.enabled) {
      this.disable();
    }
  }

  hasGhostText(): boolean {
    return this.currentResult !== null;
  }

  accept(): void {
    if (!this.currentResult) return;

    this.adapter.acceptGhostText();
    this.currentResult = null;

    // Clear backend cache so the just-accepted text is not echoed back.
    // The cache clear IPC is sub-millisecond; by the time the 400ms debounce
    // fires the next request, the cache is already empty — no suppression needed.
    chrome.runtime.sendMessage({ type: 'AUTOCOMPLETE_CLEAR_CACHE' }).catch(() => {});
  }

  dismiss(): void {
    this.cancelPending();
    this.adapter.removeGhostText();
    this.currentResult = null;
  }

  hideGhostText(): void {
    this.adapter.removeGhostText();
    this.currentResult = null;
  }

  triggerManual(): void {
    if (!this.adapter.isAttached()) return;
    this.triggerAutocomplete();
  }

  notifyInputSignal(): void {
    if (!this.enabled || !this.adapter.isAttached()) return;

    this.refreshInputSignalListeners();

    if (this.currentResult) {
      this.adapter.removeGhostText();
      this.currentResult = null;
    }

    this.debouncedTrigger();
  }

  notifyCursorSignal(): void {
    if (!this.enabled || !this.adapter.isAttached()) return;

    this.refreshInputSignalListeners();
    this.hideGhostText();
    this.debouncedTrigger();
  }

  private setupListeners(): void {
    // Trigger on content change (typing)
    this.contentDisposable = this.adapter.onContentChange(() => {
      // Remove current ghost text on typing
      if (this.currentResult) {
        this.adapter.removeGhostText();
        this.currentResult = null;
      }
      this.notifyInputSignal();
    });

    // Cursor movement should also offer a completion after the user pauses.
    // This supports the "move caret, wait, show ghost text" Copilot flow.
    this.cursorDisposable = this.adapter.onCursorChange(() => {
      this.notifyCursorSignal();
    });

    this.refreshInputSignalListeners();
  }

  private async triggerAutocomplete(): Promise<void> {
    if (!this.enabled || !this.adapter.isAttached()) return;
    if (this.settings && !isModelConfigComplete(this.settings.models.smart)) return;

    this.cancelPending();

    const context = this.adapter.getContext();
    const requestSeq = ++this.requestSeq;

    // Don't trigger for very short content
    if (context.textBefore.trim().length < 5) return;

    // Don't trigger if there's selected text
    if (context.selectedText) return;

    // Don't trigger when the cursor is inside an existing word/sentence.
    // Slate list markers and punctuation can appear immediately after the cursor
    // in flattened text, so only word-like characters should block completion.
    const charAfter = this.firstNonZeroWidthChar(context.textAfter);
    if (charAfter && this.isWordLikeContinuation(charAfter)) return;

    try {
      // Send request to background script
      const response = await chrome.runtime.sendMessage({
        type: 'AUTOCOMPLETE_REQUEST',
        payload: context,
      });

      if (response?.error) {
        console.warn('[Doc Copilot] Autocomplete error:', response.error);
        return;
      }

      if (requestSeq !== this.requestSeq || !this.enabled || !this.adapter.isAttached()) {
        return;
      }

      if (response?.result) {
        const result = response.result as AutocompleteResult;
        if (this.settings && result.confidence < this.settings.autocompleteMinConfidence) return;
        this.showGhostText(result, context);
      }
    } catch (error) {
      // Extension context may be invalidated
      console.warn('[Doc Copilot] Autocomplete failed:', error);
    }
  }

  private showGhostText(result: AutocompleteResult, requestContext: DocumentContext): void {
    // Verify cursor position hasn't changed
    const currentPos = this.adapter.getCursorPosition();
    if (currentPos.offset !== result.insertPosition.offset) {
      const currentContext = this.adapter.getContext(undefined, 120);
      const expectedSuffix = requestContext.textBefore.slice(-60);
      if (expectedSuffix && currentContext.textBefore.endsWith(expectedSuffix)) {
        result = { ...result, insertPosition: currentPos };
      }
    }

    result = { ...result, text: this.compactGhostText(result.text) };
    if (!result.text) return;

    this.currentResult = result;
    this.adapter.showGhostText(result.insertPosition, result.text);
  }

  private cancelPending(): void {
    this.requestSeq += 1;
    this.pendingRequest?.abort();
    this.pendingRequest = null;
    this.debouncedTrigger.cancel();
  }

  private isWordLikeContinuation(char: string): boolean {
    return /[\p{L}\p{N}_]/u.test(char);
  }

  private firstNonZeroWidthChar(text: string): string {
    return (text || '').replace(/^[\u200B-\u200D\uFEFF]+/, '')[0] ?? '';
  }

  private refreshInputSignalListeners(): void {
    const editable = this.adapter.getAttachedElement();
    if (editable === this.listeningElement) return;

    this.keyupCleanup?.();
    this.keyupCleanup = null;
    this.inputSignalCleanup?.();
    this.inputSignalCleanup = null;
    this.listeningElement = editable;

    if (!editable) return;

    const onInputSignal = (e: Event) => {
      if (!this.enabled || !this.isFromAttachedEditor(e)) return;
      if (e instanceof KeyboardEvent && !this.shouldTriggerFromKey(e)) return;

      this.notifyInputSignal();
    };

    editable.addEventListener('keyup', onInputSignal);
    this.keyupCleanup = () => editable.removeEventListener('keyup', onInputSignal);

    // Baidu Ku's Slate editor often emits beforeinput/composition events for
    // Chinese IME commits without a normal input event, so listen at document
    // capture phase as a fallback and debounce until the DOM mutation lands.
    document.addEventListener('beforeinput', onInputSignal, true);
    document.addEventListener('compositionend', onInputSignal, true);
    document.addEventListener('keyup', onInputSignal, true);
    this.inputSignalCleanup = () => {
      document.removeEventListener('beforeinput', onInputSignal, true);
      document.removeEventListener('compositionend', onInputSignal, true);
      document.removeEventListener('keyup', onInputSignal, true);
    };
  }

  private isFromAttachedEditor(e: Event): boolean {
    const editable = this.adapter.getAttachedElement();
    const target = e.target;
    return !!editable && target instanceof Node && (target === editable || editable.contains(target));
  }

  private compactGhostText(raw: string): string {
    let text = raw.replace(/\r\n/g, '\n').replace(/\n+/g, ' ').trim();
    if (!text) return '';

    const sentenceEnd = text.search(/[。！？.!?]/);
    if (sentenceEnd >= 12) {
      text = text.slice(0, sentenceEnd + 1);
    }

    const maxLength = 72;
    if (text.length > maxLength) {
      const truncated = text.slice(0, maxLength);
      const breakChars = ['，', '、', '；', ';', ','];
      const softBreak = Math.max(...breakChars.map(char => truncated.lastIndexOf(char)));
      text = softBreak >= Math.floor(maxLength * 0.55)
        ? truncated.slice(0, softBreak + 1)
        : truncated;
    }

    return text.trimEnd();
  }

  private shouldTriggerFromKey(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.key.length === 1) return true;
    return e.key === 'Enter' || e.key === 'Backspace' || e.key === 'Delete';
  }
}
