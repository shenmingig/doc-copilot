// ============================================================
// Feishu / Lark Docs Adapter - For my.feishu.cn / larksuite docs
// ============================================================

import { ISiteAdapter, SiteContentResult } from './types';
import { detectLanguage } from '../../shared/utils/index';
import { ChatImageInput } from '../../shared/types/index';

const FEISHU_HOST_PATTERNS = [
  /(^|\.)feishu\.cn$/i,
  /(^|\.)feishu\.com$/i,
  /(^|\.)larksuite\.com$/i,
  /(^|\.)larkoffice\.com$/i,
];

const EDITOR_ROOT_SELECTORS = [
  '.page-block.root-block',
  '.block.docx-page-block',
  '.page-main-item.editor',
  '.editor-container',
  '#docx',
  '.docx-editor',
  '.docx-page-content',
  '.docs-editor',
  '.doc-editor',
  '.lark-doc-editor',
  '.wiki-editor',
  '.ProseMirror',
  '[data-testid="docx-editor"]',
  '[data-testid="docs-editor"]',
  '[data-testid="wiki-editor"]',
  '[role="textbox"][contenteditable="true"]',
  '[contenteditable="true"]',
];

const CONTENT_SELECTORS = [
  '.page-block.root-block',
  '.editor-container',
  '.block.docx-page-block',
  '.page-main-item.editor',
  '#docx',
  '.docx-editor',
  '.docx-page-content',
  '.docs-editor',
  '.doc-editor',
  '.wiki-content',
  '.wiki-editor',
  '.ProseMirror',
  '[data-testid="docx-editor"]',
  '[data-testid="docs-editor"]',
  '[data-testid="wiki-content"]',
  '[role="main"]',
  'main',
];

const TITLE_SELECTORS = [
  '[data-testid="doc-title"] input',
  '[data-testid="doc-title"] textarea',
  '[data-testid="doc-title"]',
  '[data-testid="wiki-title"] input',
  '[data-testid="wiki-title"] textarea',
  '[data-testid="wiki-title"]',
  '.doc-title input',
  '.doc-title textarea',
  '.doc-title',
  '.wiki-title input',
  '.wiki-title textarea',
  '.wiki-title',
  'h1',
  'meta[property="og:title"]',
];

const EXCLUDE_TAGS = new Set([
  'nav', 'aside', 'footer', 'header', 'script', 'style',
  'noscript', 'iframe', 'svg', 'video', 'audio',
]);

const EXCLUDE_SELECTORS = [
  '#doc-copilot-root',
  '.dc-sel-toolbar-wrapper',
  '.docx-selection-hidden-textarea',
  '[class*="selection-hidden" i]',
  '[aria-hidden="true"]',
  '[class*="toolbar" i]',
  '[class*="popover" i]',
  '[class*="menu" i]',
  '[class*="modal" i]',
  '[class*="comment" i]',
  '[class*="sidebar" i]',
  '[class*="side-bar" i]',
  '[class*="navigation" i]',
  '[class*="permission" i]',
  '[class*="share" i]',
  '[class*="avatar" i]',
];

export class FeishuAdapter implements ISiteAdapter {
  readonly id = 'feishu';
  readonly name = '飞书 / Lark 文档';

  matches(url: string): boolean {
    try {
      const host = new URL(url).hostname;
      return FEISHU_HOST_PATTERNS.some(pattern => pattern.test(host));
    } catch {
      return /feishu|larksuite|larkoffice/i.test(url);
    }
  }

  extractContent(doc: Document): SiteContentResult | null {
    const editableElement = this.getEditableElement(doc);
    const contentElement = editableElement || this.findContentElement(doc);
    if (!contentElement) return null;

    const documentImages = this.extractImages(contentElement, doc);
    const fullText = this.getCleanedText(contentElement, documentImages);
    const title = this.extractTitle(doc, fullText);

    return {
      fullText,
      title,
      language: detectLanguage((fullText || title).slice(0, 500)),
      isEditable: !!editableElement,
      editableElement: editableElement || undefined,
      contentElement,
      documentImages,
      metadata: this.extractMetadata(doc),
    };
  }

  getEditableElement(doc: Document): HTMLElement | null {
    const active = doc.activeElement;
    if (active instanceof HTMLElement) {
      const activeRoot = this.findEditorRoot(active);
      if (activeRoot && this.isUsableEditor(activeRoot)) {
        return activeRoot;
      }

      const activeEditable = active.closest('[contenteditable="true"], [role="textbox"]') as HTMLElement | null;
      const activeEditableRoot = activeEditable ? this.findEditorRoot(activeEditable) || activeEditable : null;
      if (activeEditableRoot && this.isUsableEditor(activeEditableRoot)) {
        return activeEditableRoot;
      }
    }

    const candidates = this.getEditableCandidates(doc);
    return candidates
      .map(candidate => this.findEditorRoot(candidate) || candidate)
      .filter((candidate, index, arr) => arr.indexOf(candidate) === index)
      .filter(candidate => this.isUsableEditor(candidate))
      .sort((a, b) => this.scoreEditor(b, active) - this.scoreEditor(a, active))[0] || null;
  }

  observe(doc: Document, callback: (content: SiteContentResult) => void): () => void {
    let content = this.extractContent(doc);
    let contentObserver: MutationObserver | null = null;
    let modeObserver: MutationObserver | null = null;
    let timer: ReturnType<typeof window.setTimeout> | null = null;

    const emit = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        content = this.extractContent(doc);
        if (content) callback(content);
      }, 180);
    };

    const attachContentObserver = (target: HTMLElement) => {
      contentObserver?.disconnect();
      contentObserver = new MutationObserver(emit);
      contentObserver.observe(target, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    };

    if (content?.contentElement) {
      attachContentObserver(content.contentElement);
    }

    modeObserver = new MutationObserver(() => {
      const next = this.extractContent(doc);
      if (!next) return;
      if (next.contentElement !== content?.contentElement) {
        attachContentObserver(next.contentElement);
      }
      content = next;
      callback(next);
    });

    modeObserver.observe(doc.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['contenteditable', 'class', 'role', 'data-testid'],
    });

    return () => {
      if (timer) window.clearTimeout(timer);
      contentObserver?.disconnect();
      modeObserver?.disconnect();
    };
  }

  private getEditableCandidates(doc: Document): HTMLElement[] {
    const selectors = [
      '[contenteditable="true"]',
      '[role="textbox"]',
      'textarea',
      'input[type="text"]',
    ];
    return Array.from(doc.querySelectorAll(selectors.join(',')))
      .filter((el): el is HTMLElement => el instanceof HTMLElement)
      .filter(el => el.getAttribute('aria-readonly') !== 'true');
  }

  private findEditorRoot(element: HTMLElement): HTMLElement | null {
    for (const selector of EDITOR_ROOT_SELECTORS) {
      const root = element.closest(selector) as HTMLElement | null;
      if (root && !this.isExcluded(root)) return root;
    }
    return null;
  }

  private findContentElement(doc: Document): HTMLElement | null {
    for (const selector of CONTENT_SELECTORS) {
      const el = doc.querySelector(selector) as HTMLElement | null;
      if (el && this.getCleanedText(el).length > 20 && !this.isExcluded(el)) {
        return el;
      }
    }

    const candidates = Array.from(doc.querySelectorAll('main, [role="main"], section, article, div'))
      .filter((el): el is HTMLElement => el instanceof HTMLElement && !this.isExcluded(el));

    return candidates
      .sort((a, b) => this.getCleanedText(b).length - this.getCleanedText(a).length)[0] || null;
  }

  private isUsableEditor(element: HTMLElement): boolean {
    if (!element.isConnected || this.isExcluded(element)) return false;
    if (!this.isVisible(element)) return false;
    if (element.closest('[contenteditable="false"][aria-readonly="true"]')) return false;

    const hasEditableDescendant = element.matches('[contenteditable="true"], textarea, input[type="text"]')
      || !!element.querySelector('[contenteditable="true"], textarea, input[type="text"]');
    if (!hasEditableDescendant) return false;

    return this.getCleanedText(element).length >= 0;
  }

  private isExcluded(element: HTMLElement): boolean {
    if (element.closest('#doc-copilot-root, .dc-sel-toolbar-wrapper')) return true;
    return EXCLUDE_SELECTORS.some(selector => {
      try {
        return element.matches(selector) || !!element.closest(selector);
      } catch {
        return false;
      }
    });
  }

  private isVisible(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (rect.right <= 0 || rect.bottom <= 0) return false;
    if (rect.left >= window.innerWidth || rect.top >= window.innerHeight) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity || '1') > 0;
  }

  private scoreEditor(element: HTMLElement, active: Element | null): number {
    const textLength = this.getCleanedText(element).length;
    const className = String(element.className || '');
    const testId = element.getAttribute('data-testid') || '';
    const preferred = /(docx|docs?|wiki|editor|ProseMirror)/i.test(`${className} ${testId}`) ? 5000 : 0;
    const activeBonus = active && element.contains(active) ? 100000 : 0;
    const editableBonus = element.getAttribute('contenteditable') === 'true' ? 1000 : 0;
    return activeBonus + preferred + editableBonus + Math.min(textLength, 5000);
  }

  private extractTitle(doc: Document, fullText: string): string {
    for (const selector of TITLE_SELECTORS) {
      const el = doc.querySelector(selector);
      if (!el) continue;

      if (el instanceof HTMLMetaElement && el.content.trim()) {
        return this.cleanTitle(el.content);
      }
      if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value.trim()) {
        return this.cleanTitle(el.value);
      }
      if (el.textContent?.trim()) {
        return this.cleanTitle(el.textContent);
      }
    }

    const firstLine = fullText
      .split('\n')
      .map(line => line.trim())
      .find(line => line.length > 0 && line.length <= 80);

    return firstLine || this.cleanTitle(doc.title || '');
  }

  private extractMetadata(doc: Document): Record<string, string> {
    const metadata: Record<string, string> = {};
    const description = doc.querySelector('meta[name="description"], meta[property="og:description"]');
    if (description instanceof HTMLMetaElement && description.content.trim()) {
      metadata.description = description.content.trim();
    }
    return metadata;
  }

  private getCleanedText(element: HTMLElement, documentImages: ChatImageInput[] = []): string {
    const clone = element.cloneNode(true) as HTMLElement;

    clone.querySelectorAll(Array.from(EXCLUDE_TAGS).join(',')).forEach(el => el.remove());
    clone.querySelectorAll(EXCLUDE_SELECTORS.join(',')).forEach(el => el.remove());
    clone.querySelectorAll('[data-doc-copilot-probe], .doc-copilot-ghost-text').forEach(el => el.remove());
    let contentImageIndex = 0;
    clone.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
      if (this.isDecorativeImageLike(img)) {
        img.remove();
        return;
      }
      const meta = documentImages[contentImageIndex];
      const label = meta
        ? this.formatImageContext(meta, contentImageIndex)
        : `[文档图片 ${contentImageIndex + 1}]`;
      contentImageIndex += 1;
      img.replaceWith(clone.ownerDocument.createTextNode(`\n${label}\n`));
    });

    return (clone.innerText || clone.textContent || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  private extractImages(element: HTMLElement, doc: Document): ChatImageInput[] {
    const seen = new Set<string>();
    const images: ChatImageInput[] = [];

    element.querySelectorAll<HTMLImageElement>('img').forEach((img, index) => {
      if (!img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) return;
      if (this.isDecorativeImageLike(img)) return;

      const sourceUrl = this.resolveImageUrl(img, doc);
      if (!sourceUrl || seen.has(sourceUrl)) return;
      seen.add(sourceUrl);

      const width = img.naturalWidth || img.width || undefined;
      const height = img.naturalHeight || img.height || undefined;
      images.push({
        id: `feishu-doc-image-${index + 1}`,
        name: img.getAttribute('alt')?.trim() || img.getAttribute('title')?.trim() || `文档图片 ${images.length + 1}`,
        mimeType: this.guessMimeType(sourceUrl),
        dataUrl: sourceUrl,
        sourceUrl,
        previewUrl: sourceUrl,
        width,
        height,
        origin: 'document',
      });
    });

    return images.slice(0, 8);
  }

  private resolveImageUrl(img: HTMLImageElement, doc: Document): string {
    const attrs = [
      'src',
      'data-src',
      'data-original',
      'data-url',
      'data-lazy-src',
      'data-actualsrc',
      'data-image-src',
    ];
    const raw = img.currentSrc
      || img.src
      || attrs.map(attr => img.getAttribute(attr)).find(Boolean)
      || '';
    if (!raw) return '';

    try {
      return new URL(raw, doc.baseURI).href.split('#')[0];
    } catch {
      return raw.split('#')[0];
    }
  }

  private isDecorativeImageLike(img: HTMLImageElement): boolean {
    const className = String(img.className || '');
    const parentClassName = String(img.parentElement?.className || '');
    const blockClassName = String(img.closest('.block')?.className || '');
    const signature = `${className} ${parentClassName} ${blockClassName}`;

    if (/docx-image|image-block/i.test(signature)) return false;

    const rect = img.getBoundingClientRect();
    const width = img.naturalWidth || img.width || rect.width;
    const height = img.naturalHeight || img.height || rect.height;
    if (width > 0 && height > 0 && width <= 48 && height <= 48) return true;

    return /avatar|icon|emoji|logo|loading|placeholder/i.test(signature);
  }

  private guessMimeType(url: string): string {
    if (url.startsWith('data:')) {
      const match = url.match(/^data:([^;,]+)/);
      return match?.[1] || 'image/png';
    }
    const lower = url.toLowerCase();
    if (/format=webp|sticker_format=\.webp/.test(lower)) return 'image/webp';
    const path = lower.split('?')[0];
    if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
    if (path.endsWith('.webp')) return 'image/webp';
    if (path.endsWith('.gif')) return 'image/gif';
    if (path.endsWith('.svg')) return 'image/svg+xml';
    return 'image/png';
  }

  private formatImageContext(image: ChatImageInput, index: number): string {
    const parts = [`文档图片 ${index + 1}`];
    if (image.name) parts.push(image.name);
    if (image.width && image.height) parts.push(`${image.width}x${image.height}`);
    const sourceUrl = this.publicImageUrl(image.sourceUrl);
    if (sourceUrl) parts.push(sourceUrl);
    return `[${parts.join(' | ')}]`;
  }

  private publicImageUrl(url?: string): string {
    if (!url || /^(?:data|blob):/i.test(url)) return '';
    if (!/^https?:\/\//i.test(url)) return '';
    return url.length > 300 ? `${url.slice(0, 300)}…` : url;
  }

  private cleanTitle(title: string): string {
    return title
      .replace(/\s*[-_|]\s*(飞书|Feishu|Lark|Lark Docs|Lark Suite)\s*$/i, '')
      .trim();
  }
}
