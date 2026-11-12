// ============================================================
// Autocomplete Engine
// ============================================================

import { DocumentContext, AutocompleteResult, ChatMessage } from '../../shared/types/index';
import { modelProvider } from '../models/provider';
import { generateId, truncateText, detectLanguage } from '../../shared/utils/index';
import { settingsStorage } from '../../shared/storage/settings';

interface CacheEntry {
  key: string;
  result: AutocompleteResult;
  timestamp: number;
}

export class AutocompleteEngine {
  private cache: CacheEntry[] = [];
  private readonly maxCacheSize = 50;
  private readonly cacheExpiry = 60_000; // 60 seconds

  /**
   * Generate autocomplete suggestion for the current cursor position.
   * Uses the single configured text model.
   */
  async suggest(context: DocumentContext): Promise<AutocompleteResult | null> {
    const settings = await settingsStorage.get();
    if (!settings.features.autocomplete) return null;

    // Check cache first
    const cacheKey = this.getCacheKey(context);
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    // Build prompt
    const messages = this.buildPrompt(context);

    try {
      let completionText = '';

      // Use streaming for real-time feel
      completionText = await modelProvider.streamToString('smart', messages, {
        max_tokens: 48,
        temperature: 0.3,
        stop: ['\n\n', '。\n', '.\n'], // Stop at paragraph boundaries
      });

      const cleanedText = this.cleanCompletion(completionText, context);
      if (!cleanedText) return null;

      const result: AutocompleteResult = {
        text: cleanedText,
        insertPosition: context.cursorPosition,
        confidence: 0.8,
        model: 'smart',
      };

      // Cache the result
      this.addToCache(cacheKey, result);

      return result;
    } catch (error) {
      if ((error as Error).name === 'AbortError') return null;
      console.error('[DocCopilot] Autocomplete error:', error);
      return null;
    }
  }

  /** Cancel any ongoing autocomplete request */
  cancel(): void {
    // Autocomplete shares the Smart model with chat/review, so do not abort the
    // global Smart request pool here. Callers discard stale results by sequence.
  }

  /** Clear the cache */
  clearCache(): void {
    this.cache = [];
  }

  private buildPrompt(context: DocumentContext): ChatMessage[] {
    const lang = context.language || detectLanguage(context.textBefore);
    const isChineseContext = lang === 'zh';
    const cleanTextBefore = this.cleanEditorArtifacts(context.textBefore);
    const cleanTextAfter = this.cleanEditorArtifacts(context.textAfter);

    const systemPrompt = isChineseContext
      ? `你是一个文档写作助手。根据上下文续写文本。
规则：
- 只输出续写的纯文本内容，不要重复已有文本
- 保持与上下文一致的风格和语气
- 只补短语或半句，中文通常 10-30 个字，最多不超过 1 句话
- 不要一次性续写完整段落
- 如果当前行为空，输出可以直接放在光标处的下一句开头
- 如果光标所在行不是列表项，绝对不要输出列表、标题、引用、代码块或 Markdown 项目符号
- 不要跳到上下文中其它主题，不要引入与当前半句无关的实体
- 绝对不要输出 JSON、代码、标签或任何结构化格式
- 绝对不要添加任何解释、标题、元信息`
      : `You are a document writing assistant. Continue the text based on context.
Rules:
- Output ONLY the plain text continuation, do not repeat existing text
- Maintain consistent style and tone with the context
- Complete with a short phrase or clause, usually under 20 words and never more than 1 sentence
- Do not continue with a full paragraph
- If the current line is empty, output a natural sentence starter that can be inserted directly at the cursor
- If the current line is not a list item, NEVER output lists, headings, quotes, code blocks, or Markdown bullets
- Do not jump to unrelated entities from the surrounding context
- NEVER output JSON, code, tags, or any structured format
- NEVER add any explanations, headings, or meta-information`;

    const currentLine = cleanTextBefore.split('\n').pop() ?? '';
    const beforeCurrentLine = cleanTextBefore.slice(0, cleanTextBefore.length - currentLine.length);
    const textBefore = truncateText(beforeCurrentLine, 500, true);
    const textAfter = truncateText(cleanTextAfter, 200);
    const isEmptyCurrentLine = currentLine.trim().length === 0;

    let userContent = `[Document context]\nBefore current line:\n"""${textBefore}"""\n\n`;
    userContent += isEmptyCurrentLine
      ? 'Current cursor line is empty. Suggest the next short sentence or phrase to start here.\n'
      : `Current incomplete line:\n"""${currentLine}"""\n`;

    if (textAfter.trim()) {
      userContent += `\nAfter cursor:\n"""${textAfter}"""\n`;
    }

    userContent += isEmptyCurrentLine
      ? '\nOutput only the text to insert at the cursor. Do not include a heading, bullet, or explanation unless the surrounding context is already a list.'
      : `\nContinue immediately after the current incomplete line. Output only the missing continuation after the cursor, so that this line reads coherently as: "${currentLine}[your continuation]".`;

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ];
  }

  private cleanCompletion(raw: string, context: DocumentContext): string | null {
    let text = this.cleanEditorArtifacts(raw)
      .replace(/\r\n/g, '\n')
      .replace(/^\s*(?:续写|补全|建议|completion)\s*[:：]\s*/i, '')
      .trimStart();
    if (!text.trim()) return null;

    const currentLine = this.cleanEditorArtifacts(context.textBefore).split('\n').pop() ?? '';
    const isListLine = /^\s*(?:[-*+•·‣◦]\s+|\d+[.)]\s+)/.test(currentLine);
    const isEmptyListMarker = /^\s*(?:[-*+•·‣◦]\s*|\d+[.)]\s*)$/.test(currentLine);

    if (!isEmptyListMarker) {
      // Do not show structurally unrelated Markdown as inline sentence completion.
      if (/^\s*(?:[-*+•·‣◦]\s+|\d+[.)]\s+|#{1,6}\s+|>\s+)/.test(text)) {
        return null;
      }
    }

    if (!isListLine) {
      text = text.split(/\n{2,}/)[0].replace(/\n+/g, ' ');
    }

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
      text = text.trimEnd();
    }

    const recent = context.textBefore.slice(-80);
    const head = text.slice(0, Math.min(20, text.length));
    if (head && recent.endsWith(head)) return null;

    return text.trimEnd() || null;
  }

  private cleanEditorArtifacts(text: string): string {
    return text.replace(/[\u200B-\u200D\uFEFF]/g, '');
  }

  private getCacheKey(context: DocumentContext): string {
    // Key = cursor offset + last 100 chars before cursor.
    // After accepting a completion the cursor offset advances, so the key
    // can never collide with the pre-accept entry — no extra cache-clear
    // or suppression delay needed.
    const before = context.textBefore.slice(-100);
    return `${context.cursorPosition.offset}:${before}`;
  }

  private getFromCache(key: string): AutocompleteResult | null {
    const now = Date.now();
    const entry = this.cache.find(
      e => e.key === key && now - e.timestamp < this.cacheExpiry,
    );
    return entry?.result ?? null;
  }

  private addToCache(key: string, result: AutocompleteResult): void {
    // Remove expired entries
    const now = Date.now();
    this.cache = this.cache.filter(e => now - e.timestamp < this.cacheExpiry);

    // Evict oldest if full
    if (this.cache.length >= this.maxCacheSize) {
      this.cache.shift();
    }

    this.cache.push({ key, result, timestamp: now });
  }
}

export const autocompleteEngine = new AutocompleteEngine();
