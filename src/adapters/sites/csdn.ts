// ============================================================
// CSDN Markdown Editor Adapter - editor.csdn.net/md
// ============================================================

import { ISiteAdapter, SiteContentResult } from './types';
import { detectLanguage } from '../../shared/utils/index';

const EDITOR_SELECTOR = 'pre.editor__inner';
const TITLE_SELECTORS = [
  '.article-bar__title--input',
  'input.article-bar__title',
  'input[placeholder*="文章标题"]',
  'input[placeholder*="模板名称"]',
];

export class CsdnAdapter implements ISiteAdapter {
  readonly id = 'csdn';
  readonly name = 'CSDN Markdown 编辑器';

  matches(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.hostname === 'editor.csdn.net' && /^\/md(?:\/|$)/.test(parsed.pathname);
    } catch {
      return /^https?:\/\/editor\.csdn\.net\/md(?:\/|[?#])/i.test(url);
    }
  }

  extractContent(doc: Document): SiteContentResult | null {
    const contentElement = doc.querySelector(EDITOR_SELECTOR) as HTMLElement | null;
    if (!contentElement) return null;

    const editableElement = this.getEditableElement(doc);
    const fullText = this.getEditorText(contentElement);

    return {
      fullText,
      title: this.extractTitle(doc, fullText),
      language: detectLanguage(fullText.slice(0, 500)),
      isEditable: !!editableElement,
      editableElement: editableElement || undefined,
      contentElement,
      metadata: { editor: 'CSDN Markdown' },
    };
  }

  getEditableElement(doc: Document): HTMLElement | null {
    const editor = doc.querySelector(EDITOR_SELECTOR) as HTMLElement | null;
    if (!editor || !editor.isConnected || !this.isVisible(editor)) return null;

    const explicitlyReadonly = editor.getAttribute('contenteditable') === 'false'
      || editor.getAttribute('aria-readonly') === 'true'
      || editor.closest('.readonly, [data-readonly="true"]');
    if (explicitlyReadonly) return null;

    // CSDN's clEditor turns this <pre> into its contenteditable surface at runtime.
    return editor.isContentEditable || editor.getAttribute('contenteditable') === 'true'
      ? editor
      : null;
  }

  observe(doc: Document, callback: (content: SiteContentResult) => void): () => void {
    let editorObserver: MutationObserver | null = null;
    let currentEditor: HTMLElement | null = null;
    let timer: ReturnType<typeof window.setTimeout> | null = null;

    const emit = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const content = this.extractContent(doc);
        if (content) callback(content);
      }, 160);
    };

    const attachEditor = (editor: HTMLElement | null) => {
      if (editor === currentEditor) return;
      editorObserver?.disconnect();
      currentEditor = editor;
      if (!editor) return;
      editorObserver = new MutationObserver(emit);
      editorObserver.observe(editor, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['contenteditable', 'aria-readonly', 'class'],
      });
    };

    attachEditor(doc.querySelector(EDITOR_SELECTOR) as HTMLElement | null);

    const pageObserver = new MutationObserver(() => {
      const editor = doc.querySelector(EDITOR_SELECTOR) as HTMLElement | null;
      attachEditor(editor);
      emit();
    });
    pageObserver.observe(doc.body, { childList: true, subtree: true });

    return () => {
      if (timer) window.clearTimeout(timer);
      editorObserver?.disconnect();
      pageObserver.disconnect();
    };
  }

  private getEditorText(editor: HTMLElement): string {
    const clone = editor.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.doc-copilot-ghost-text, [data-doc-copilot-probe]').forEach(el => el.remove());
    return (clone.innerText || clone.textContent || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\u00A0/g, '');
  }

  private extractTitle(doc: Document, fullText: string): string {
    for (const selector of TITLE_SELECTORS) {
      const input = doc.querySelector(selector);
      if (input instanceof HTMLInputElement && input.value.trim()) return input.value.trim();
    }
    const firstHeading = fullText.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim();
    return firstHeading || doc.title.replace(/\s*[-_|]\s*CSDN.*$/i, '').trim();
  }

  private isVisible(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0
      && style.display !== 'none'
      && style.visibility !== 'hidden';
  }
}
