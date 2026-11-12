// ============================================================
// Zhihu Adapter - For zhihu.com question/answer pages
// ============================================================

import { ISiteAdapter, SiteContentResult } from './types';
import { detectLanguage } from '../../shared/utils/index';

const CONTENT_SELECTORS = [
  '.AnswerItem .RichContent-inner',
  '.QuestionAnswer-content .RichContent-inner',
  '.RichContent-inner',
  '.Question-mainColumn',
  'main',
];

const EXCLUDE_TAGS = new Set([
  'script', 'style', 'noscript', 'iframe',
  'nav', 'aside', 'footer', 'header', 'svg', 'video', 'audio',
]);

const EXCLUDE_SELECTORS = [
  '#doc-copilot-root',
  '.dc-sel-toolbar-wrapper',
  '.ContentItem-actions',
  '.RichContent-actions',
  '.Question-sideColumn',
  '.QuestionHeader-side',
  '.QuestionHeader-actions',
  '.Modal-wrapper',
  '.Popover',
  '.Sticky',
];

export class ZhihuAdapter implements ISiteAdapter {
  readonly id = 'zhihu';
  readonly name = '知乎 (zhihu.com)';

  matches(url: string): boolean {
    return /(^|\.)zhihu\.com$/i.test(new URL(url).hostname);
  }

  extractContent(doc: Document): SiteContentResult | null {
    const contentEl = this.findContentElement(doc);
    if (!contentEl) return null;

    const title = this.extractTitle(doc);
    const answerText = this.getCleanedText(contentEl);
    const fullText = [title, answerText].filter(Boolean).join('\n\n');

    return {
      fullText,
      title,
      language: detectLanguage(fullText.slice(0, 500)),
      isEditable: false,
      editableElement: undefined,
      contentElement: contentEl,
      metadata: this.extractMetadata(doc),
    };
  }

  getEditableElement(_doc: Document): HTMLElement | null {
    return null;
  }

  observe(doc: Document, callback: (content: SiteContentResult) => void): () => void {
    const target = this.findContentElement(doc) || doc.body;
    const observer = new MutationObserver(() => {
      const content = this.extractContent(doc);
      if (content) callback(content);
    });
    observer.observe(target, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }

  private findContentElement(doc: Document): HTMLElement | null {
    for (const selector of CONTENT_SELECTORS) {
      const el = doc.querySelector(selector) as HTMLElement | null;
      if (el && this.getCleanedText(el).length > 40) {
        console.log(`[Doc Copilot] Zhihu: Found content via "${selector}"`);
        return el;
      }
    }
    return null;
  }

  private extractTitle(doc: Document): string {
    const selectors = [
      '.QuestionHeader-title',
      'h1.QuestionHeader-title',
      'h1',
      'meta[property="og:title"]',
    ];

    for (const selector of selectors) {
      const el = doc.querySelector(selector);
      if (el instanceof HTMLMetaElement && el.content.trim()) {
        return el.content.trim();
      }
      if (el?.textContent?.trim()) {
        return el.textContent.trim();
      }
    }

    return (doc.title || '').replace(/ - 知乎$/, '').trim();
  }

  private extractMetadata(doc: Document): Record<string, string> {
    const metadata: Record<string, string> = {};
    const author = doc.querySelector('.AuthorInfo-name, .AuthorInfo-head .UserLink-link');
    if (author?.textContent?.trim()) metadata.author = author.textContent.trim();

    const description = doc.querySelector('meta[property="og:description"], meta[name="description"]');
    if (description instanceof HTMLMetaElement && description.content.trim()) {
      metadata.description = description.content.trim();
    }

    return metadata;
  }

  private getCleanedText(element: HTMLElement): string {
    const clone = element.cloneNode(true) as HTMLElement;
    clone.querySelectorAll([...EXCLUDE_TAGS].join(',')).forEach(el => el.remove());
    clone.querySelectorAll(EXCLUDE_SELECTORS.join(',')).forEach(el => el.remove());

    return (clone.innerText || clone.textContent || '')
      .replace(/\u200b/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }
}
