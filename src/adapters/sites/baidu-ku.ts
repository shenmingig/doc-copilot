// ============================================================
// Baidu Knowledge Base Adapter - For ku.baidu-int.com
// ============================================================
// Based on real DOM diagnostics from 2026-03-05:
//   - Editor: Slate.js (data-slate-editor)
//   - Main doc: .mp-slide-container.mp-editor-container (NOT .mp-micro-editor)
//   - Comment box: .mp-micro-editor (must exclude)
//   - Read-only: .mp-editor-readonly + contenteditable="false"
//   - Edit mode: contenteditable="true", no .mp-editor-readonly
//   - Paragraphs: .mp-paragraph-wrapper[data-morpho-type]
//   - Text leaves: span[data-slate-string="true"]
//   - Headings: .mp-heading-wrapper or [data-morpho-type="heading*"]
//   - Code blocks: .mp-block-code-top-bar (UI chrome, skip)
//   - Lists: .mp-list-item-bullet (UI chrome, skip)
// ============================================================

import { ISiteAdapter, SiteContentResult } from './types';
import { ChatImageInput } from '../../shared/types/index';
import { detectLanguage } from '../../shared/utils/index';

/**
 * The main document editor selector.
 * Matches the Slate editor for the document body (excludes comment box).
 *
 * Key distinction:
 *   - Document body has class `mp-slide-container` (and never `mp-micro-editor`)
 *   - Comment box has class `mp-micro-editor` (and never `mp-slide-container`)
 */
const DOC_EDITOR_SELECTOR = 'div[data-slate-editor="true"].mp-editor-container:not(.mp-micro-editor)';

/**
 * Fallback: if the class-based selector fails, try by structure.
 * The doc editor lives inside #knowledgeContent.
 */
const DOC_EDITOR_FALLBACK_SELECTOR = '#knowledgeContent div[data-slate-editor="true"]';
const DEBUG_BAIDU_KU = false;

/**
 * Title selectors, ordered by specificity
 */
const TITLE_SELECTORS = [
  '.mp-header-title-editor input',          // Title input in edit mode
  '.mp-header-title-editor',                // Title wrapper
  '.Document_title__wrapper input',         // Alternate title input
  '.doc-title',
];

/**
 * Tags to exclude when extracting text content
 */
const EXCLUDE_TAGS = new Set([
  'nav', 'aside', 'footer', 'header', 'script', 'style',
  'noscript', 'iframe', 'svg', 'video', 'audio',
]);

/**
 * UI-only classes to exclude from text extraction (Slate decorations, not content)
 */
const EXCLUDE_CLASSES = [
  'mp-card-add',
  'mp-card-menu-wrapper',
  'mp-card-infos',
  'mp-heading-order-container',
  'mp-list-item-bullet',
  'mp-block-code-top-bar',
  'mp-editor-bottom-space',
  'mp-editor-bottom-slot-container',
  'mp-placeholder-provider',
  'mp-toast-provider',
  'mp-mention-dropdown-provider',
  'mp-paragraph-block-selection',
  'mp-block-code-preview-container',
  'mp-editor-provider-container',
];

export class BaiduKuAdapter implements ISiteAdapter {
  readonly id = 'baidu-ku';
  readonly name = 'Baidu Knowledge Base (ku.baidu-int.com)';
  private diagnosticsRun = false;

  matches(url: string): boolean {
    return url.includes('ku.baidu-int.com') || url.includes('ku.baidu.com');
  }

  extractContent(doc: Document): SiteContentResult | null {
    // DOM diagnostic logging - runs once on first call
    if (DEBUG_BAIDU_KU && !this.diagnosticsRun) {
      this.diagnosticsRun = true;
      this.logDomDiagnostics(doc);
    }

    const editorEl = this.findDocEditor(doc);
    if (!editorEl) {
      console.warn('[Doc Copilot] BaiduKu: Could not find Slate document editor');
      return null;
    }

    const isEditable = editorEl.getAttribute('contenteditable') === 'true';

    if (DEBUG_BAIDU_KU) {
      const rawTextContent = editorEl.textContent || '';
      const rawInnerText = editorEl.innerText || '';
      const paragraphs = editorEl.querySelectorAll('.mp-paragraph-wrapper');
      const slateStrings = editorEl.querySelectorAll('span[data-slate-string="true"]');
      const slateLeaves = editorEl.querySelectorAll('span[data-slate-leaf="true"]');
      console.group('[Doc Copilot] BaiduKu Content Debug');
      console.log(`contenteditable: ${editorEl.getAttribute('contenteditable')}`);
      console.log(`className: ${editorEl.className}`);
      console.log(`childNodes: ${editorEl.childNodes.length}, children: ${editorEl.children.length}`);
      console.log(`textContent length: ${rawTextContent.length}`);
      console.log(`innerText length: ${rawInnerText.length}`);
      console.log(`paragraphs (.mp-paragraph-wrapper): ${paragraphs.length}`);
      console.log(`slate strings (span[data-slate-string]): ${slateStrings.length}`);
      console.log(`slate leaves (span[data-slate-leaf]): ${slateLeaves.length}`);
      if (rawTextContent.length > 0) {
        console.log(`textContent preview: "${rawTextContent.slice(0, 300)}"`);
      }
      if (rawInnerText.length > 0) {
        console.log(`innerText preview: "${rawInnerText.slice(0, 300)}"`);
      }
      paragraphs.forEach((p, i) => {
        if (i < 3) console.log(`  paragraph[${i}]: "${(p.textContent || '').slice(0, 100)}"`);
      });
      console.groupEnd();
    }

    const documentImages = this.extractImages(editorEl, doc);
    const fullText = this.getCleanedText(editorEl, documentImages);
    if (DEBUG_BAIDU_KU) {
      console.log(`[Doc Copilot] BaiduKu: Extracted fullText length: ${fullText.length}, preview: "${fullText.slice(0, 200)}"`);
    }

    return {
      fullText,
      title: this.extractTitle(doc),
      language: detectLanguage(editorEl.textContent?.slice(0, 500) || ''),
      isEditable,
      editableElement: isEditable ? editorEl : undefined,
      contentElement: editorEl,
      documentImages,
      metadata: this.extractMetadata(doc),
    };
  }

  getEditableElement(doc: Document): HTMLElement | null {
    const editor = this.findDocEditor(doc);
    if (editor && editor.getAttribute('contenteditable') === 'true') {
      return editor;
    }
    return null;
  }

  observe(doc: Document, callback: (content: SiteContentResult) => void): () => void {
    const editorEl = this.findDocEditor(doc);
    if (!editorEl) {
      // Editor not found yet — watch for it to appear
      let editorCleanup: (() => void) | null = null;
      const bodyObserver = new MutationObserver(() => {
        const el = this.findDocEditor(doc);
        if (el) {
          bodyObserver.disconnect();
          const content = this.extractContent(doc);
          if (content) callback(content);
          // Re-run observe now that we have the editor
          editorCleanup = this.observe(doc, callback);
        }
      });
      bodyObserver.observe(doc.body, { childList: true, subtree: true });
      return () => {
        bodyObserver.disconnect();
        editorCleanup?.();
      };
    }

    const initialContent = this.extractContent(doc);
    let lastEditable = initialContent?.isEditable ?? false;

    // Watch content changes inside editor
    const contentObserver = new MutationObserver(() => {
      const newContent = this.extractContent(doc);
      if (newContent) callback(newContent);
    });
    contentObserver.observe(editorEl, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Watch for edit <-> readonly mode transitions
    const modeObserver = new MutationObserver(() => {
      const newEditor = this.findDocEditor(doc);
      if (!newEditor) return;
      const nowEditable = newEditor.getAttribute('contenteditable') === 'true';
      if (nowEditable !== lastEditable) {
        lastEditable = nowEditable;
        console.log(`[Doc Copilot] BaiduKu: Mode changed → ${nowEditable ? 'edit' : 'readonly'}`);
        const newContent = this.extractContent(doc);
        if (newContent) callback(newContent);
      }
    });
    // The mode change modifies the contenteditable attribute on the editor itself,
    // but also adds/removes mp-editor-readonly class. Watch from a parent.
    const watchRoot = editorEl.parentElement || doc.body;
    modeObserver.observe(watchRoot, {
      subtree: true,
      attributes: true,
      attributeFilter: ['contenteditable', 'class'],
    });

    return () => {
      contentObserver.disconnect();
      modeObserver.disconnect();
    };
  }

  // ---- Private helpers ----

  /**
   * Find the main document Slate editor (excluding comment box / micro editors).
   */
  private findDocEditor(doc: Document): HTMLElement | null {
    // Primary: class-based selector
    let el = doc.querySelector(DOC_EDITOR_SELECTOR) as HTMLElement | null;
    if (el) {
      if (DEBUG_BAIDU_KU) console.log('[Doc Copilot] BaiduKu: Found doc editor via primary selector');
      return el;
    }

    // Fallback: inside #knowledgeContent
    el = doc.querySelector(DOC_EDITOR_FALLBACK_SELECTOR) as HTMLElement | null;
    if (el) {
      // Double-check it's not the micro/comment editor
      if (!el.classList.contains('mp-micro-editor')) {
        if (DEBUG_BAIDU_KU) console.log('[Doc Copilot] BaiduKu: Found doc editor via fallback (#knowledgeContent)');
        return el;
      }
    }

    // Last resort: find a slate editor that's NOT mp-micro-editor
    const allEditors = doc.querySelectorAll('div[data-slate-editor="true"]');
    for (const candidate of Array.from(allEditors)) {
      if (!candidate.classList.contains('mp-micro-editor')) {
        if (DEBUG_BAIDU_KU) console.log('[Doc Copilot] BaiduKu: Found doc editor via last-resort scan');
        return candidate as HTMLElement;
      }
    }

    return null;
  }

  private extractTitle(doc: Document): string {
    const editor = this.findDocEditor(doc);

    if (editor) {
      const heading = editor.querySelector('[data-morpho-type="heading1"], [data-morpho-type^="heading"], h1');
      if (heading?.textContent?.trim()) {
        return heading.textContent.trim();
      }
    }

    for (const selector of TITLE_SELECTORS) {
      const el = doc.querySelector(selector);
      if (!el) continue;

      // Handle <input> elements (title input field)
      if (el instanceof HTMLInputElement && el.value.trim()) {
        return el.value.trim();
      }
      if (el.textContent?.trim()) {
        return el.textContent.trim();
      }
    }

    if (editor) {
      const firstContentLine = this.getCleanedText(editor)
        .split('\n')
        .map(line => line.trim())
        .find(line => line && line.length <= 80 && !/^(状态|日期|作者|案例作者|案例分类|使用工具)[:：]/.test(line));
      if (firstContentLine) return firstContentLine;
    }

    return doc.title || '';
  }

  private extractMetadata(doc: Document): Record<string, string> {
    const metadata: Record<string, string> = {};

    // Try to extract author from document info area
    const authorEl = doc.querySelector(
      '.Document_author, .doc-info .author, [data-testid="doc-author"]'
    );
    if (authorEl?.textContent?.trim()) {
      metadata.author = authorEl.textContent.trim();
    }

    // Last modified time
    const timeEl = doc.querySelector(
      '.Document_time, .doc-info time, [data-testid="doc-time"]'
    );
    if (timeEl?.textContent?.trim()) {
      metadata.date = timeEl.textContent.trim();
    }

    return metadata;
  }

  /**
   * Extract cleaned text from the Slate editor.
   * Respects block structure (paragraphs, headings, lists, code blocks).
   */
  private getCleanedText(element: HTMLElement, documentImages: ChatImageInput[] = []): string {
    const clone = element.cloneNode(true) as HTMLElement;

    // Remove excluded tags
    const tagSelector = Array.from(EXCLUDE_TAGS).join(',');
    clone.querySelectorAll(tagSelector).forEach(el => el.remove());

    // Remove UI-only Slate decorations
    const uiSelector = EXCLUDE_CLASSES.map(c => `.${c}`).join(',');
    clone.querySelectorAll(uiSelector).forEach(el => el.remove());

    // Remove zero-width / placeholder spans
    clone.querySelectorAll('span[data-slate-zero-width]').forEach(el => el.remove());

    // Preserve document image locations in text context instead of silently dropping them.
    clone.querySelectorAll('img').forEach((img, index) => {
      const meta = documentImages[index];
      const label = meta
        ? this.formatImageContext(meta, index)
        : `[文档图片 ${index + 1}]`;
      img.replaceWith(clone.ownerDocument.createTextNode(`\n${label}\n`));
    });

    // Use innerText which respects visual line breaks from block elements
    let text = clone.innerText || clone.textContent || '';

    // Clean up excessive whitespace
    text = text
      .replace(/[ \t]+/g, ' ')           // collapse horizontal whitespace
      .replace(/\n{3,}/g, '\n\n')        // max 2 consecutive newlines
      .trim();

    return text;
  }

  private extractImages(element: HTMLElement, doc: Document): ChatImageInput[] {
    const seen = new Set<string>();
    const images: ChatImageInput[] = [];

    element.querySelectorAll<HTMLImageElement>('img').forEach((img, index) => {
      if (!img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) return;

      const sourceUrl = this.resolveImageUrl(img, doc);
      if (!sourceUrl) return;
      if (this.isDecorativeImage(img, sourceUrl)) return;

      if (!img.crossOrigin && !sourceUrl.startsWith('data:')) {
        img.crossOrigin = 'anonymous';
      }

      const key = sourceUrl.split('#')[0];
      if (seen.has(key)) return;
      seen.add(key);

      const alt = img.getAttribute('alt')?.trim() || '';
      const title = img.getAttribute('title')?.trim() || '';
      const name = alt || title || `文档图片 ${images.length + 1}`;
      const width = img.naturalWidth || img.width || undefined;
      const height = img.naturalHeight || img.height || undefined;

      images.push({
        id: `doc-image-${index + 1}`,
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

    const raw = attrs.map(attr => img.getAttribute(attr)).find(Boolean)
      || img.currentSrc
      || '';
    if (!raw) return '';

    try {
      return new URL(raw, doc.baseURI).href;
    } catch {
      return raw;
    }
  }

  private isDecorativeImage(img: HTMLImageElement, sourceUrl: string): boolean {
    if (sourceUrl.startsWith('data:image/gif') && sourceUrl.length < 300) return true;
    const rect = img.getBoundingClientRect();
    const width = img.naturalWidth || img.width || rect.width;
    const height = img.naturalHeight || img.height || rect.height;
    if (width > 0 && height > 0 && width <= 24 && height <= 24) return true;

    const className = img.className || '';
    return /avatar|icon|emoji|logo|loading|placeholder/i.test(String(className));
  }

  private guessMimeType(url: string): string {
    if (url.startsWith('data:')) {
      const match = url.match(/^data:([^;,]+)/);
      return match?.[1] || 'image/png';
    }
    const path = url.split('?')[0].toLowerCase();
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

  /**
   * DOM diagnostics — logs page structure to Console (runs once).
   */
  private logDomDiagnostics(doc: Document): void {
    console.group('[Doc Copilot] BaiduKu DOM Diagnostics');

    // 1. All Slate editors on page
    const slateEditors = doc.querySelectorAll('div[data-slate-editor="true"]');
    console.log(`Slate editors found: ${slateEditors.length}`);
    slateEditors.forEach((el, i) => {
      const h = el as HTMLElement;
      console.log(
        `  #${i + 1}: class="${h.className}" ` +
        `contenteditable="${h.getAttribute('contenteditable')}" ` +
        `uuid="${h.dataset.slateEditorUuid || '?'}" ` +
        `chars=${(h.textContent || '').length}`
      );
    });

    // 2. Document structure
    const knowledgeHome = doc.getElementById('knowledgeHomeId');
    const knowledgeContent = doc.getElementById('knowledgeContent');
    console.log(`#knowledgeHomeId: ${knowledgeHome ? 'found' : 'not found'}`);
    console.log(`#knowledgeContent: ${knowledgeContent ? 'found' : 'not found'}`);

    // 3. Content editor match test
    const primary = doc.querySelector(DOC_EDITOR_SELECTOR);
    const fallback = doc.querySelector(DOC_EDITOR_FALLBACK_SELECTOR);
    console.log(`Primary selector match: ${primary ? 'YES' : 'no'}`);
    console.log(`Fallback selector match: ${fallback ? 'YES' : 'no'}`);

    // 4. Content stats
    const editor = this.findDocEditor(doc);
    if (editor) {
      const paragraphs = editor.querySelectorAll('.mp-paragraph-wrapper');
      const headings = editor.querySelectorAll('[data-morpho-type^="heading"]');
      const codeBlocks = editor.querySelectorAll('[data-morpho-type="code"]');
      console.log(`Doc content: ${paragraphs.length} paragraphs, ${headings.length} headings, ${codeBlocks.length} code blocks`);
      console.log(`Total text length: ${(editor.textContent || '').length} chars`);
    }

    console.groupEnd();
  }
}
