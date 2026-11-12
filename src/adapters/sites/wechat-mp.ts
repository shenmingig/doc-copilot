// ============================================================
// WeChat MP (微信公众号) Adapter - For mp.weixin.qq.com
// ============================================================
// Based on real DOM analysis of https://mp.weixin.qq.com articles:
//   - Title:        h1#activity-name > span.js_title_inner
//   - Author:       #js_author_name  (or meta[name=author])
//   - Account name: a#js_name
//   - Publish time: #publish_time    (populated via JS, may be empty in SSR)
//   - Body content: #js_content      (inline styles hide it; text is present)
//   - This is a READ-ONLY page — no editable element
//
// Proxy note: when running in the background service worker on hosts that
// block direct access to mp.weixin.qq.com, set
//   export https_proxy=http://agent.baidu.com:8891
// before launching Chrome or the test runner.
// ============================================================

import { ISiteAdapter, SiteContentResult } from './types';
import { detectLanguage } from '../../shared/utils/index';

/**
 * WeChat MP article URL patterns:
 *   https://mp.weixin.qq.com/s/<article-id>
 *   https://mp.weixin.qq.com/s?__biz=...&mid=...&idx=...
 */
const WECHAT_URL_PATTERNS = [
  'mp.weixin.qq.com',
];

/**
 * Title — try the rich_media_title h1 first, then og:title, then document.title.
 */
const TITLE_SELECTORS = [
  '#activity-name .js_title_inner',  // inner span (most specific)
  '#activity-name',                  // h1 wrapper
  'h1.rich_media_title',             // class-only fallback
];

/**
 * The main article body.
 * WeChat injects `style="visibility:hidden;opacity:0"` server-side and
 * removes it via JS once the page is interactive. The text content is
 * still present and readable via `textContent` even before the JS runs.
 */
const CONTENT_SELECTORS = [
  '#js_content',
  '.rich_media_content',
];

/**
 * Tags whose content we strip during text extraction (navigation chrome, etc.)
 */
const EXCLUDE_TAGS = new Set([
  'script', 'style', 'noscript', 'iframe',
  'nav', 'aside', 'footer', 'svg', 'video', 'audio',
]);

/**
 * WeChat-specific UI wrapper classes that should not contribute to body text.
 * (e.g. the embedded account-profile card at the top of articles)
 */
const EXCLUDE_CLASSES = [
  'mp_profile_iframe_wrp',   // account profile card
  'mp_profile_iframe',       // inner profile iframe element
  'wx_follow_btn_wrp',       // "follow" button wrapper
  'rich_media_tool',         // bottom toolbar (like/share)
  'rich_media_area_extra',   // "read more" recommendation area
  'recommend_list_wrp',      // related articles list
  'msg_copyright',           // copyright notice block
  'js_editor_qqemoji',       // emoji UI
  'weui-bottom-sheet',       // bottom sheet dialogs
];

export class WechatMpAdapter implements ISiteAdapter {
  readonly id = 'wechat-mp';
  readonly name = '微信公众号 (mp.weixin.qq.com)';
  private diagnosticsRun = false;

  matches(url: string): boolean {
    return WECHAT_URL_PATTERNS.some(p => url.includes(p));
  }

  extractContent(doc: Document): SiteContentResult | null {
    if (!this.diagnosticsRun) {
      this.diagnosticsRun = true;
      this.logDomDiagnostics(doc);
    }

    const contentEl = this.findContentElement(doc);
    if (!contentEl) {
      console.warn('[Doc Copilot] WechatMp: Could not find article content element');
      return null;
    }

    const fullText = this.getCleanedText(contentEl);
    const title = this.extractTitle(doc);
    const language = detectLanguage(fullText.slice(0, 500) || title);

    console.log(
      `[Doc Copilot] WechatMp: title="${title}", ` +
      `text length=${fullText.length}, lang=${language}`
    );

    return {
      fullText,
      title,
      language,
      isEditable: false,          // WeChat MP articles are always read-only
      editableElement: undefined,
      contentElement: contentEl,
      metadata: this.extractMetadata(doc),
    };
  }

  getEditableElement(_doc: Document): HTMLElement | null {
    // WeChat MP articles are read-only; there is no editable element.
    return null;
  }

  observe(doc: Document, callback: (content: SiteContentResult) => void): () => void {
    // WeChat articles are static once loaded. We watch for:
    //  1. The JS removing the visibility:hidden style from #js_content
    //  2. Any dynamic content injections (e.g. lazy images resolved)
    const contentEl = this.findContentElement(doc);

    if (!contentEl) {
      // Fallback: wait for #js_content to appear (SPA navigation)
      const bodyObserver = new MutationObserver(() => {
        const el = this.findContentElement(doc);
        if (el) {
          bodyObserver.disconnect();
          const content = this.extractContent(doc);
          if (content) callback(content);
          this.observe(doc, callback);
        }
      });
      bodyObserver.observe(doc.body, { childList: true, subtree: true });
      return () => bodyObserver.disconnect();
    }

    // Watch style attribute changes on #js_content (visibility reveal)
    const styleObserver = new MutationObserver(() => {
      const content = this.extractContent(doc);
      if (content) callback(content);
    });
    styleObserver.observe(contentEl, {
      attributes: true,
      attributeFilter: ['style'],
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => styleObserver.disconnect();
  }

  // ---- Private helpers ----

  private findContentElement(doc: Document): HTMLElement | null {
    for (const selector of CONTENT_SELECTORS) {
      const el = doc.querySelector(selector) as HTMLElement | null;
      if (el) {
        console.log(`[Doc Copilot] WechatMp: Found content via "${selector}"`);
        return el;
      }
    }
    return null;
  }

  private extractTitle(doc: Document): string {
    for (const selector of TITLE_SELECTORS) {
      const el = doc.querySelector(selector);
      if (el?.textContent?.trim()) {
        return el.textContent.trim();
      }
    }

    // og:title meta tag
    const ogTitle = doc.querySelector('meta[property="og:title"]');
    if (ogTitle instanceof HTMLMetaElement && ogTitle.content.trim()) {
      return ogTitle.content.trim();
    }

    return doc.title || '';
  }

  private extractMetadata(doc: Document): Record<string, string> {
    const metadata: Record<string, string> = {};

    // Author name (article byline, e.g. "J0hn")
    const authorNameEl = doc.querySelector('#js_author_name, #js_author_name_text');
    if (authorNameEl?.textContent?.trim()) {
      metadata.author = authorNameEl.textContent.trim();
    } else {
      // Fallback: meta[name=author]
      const metaAuthor = doc.querySelector('meta[name="author"]');
      if (metaAuthor instanceof HTMLMetaElement && metaAuthor.content.trim()) {
        metadata.author = metaAuthor.content.trim();
      }
    }

    // Public account name (e.g. "AGI Hunt")
    const accountEl = doc.querySelector('#js_name');
    if (accountEl?.textContent?.trim()) {
      metadata.account = accountEl.textContent.trim();
    }

    // Publish time — populated by JS, may be empty in SSR snapshot
    const timeEl = doc.querySelector('#publish_time');
    if (timeEl?.textContent?.trim()) {
      metadata.date = timeEl.textContent.trim();
    }

    // og:description as summary
    const ogDesc = doc.querySelector('meta[property="og:description"], meta[name="description"]');
    if (ogDesc instanceof HTMLMetaElement && ogDesc.content.trim()) {
      metadata.description = ogDesc.content.trim();
    }

    return metadata;
  }

  /**
   * Extract plain text from the article body.
   * Removes WeChat UI chrome classes and normalises whitespace.
   */
  private getCleanedText(element: HTMLElement): string {
    const clone = element.cloneNode(true) as HTMLElement;

    // Remove excluded tag types
    const tagSelector = Array.from(EXCLUDE_TAGS).join(',');
    clone.querySelectorAll(tagSelector).forEach(el => el.remove());

    // Remove WeChat UI-only wrappers
    const uiSelector = EXCLUDE_CLASSES.map(c => `.${c}`).join(',');
    clone.querySelectorAll(uiSelector).forEach(el => el.remove());

    // Remove empty alt-text only images (no meaningful text)
    // Keep <img> alt text if present — innerText won't include it anyway.

    // innerText respects block-level line breaks; fall back to textContent
    let text = clone.innerText || clone.textContent || '';

    // Normalise whitespace
    text = text
      .replace(/[ \t]+/g, ' ')        // collapse horizontal whitespace
      .replace(/\n{3,}/g, '\n\n')     // max 2 consecutive blank lines
      .trim();

    return text;
  }

  /**
   * DOM diagnostics — runs once on first extractContent() call.
   */
  private logDomDiagnostics(doc: Document): void {
    console.group('[Doc Copilot] WechatMp DOM Diagnostics');

    console.log('URL:', doc.URL || window.location.href);

    // Title
    for (const sel of TITLE_SELECTORS) {
      const el = doc.querySelector(sel);
      console.log(`  ${sel}: ${el ? `"${el.textContent?.trim().slice(0, 60)}"` : 'not found'}`);
    }

    // Content element
    for (const sel of CONTENT_SELECTORS) {
      const el = doc.querySelector(sel) as HTMLElement | null;
      if (el) {
        console.log(
          `  ${sel}: FOUND — style="${el.getAttribute('style') || ''}", ` +
          `text length=${(el.textContent || '').length}`
        );
      } else {
        console.log(`  ${sel}: not found`);
      }
    }

    // Metadata elements
    const metaEls = ['#js_author_name', '#js_name', '#publish_time'];
    for (const sel of metaEls) {
      const el = doc.querySelector(sel);
      console.log(`  ${sel}: ${el ? `"${el.textContent?.trim().slice(0, 60)}"` : 'not found'}`);
    }

    console.groupEnd();
  }
}
