// ============================================================
// Xiaomi MiMo Docs Adapter - For mimo.mi.com/docs
// ============================================================

import { ChatImageInput } from '../../shared/types/index';
import { detectLanguage } from '../../shared/utils/index';
import { ISiteAdapter, SiteContentResult } from './types';

const CONTENT_SELECTORS = [
  '.page-container .mdxContent',
  '.mdxContent',
];

const EXCLUDE_SELECTORS = [
  '#doc-copilot-root',
  '.dc-sel-toolbar-wrapper',
  'script',
  'style',
  'noscript',
  'iframe',
  'svg',
  'video',
  'audio',
  'button',
];

const IMAGE_URL_ATTRIBUTES = [
  'src',
  'data-src',
  'data-original',
  'data-lazy-src',
];

export class MimoDocsAdapter implements ISiteAdapter {
  readonly id = 'mimo-docs';
  readonly name = 'Xiaomi MiMo Docs';

  matches(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.hostname === 'mimo.mi.com'
        && /^\/docs(?:\/|$)/.test(parsed.pathname);
    } catch {
      return /^https?:\/\/mimo\.mi\.com\/docs(?:\/|[?#])/i.test(url);
    }
  }

  extractContent(doc: Document): SiteContentResult | null {
    const contentElement = this.findContentElement(doc);
    if (!contentElement) return null;

    const documentImages = this.extractImages(contentElement, doc);
    const fullText = this.getCleanedText(contentElement, doc, documentImages);
    const title = this.extractTitle(contentElement, doc);

    return {
      fullText,
      title,
      language: detectLanguage((fullText || title).slice(0, 500)),
      isEditable: false,
      contentElement,
      documentImages,
      metadata: {
        site: 'Xiaomi MiMo Docs',
        source: doc.URL || '',
      },
    };
  }

  getEditableElement(_doc: Document): HTMLElement | null {
    return null;
  }

  observe(doc: Document, callback: (content: SiteContentResult) => void): () => void {
    let currentElement: HTMLElement | null = null;
    let contentObserver: MutationObserver | null = null;
    let timer: ReturnType<typeof window.setTimeout> | null = null;

    const emit = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const content = this.extractContent(doc);
        if (content) callback(content);
      }, 140);
    };

    const attach = (element: HTMLElement | null) => {
      if (element === currentElement) return;
      contentObserver?.disconnect();
      currentElement = element;
      if (!element) return;

      contentObserver = new MutationObserver(emit);
      contentObserver.observe(element, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['src', 'srcset', 'data-src', 'data-original', 'data-lazy-src'],
      });
    };

    attach(this.findContentElement(doc));

    // MiMo Docs uses client-side navigation and replaces the MDX root on route changes.
    const pageObserver = new MutationObserver(() => {
      const nextElement = this.findContentElement(doc);
      if (nextElement !== currentElement) {
        attach(nextElement);
        if (nextElement) emit();
      }
    });
    pageObserver.observe(doc.body, { childList: true, subtree: true });

    return () => {
      if (timer) window.clearTimeout(timer);
      contentObserver?.disconnect();
      pageObserver.disconnect();
    };
  }

  private findContentElement(doc: Document): HTMLElement | null {
    for (const selector of CONTENT_SELECTORS) {
      const element = doc.querySelector(selector);
      if (element instanceof HTMLElement) return element;
    }
    return null;
  }

  private extractTitle(contentElement: HTMLElement, doc: Document): string {
    const heading = contentElement.querySelector('h1');
    if (heading?.textContent?.trim()) return heading.textContent.trim();

    const ogTitle = doc.querySelector('meta[property="og:title"]');
    if (ogTitle instanceof HTMLMetaElement && ogTitle.content.trim()) {
      return ogTitle.content.trim();
    }

    return doc.title || '';
  }

  private getCleanedText(
    element: HTMLElement,
    doc: Document,
    documentImages: ChatImageInput[],
  ): string {
    const clone = element.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(EXCLUDE_SELECTORS.join(',')).forEach(node => node.remove());

    clone.querySelectorAll<HTMLImageElement>('img').forEach((image, index) => {
      const sourceUrl = this.resolveImageUrl(image, doc);
      const metadata = documentImages.find(item => item.sourceUrl === sourceUrl);
      const label = metadata
        ? this.formatImageContext(metadata, index)
        : `[文档图片 ${index + 1}]`;
      image.replaceWith(clone.ownerDocument.createTextNode(`\n${label}\n`));
    });

    return (clone.innerText || clone.textContent || '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private extractImages(element: HTMLElement, doc: Document): ChatImageInput[] {
    const seen = new Set<string>();
    const images: ChatImageInput[] = [];

    element.querySelectorAll<HTMLImageElement>('img').forEach((image, index) => {
      const sourceUrl = image.currentSrc || this.resolveImageUrl(image, doc);
      if (!sourceUrl || seen.has(sourceUrl)) return;

      const width = image.naturalWidth || image.width || undefined;
      const height = image.naturalHeight || image.height || undefined;
      if (width && height && width <= 48 && height <= 48) return;

      seen.add(sourceUrl);
      const rawName = image.getAttribute('alt')?.trim() || image.getAttribute('title')?.trim();
      const name = rawName && rawName !== '图片'
        ? rawName
        : `文档图片 ${images.length + 1}`;

      images.push({
        id: `mimo-doc-image-${index + 1}`,
        name,
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

  private resolveImageUrl(image: HTMLImageElement, doc: Document): string {
    const raw = IMAGE_URL_ATTRIBUTES
      .map(attribute => image.getAttribute(attribute))
      .find(Boolean);
    if (!raw) return '';

    try {
      return new URL(raw, doc.baseURI).href.split('#')[0];
    } catch {
      return raw.split('#')[0];
    }
  }

  private guessMimeType(url: string): string {
    const path = url.split('?')[0].toLowerCase();
    if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
    if (path.endsWith('.webp')) return 'image/webp';
    return 'image/png';
  }

  private formatImageContext(image: ChatImageInput, index: number): string {
    const parts = [`文档图片 ${index + 1}`];
    if (image.name && image.name !== parts[0]) parts.push(image.name);
    if (image.width && image.height) parts.push(`${image.width}x${image.height}`);
    return `[${parts.join(' | ')}]`;
  }
}
