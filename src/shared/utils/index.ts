// ============================================================
// Shared Utilities
// ============================================================

import katex from 'katex';

// ─── Log Collector (ring buffer, max 1000 entries) ──────────────────────────

export interface LogEntry {
  ts: number;       // timestamp ms
  level: 'log' | 'warn' | 'error' | 'info';
  args: string;     // serialized arguments
}

const LOG_MAX = 1000;
const _logEntries: LogEntry[] = [];

function _serialize(args: unknown[]): string {
  return args.map(a => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

function _patchConsole(): void {
  const levels = ['log', 'warn', 'error', 'info'] as const;
  for (const level of levels) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      _logEntries.push({ ts: Date.now(), level, args: _serialize(args) });
      if (_logEntries.length > LOG_MAX) _logEntries.shift();
    };
  }
}

// Patch immediately when the module is loaded
_patchConsole();

export function getLogEntries(): readonly LogEntry[] {
  return _logEntries;
}

export function clearLogEntries(): void {
  _logEntries.length = 0;
}

/** Generate a unique ID */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Debounce a function */
export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  ms: number,
): T & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const debounced = function (this: unknown, ...args: unknown[]) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, ms);
  } as T & { cancel: () => void };

  debounced.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return debounced;
}

/** Throttle a function */
export function throttle<T extends (...args: unknown[]) => unknown>(
  fn: T,
  ms: number,
): T {
  let lastCall = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return function (this: unknown, ...args: unknown[]) {
    const now = Date.now();
    const remaining = ms - (now - lastCall);

    if (remaining <= 0) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      lastCall = now;
      fn.apply(this, args);
    } else if (!timer) {
      timer = setTimeout(() => {
        lastCall = Date.now();
        timer = null;
        fn.apply(this, args);
      }, remaining);
    }
  } as T;
}

/** Simple event emitter */
export class EventEmitter<T extends { [K in keyof T]: unknown }> {
  private handlers: Partial<Record<keyof T, Array<(data: unknown) => void>>> = {};

  on<K extends keyof T>(event: K, handler: (data: T[K]) => void): () => void {
    if (!this.handlers[event]) {
      this.handlers[event] = [];
    }
    this.handlers[event]!.push(handler as (data: unknown) => void);

    return () => {
      this.handlers[event] = this.handlers[event]?.filter(h => h !== handler);
    };
  }

  emit<K extends keyof T>(event: K, data: T[K]): void {
    this.handlers[event]?.forEach(h => h(data));
  }

  removeAll(): void {
    this.handlers = {};
  }
}

/** Detect document language from text */
export function detectLanguage(text: string): string {
  const chineseChars = text.match(/[\u4e00-\u9fff]/g)?.length || 0;
  const totalChars = text.replace(/\s/g, '').length || 1;
  const chineseRatio = chineseChars / totalChars;

  if (chineseRatio > 0.3) return 'zh';
  return 'en';
}

/** Truncate text to maxLen, preferring word/sentence boundaries */
export function truncateText(text: string, maxLen: number, fromEnd = false): string {
  if (text.length <= maxLen) return text;

  if (fromEnd) {
    const truncated = text.slice(-maxLen);
    const idx = truncated.indexOf('\n');
    return idx > 0 && idx < maxLen * 0.2 ? truncated.slice(idx + 1) : truncated;
  }

  const truncated = text.slice(0, maxLen);
  const idx = truncated.lastIndexOf('\n');
  return idx > maxLen * 0.8 ? truncated.slice(0, idx) : truncated;
}

/** Escape HTML entities */
export function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, c => map[c]);
}

export function chatContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      if (!part || typeof part !== 'object') return '';
      const text = (part as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Create a CSS class string from conditional object */
export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

/**
 * Render Markdown to HTML with support for:
 * - Headings (# ## ###)
 * - Bold (**text**)
 * - Italic (*text*)
 * - Code blocks (```lang\ncode```)
 * - Inline code (`code`)
 * - Links ([text](url))
 * - Images (![alt](url))
 * - Unordered lists (- item)
 * - Ordered lists (1. item)
 * - Tables (| col | col |)
 * - Blockquotes (> text)
 * - Horizontal rules (---)
 * - LaTeX formulas (inline and display, locally rendered to native MathML)
 */
export function renderMarkdown(md: string): string {
  // Reserve fragment delimiters for our own placeholders, never user input.
  let html = md.replace(/\u0000/g, '');
  const blockFragments: string[] = [];
  const inlineFragments: string[] = [];
  const stashInline = (value: string): string =>
    `\u0000DC_INLINE_${inlineFragments.push(value) - 1}\u0000`;
  const stashBlock = (blockHtml: string): string => {
    const index = blockFragments.push(blockHtml) - 1;
    return `\u0000DC_BLOCK_${index}\u0000`;
  };

  // Code blocks (must be first to avoid processing content inside)
  html = html.replace(/(^|\n)[ \t]{0,3}(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)(?:\n[ \t]{0,3}\2[ \t]*(?=\n|$)|$)/g, (_match, prefix, _fence, lang, code) => {
    const langLabel = lang ? ` <span class="dc-code-lang">${escapeHtml(lang)}</span>` : '';
    return `${prefix}${stashBlock(`<pre class="dc-code-block">${langLabel}<code>${escapeHtml(code)}</code></pre>`)}\n`;
  });
  // Protect inline code before scanning formulas or normalizing block boundaries.
  html = html.replace(/(`+)([^\n]*?)\1/g, (_match, _ticks, code) =>
    stashInline(`<code class="dc-inline-code">${escapeHtml(code)}</code>`));

  const mathSource = html;
  const isEscaped = (offset: number): boolean => {
    let slashes = 0;
    while (offset > 0 && mathSource[--offset] === '\\') slashes++;
    return slashes % 2 === 1;
  };
  // Links/URLs are consumed as literals so dollar signs inside them stay intact.
  html = html.replace(/(https?:\/\/[^\s<>]+|!?\[[^\]\n]*\]\([^)\n]*\))|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|\\\(([\s\S]*?)\\\)|\$([^\n$]+?)\$/g,
    (match, link, bracket, dollars, parens, inlineDollar, offset) => {
      if (link || isEscaped(offset)) return match;
      const expression: string = bracket ?? dollars ?? parens ?? inlineDollar;
      if (!expression.trim()) return match;
      // A single dollar must hug the expression; $20 and $30 are prices.
      if (inlineDollar !== undefined && (/^\s|\s$/.test(expression) || /\d/.test(mathSource[offset + match.length] || ''))) return match;
      const display = bracket !== undefined || dollars !== undefined;
      let rendered: string;
      try {
        if (expression.length > 20_000) throw new Error('Formula too long');
        rendered = katex.renderToString(expression, {
          displayMode: display,
          output: 'mathml',
          throwOnError: true,
          trust: false,
          strict: 'ignore',
          maxExpand: 500,
          maxSize: 20,
        });
      } catch {
        // Incomplete streamed or unsupported expressions remain readable.
        return stashInline(`<span class="dc-math-fallback">${escapeHtml(match)}</span>`);
      }
      return display
        ? `\n${stashBlock(`<div class="dc-math-block">${rendered}</div>`)}\n`
        : stashInline(`<span class="dc-math-inline">${rendered}</span>`);
    });
  html = escapeHtml(html);

  // Split into lines for block-level processing
  const lines = normalizeMarkdownBlockBoundaries(html.split('\n'));
  const output: string[] = [];
  let paragraphLines: string[] = [];
  let inList = false;
  let inOrderedList = false;
  let inTable = false;
  let tableAlignments: Array<'left' | 'center' | 'right'> = [];
  let inBlockquote = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const blockMatch = line.trim().match(/^\u0000DC_BLOCK_(\d+)\u0000$/);
    if (blockMatch) {
      flushParagraph();
      closeBlocks();
      output.push(blockFragments[Number(blockMatch[1])] ?? '');
      continue;
    }

    // Horizontal rule
    if (/^-{3,}$/.test(line.trim())) {
      flushParagraph();
      closeBlocks();
      output.push('<hr class="dc-hr">');
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      closeBlocks();
      const level = headingMatch[1].length;
      const text = processInline(headingMatch[2]);
      output.push(`<h${level} class="dc-h${level}">${text}</h${level}>`);
      continue;
    }

    // Unordered list
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (ulMatch) {
      flushParagraph();
      if (inOrderedList) closeOrderedList();
      if (inBlockquote) closeBlockquote();
      if (!inList) {
        output.push('<ul class="dc-ul">');
        inList = true;
      }
      const text = processInline(ulMatch[2]);
      output.push(`<li class="dc-li">${text}</li>`);
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\s*)\d+[.)、]\s*(.+)$/);
    if (olMatch) {
      flushParagraph();
      if (inList) closeList();
      if (inBlockquote) closeBlockquote();
      if (!inOrderedList) {
        output.push('<ol class="dc-ol">');
        inOrderedList = true;
      }
      const text = processInline(olMatch[2]);
      output.push(`<li class="dc-li">${text}</li>`);
      continue;
    }

    // Table
    const tableRowMatch = line.match(/^\|(.+)\|$/);
    if (tableRowMatch) {
      const cells = tableRowMatch[1].split('|').map(c => c.trim());

      // Check if next line is separator (|---|---|)
      if (!inTable && i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        const sepMatch = nextLine.match(/^\|([\s:-]+\|)+$/);
        if (sepMatch) {
          flushParagraph();
          // Parse alignments from separator
          tableAlignments = nextLine.split('|').slice(1, -1).map(sep => {
            sep = sep.trim();
            if (sep.startsWith(':') && sep.endsWith(':')) return 'center';
            if (sep.endsWith(':')) return 'right';
            return 'left';
          });

          closeBlocks();
          output.push('<table class="dc-table"><thead><tr>');
          cells.forEach((cell, idx) => {
            const align = tableAlignments[idx] || 'left';
            output.push(`<th class="dc-th" style="text-align: ${align}">${processInline(cell)}</th>`);
          });
          output.push('</tr></thead><tbody>');
          inTable = true;
          i++; // Skip separator line
          continue;
        }
      }

      if (inTable) {
        output.push('<tr>');
        cells.forEach((cell, idx) => {
          const align = tableAlignments[idx] || 'left';
          output.push(`<td class="dc-td" style="text-align: ${align}">${processInline(cell)}</td>`);
        });
        output.push('</tr>');
        continue;
      }
    } else if (inTable) {
      closeTable();
    }

    // Blockquote
    const quoteMatch = line.match(/^(?:>|&gt;)\s*(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      if (inList) closeList();
      if (inOrderedList) closeOrderedList();
      if (!inBlockquote) {
        output.push('<blockquote class="dc-blockquote">');
        inBlockquote = true;
      }
      const text = processInline(quoteMatch[1]);
      output.push(text || '<br>');
      continue;
    } else if (inBlockquote && line.trim() === '') {
      closeBlockquote();
      output.push('<div class="dc-md-gap"></div>');
      continue;
    } else if (inBlockquote && !isBlockStart(line)) {
      output.push(`<br>${processInline(line.trim())}`);
      continue;
    } else if (inBlockquote) {
      closeBlockquote();
    }

    // Regular paragraph
    if (line.trim() === '') {
      flushParagraph();
      closeBlocks();
      output.push('<div class="dc-md-gap"></div>');
    } else if ((inList || inOrderedList) && /^\s{2,}\S/.test(line)) {
      appendToLastListItem(line.trim());
    } else {
      closeBlocks();
      paragraphLines.push(line.trim());
    }
  }

  flushParagraph();
  closeBlocks();

  return output.join('\n').replace(/\u0000DC_INLINE_(\d+)\u0000/g,
    (_match, index) => inlineFragments[Number(index)] ?? '');

  function flushParagraph() {
    if (!paragraphLines.length) return;
    const text = renderParagraphLines(paragraphLines);
    paragraphLines = [];
    if (text) output.push(`<p class="dc-p">${text}</p>`);
  }

  function renderParagraphLines(linesToJoin: string[]): string {
    return linesToJoin
      .map(line => line.trim())
      .filter(Boolean)
      .map(processInline)
      .join('<br>');
  }

  function appendToLastListItem(text: string) {
    const rendered = processInline(text);
    for (let i = output.length - 1; i >= 0; i--) {
      if (/^<li class="dc-li">[\s\S]*<\/li>$/.test(output[i])) {
        output[i] = output[i].replace(/<\/li>$/, `<br>${rendered}</li>`);
        return;
      }
    }
    paragraphLines.push(text);
  }

  function closeBlocks() {
    closeList();
    closeOrderedList();
    closeTable();
    closeBlockquote();
  }

  function closeList() {
    if (inList) {
      output.push('</ul>');
      inList = false;
    }
  }

  function closeOrderedList() {
    if (inOrderedList) {
      output.push('</ol>');
      inOrderedList = false;
    }
  }

  function closeTable() {
    if (inTable) {
      output.push('</tbody></table>');
      inTable = false;
      tableAlignments = [];
    }
  }

  function closeBlockquote() {
    if (inBlockquote) {
      output.push('</blockquote>');
      inBlockquote = false;
    }
  }

  function isBlockStart(line: string): boolean {
    const trimmed = line.trim();
    return /^\u0000DC_BLOCK_\d+\u0000$/.test(trimmed)
      || /^-{3,}$/.test(trimmed)
      || /^(#{1,6})\s+/.test(line)
      || /^(\s*)[-*+]\s+(.+)$/.test(line)
      || /^(\s*)\d+[.)、]\s*(.+)$/.test(line)
      || /^\|(.+)\|$/.test(line)
      || /^(?:>|&gt;)\s*(.*)$/.test(line);
  }

  function processInline(text: string): string {
    const htmlFragments: string[] = [];
    const stashHtml = (html: string): string => {
      const index = htmlFragments.push(html) - 1;
      return `\u0000DC_HTML_${index}\u0000`;
    };
    const restoreHtml = (value: string): string =>
      value.replace(/\u0000DC_HTML_(\d+)\u0000/g, (_match, index) => htmlFragments[Number(index)] ?? '');
    const renderLink = (label: string, url: string): string => {
      const href = normalizeLinkUrl(url);
      if (!href) return label;
      return `<a href="${href}" class="dc-link" target="_blank" rel="noopener noreferrer">${label}</a>`;
    };

    // Images (must be before links)
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, url) => {
      const src = normalizeLinkUrl(url);
      if (!src) return alt;
      return stashHtml(`<img src="${src}" alt="${alt}" class="dc-img">`);
    });
    // Links
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => stashHtml(renderLink(label, url)));
    // Inline code
    text = text.replace(/`([^`]+)`/g, (_match, code) => stashHtml(`<code class="dc-inline-code">${code}</code>`));
    // Bare URLs
    text = text.replace(/\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?，。；：！？]/g, url => stashHtml(renderLink(url, url)));
    // Bold
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Italic
    text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    return restoreHtml(text);
  }

  function normalizeLinkUrl(url: string): string | null {
    const trimmed = url.trim();
    if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed.replace(/&amp;/g, '&');
    if (/^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(trimmed)) {
      return trimmed.replace(/\s/g, '');
    }
    return null;
  }
}

function normalizeMarkdownBlockBoundaries(sourceLines: string[]): string[] {
  const lines: string[] = [];

  const expandedLines = sourceLines.flatMap(splitInlineMarkdownListItems);
  for (let index = 0; index < expandedLines.length; index++) {
    let line = expandedLines[index];
    const headingStart = findEmbeddedHeadingStart(line);
    if (headingStart > 0) {
      lines.push(line.slice(0, headingStart).trimEnd());
      line = line.slice(headingStart);
    }

    const separator = expandedLines[index + 1]?.trim() || '';
    if (!isMarkdownTableSeparator(separator)) {
      lines.push(line);
      continue;
    }

    const expectedCellCount = separator.replace(/^\||\|$/g, '').split('|').length;
    let rowStart = -1;
    let pipe = line.indexOf('|');
    while (pipe >= 0) {
      const candidate = line.slice(pipe).trim();
      if (candidate.startsWith('|') && candidate.endsWith('|')) {
        const cellCount = candidate.slice(1, -1).split('|').length;
        if (cellCount === expectedCellCount) {
          rowStart = pipe;
          break;
        }
      }
      pipe = line.indexOf('|', pipe + 1);
    }

    if (rowStart > 0) {
      const prefix = line.slice(0, rowStart).trimEnd();
      if (prefix) lines.push(prefix);
      lines.push(line.slice(rowStart).trim());
    } else {
      lines.push(line);
    }
  }

  return lines;
}

function splitInlineMarkdownListItems(line: string): string[] {
  const markers: number[] = [];
  let codeDelimiterLength = 0;

  for (let index = 0; index < line.length; index++) {
    if (line[index] === '`') {
      let end = index + 1;
      while (line[end] === '`') end++;
      const delimiterLength = end - index;
      if (!codeDelimiterLength) codeDelimiterLength = delimiterLength;
      else if (delimiterLength === codeDelimiterLength) codeDelimiterLength = 0;
      index = end - 1;
      continue;
    }
    if (codeDelimiterLength || index === 0 || line[index] !== '-') continue;
    if (!/\s/.test(line[index - 1]) || !/^\s+\*\*\S/.test(line.slice(index + 1))) continue;
    markers.push(index);
  }

  if (!markers.length) return [line];
  const lines: string[] = [];
  let start = 0;
  for (const marker of markers) {
    const preceding = line.slice(start, marker).trimEnd();
    if (preceding) lines.push(preceding);
    start = marker;
  }
  const last = line.slice(start).trim();
  if (last) lines.push(last);
  return lines;
}

function findEmbeddedHeadingStart(line: string): number {
  const pattern = /\s+(#{1,6}\s+.+)$/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line))) {
    const boundary = match.index + match[0].indexOf('#');
    let codeDelimiterLength = 0;
    for (let index = 0; index < boundary; index++) {
      if (line[index] !== '`') continue;
      let end = index + 1;
      while (line[end] === '`') end++;
      const delimiterLength = end - index;
      if (!codeDelimiterLength) codeDelimiterLength = delimiterLength;
      else if (delimiterLength === codeDelimiterLength) codeDelimiterLength = 0;
      index = end - 1;
    }
    if (!codeDelimiterLength) return boundary;
  }
  return -1;
}

function isMarkdownTableSeparator(line: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(line);
}
