// ============================================================
// Generic Site Adapter - Fallback for any page
// ============================================================

import { ISiteAdapter, SiteContentResult } from './types';
import { detectLanguage } from '../../shared/utils/index';

/**
 * Priority-ordered CSS selectors to find main content area.
 * The generic adapter tries each selector in order and uses the first match.
 */
const MAIN_CONTENT_SELECTORS = [
  'article',
  'main',
  '[role="main"]',
  '.content',
  '.main-content',
  '.article-content',
  '#content',
  '#main',
  '#article-content',
];

/**
 * Elements to exclude from content extraction
 */
const EXCLUDE_TAGS = new Set(['nav', 'aside', 'footer', 'header', 'script', 'style', 'noscript', 'iframe', 'svg', 'video', 'audio']);

export class GenericSiteAdapter implements ISiteAdapter {
  readonly id = 'generic';
  readonly name = 'Generic (Any Page)';

  matches(): boolean {
    // Generic adapter matches everything (as fallback)
    return true;
  }

  extractContent(doc: Document): SiteContentResult | null {
    // Try to find main content element
    const contentElement = this.findMainContentElement(doc);

    if (!contentElement) {
      // Fall back to body
      const body = doc.body;
      if (!body) return null;

      return {
        fullText: this.getCleanedText(body),
        title: doc.title,
        language: detectLanguage(doc.body?.textContent?.slice(0, 500) || ''),
        isEditable: this.checkEditable(doc),
        editableElement: this.getEditableElement(doc) || undefined,
        contentElement: body,
      };
    }

    return {
      fullText: this.getCleanedText(contentElement),
      title: this.extractTitle(doc),
      language: detectLanguage(contentElement.textContent?.slice(0, 500) || ''),
      isEditable: this.checkEditable(doc),
      editableElement: this.getEditableElement(doc) || undefined,
      contentElement,
    };
  }

  getEditableElement(doc: Document): HTMLElement | null {
    // Return the active element if it's editable
    const active = doc.activeElement;
    if (!active) return null;
    if (active instanceof HTMLElement && active.closest('#doc-copilot-root, .dc-sel-toolbar-wrapper')) {
      return null;
    }

    if (
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLInputElement && active.type === 'text') ||
      (active as HTMLElement).isContentEditable
    ) {
      return active as HTMLElement;
    }
    return null;
  }

  observe(doc: Document, callback: (content: SiteContentResult) => void): () => void {
    // Use MutationObserver to watch for content changes
    const content = this.extractContent(doc);
    if (!content) {
      return () => {};
    }

    const observer = new MutationObserver(() => {
      const newContent = this.extractContent(doc);
      if (newContent) {
        callback(newContent);
      }
    });

    observer.observe(content.contentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Also observe for mode changes (editable appearing/disappearing)
    const modeObserver = new MutationObserver(() => {
      const newContent = this.extractContent(doc);
      if (newContent && newContent.isEditable !== content.isEditable) {
        callback(newContent);
      }
    });

    modeObserver.observe(doc.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['contenteditable'],
    });

    return () => {
      observer.disconnect();
      modeObserver.disconnect();
    };
  }

  private findMainContentElement(doc: Document): HTMLElement | null {
    // Try each selector in order
    for (const selector of MAIN_CONTENT_SELECTORS) {
      const el = doc.querySelector(selector) as HTMLElement | null;
      if (el) {
        console.log(`[Doc Copilot] Generic adapter found content using selector: ${selector}`);
        return el;
      }
    }

    // If no selector matches, try to find the element with the most text
    const allElements = Array.from(doc.querySelectorAll('*'));
    let bestElement: HTMLElement | null = null;
    let maxTextLength = 0;

    for (const el of allElements) {
      // Skip excluded tags and very small elements
      if (
        EXCLUDE_TAGS.has(el.tagName.toLowerCase()) ||
        (el as HTMLElement).offsetHeight < 50 ||
        (el as HTMLElement).offsetWidth < 50
      ) {
        continue;
      }

      const text = el.textContent || '';
      if (text.length > maxTextLength) {
        maxTextLength = text.length;
        bestElement = el as HTMLElement;
      }
    }

    if (bestElement && maxTextLength > 100) {
      console.log(`[Doc Copilot] Generic adapter found content by text length search (${maxTextLength} chars)`);
      return bestElement;
    }

    return null;
  }

  private extractTitle(doc: Document): string {
    // Try h1, h2, title attribute, then document.title
    const h1 = doc.querySelector('h1');
    if (h1?.textContent) {
      return h1.textContent.trim();
    }
    return doc.title;
  }

  private getCleanedText(element: HTMLElement): string {
    // Clone and clean the element before extracting text
    const clone = element.cloneNode(true) as HTMLElement;

    // Remove excluded elements from clone
    const elementsToRemove = clone.querySelectorAll(Array.from(EXCLUDE_TAGS).join(','));
    elementsToRemove.forEach(el => el.remove());

    // Get inner text (handles better than textContent for formatting)
    let text = clone.innerText || clone.textContent || '';

    // Clean up whitespace
    text = text
      .replace(/\s+/g, ' ')
      .replace(/\n\s*\n/g, '\n\n')
      .trim();

    return text;
  }

  private checkEditable(doc: Document): boolean {
    return this.getEditableElement(doc) !== null;
  }
}
