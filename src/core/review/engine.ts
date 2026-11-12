// ============================================================
// Review Engine - Document review with accept/reject points
// ============================================================

import {
  DocumentContext,
  ReviewPoint,
  ReviewSession,
  ReviewCategory,
  ChatMessage,
} from '../../shared/types/index';
import { modelProvider } from '../models/provider';
import { generateId, chatContentToText } from '../../shared/utils/index';
import { EventEmitter } from '../../shared/utils/index';

export interface ReviewEvents {
  'session:start': ReviewSession;
  'session:end': ReviewSession;
  'point:focus': { session: ReviewSession; point: ReviewPoint };
  'point:accept': { session: ReviewSession; point: ReviewPoint };
  'point:reject': { session: ReviewSession; point: ReviewPoint };
  'all:accept': ReviewSession;
  'all:reject': ReviewSession;
}

export class ReviewEngine extends EventEmitter<ReviewEvents> {
  private currentSession: ReviewSession | null = null;

  get session(): ReviewSession | null {
    return this.currentSession;
  }

  get currentPoint(): ReviewPoint | null {
    if (!this.currentSession) return null;
    return this.currentSession.points[this.currentSession.currentIndex] ?? null;
  }

  get pendingPoints(): ReviewPoint[] {
    return this.currentSession?.points.filter(p => p.status === 'pending') ?? [];
  }

  /**
   * Analyze document and create review session with suggestions.
   * Uses the shared text model for quality corrections.
   */
  async analyze(
    context: DocumentContext,
    mode: 'correct' | 'rewrite' | 'polish' = 'correct',
  ): Promise<ReviewSession> {
    const text = context.selectedText || context.fullText || context.textBefore + context.textAfter;
    const messages = this.buildAnalysisPrompt(text, mode, context.language);

    const response = await modelProvider.complete('smart', messages, {
      temperature: 0.4,
      max_tokens: 8192,
    });

    const content = chatContentToText(response.choices[0]?.message?.content) || '[]';
    const points = this.parseReviewPoints(content, text);

    this.currentSession = {
      id: generateId(),
      points,
      currentIndex: 0,
      startedAt: Date.now(),
    };

    this.emit('session:start', this.currentSession);
    if (points.length > 0) {
      this.emit('point:focus', {
        session: this.currentSession,
        point: points[0],
      });
    }

    return this.currentSession;
  }

  /** Accept the current review point */
  acceptCurrent(): ReviewPoint | null {
    if (!this.currentSession) return null;
    const point = this.currentPoint;
    if (!point || point.status !== 'pending') return null;

    point.status = 'accepted';
    this.emit('point:accept', { session: this.currentSession, point });
    this.moveToNextPending();
    return point;
  }

  /** Reject the current review point */
  rejectCurrent(): ReviewPoint | null {
    if (!this.currentSession) return null;
    const point = this.currentPoint;
    if (!point || point.status !== 'pending') return null;

    point.status = 'rejected';
    this.emit('point:reject', { session: this.currentSession, point });
    this.moveToNextPending();
    return point;
  }

  /** Move to next review point */
  next(): ReviewPoint | null {
    if (!this.currentSession) return null;
    const { points } = this.currentSession;
    let nextIdx = this.currentSession.currentIndex + 1;

    while (nextIdx < points.length && points[nextIdx].status !== 'pending') {
      nextIdx++;
    }

    if (nextIdx < points.length) {
      this.currentSession.currentIndex = nextIdx;
      const point = points[nextIdx];
      this.emit('point:focus', { session: this.currentSession, point });
      return point;
    }
    return null;
  }

  /** Move to previous review point */
  previous(): ReviewPoint | null {
    if (!this.currentSession) return null;
    const { points } = this.currentSession;
    let prevIdx = this.currentSession.currentIndex - 1;

    while (prevIdx >= 0 && points[prevIdx].status !== 'pending') {
      prevIdx--;
    }

    if (prevIdx >= 0) {
      this.currentSession.currentIndex = prevIdx;
      const point = points[prevIdx];
      this.emit('point:focus', { session: this.currentSession, point });
      return point;
    }
    return null;
  }

  /** Accept all pending review points */
  acceptAll(): void {
    if (!this.currentSession) return;
    this.currentSession.points.forEach(p => {
      if (p.status === 'pending') p.status = 'accepted';
    });
    this.emit('all:accept', this.currentSession);
    this.endSession();
  }

  /** Reject all pending review points */
  rejectAll(): void {
    if (!this.currentSession) return;
    this.currentSession.points.forEach(p => {
      if (p.status === 'pending') p.status = 'rejected';
    });
    this.emit('all:reject', this.currentSession);
    this.endSession();
  }

  /** End current review session */
  endSession(): void {
    if (this.currentSession) {
      this.emit('session:end', this.currentSession);
      this.currentSession = null;
    }
  }

  private moveToNextPending(): void {
    if (!this.currentSession) return;
    const pending = this.pendingPoints;
    if (pending.length === 0) {
      this.endSession();
      return;
    }
    // Find next pending from current index
    const next = this.next();
    if (!next) {
      // Wrap around to first pending
      const firstPending = this.currentSession.points.findIndex(p => p.status === 'pending');
      if (firstPending >= 0) {
        this.currentSession.currentIndex = firstPending;
        this.emit('point:focus', {
          session: this.currentSession,
          point: this.currentSession.points[firstPending],
        });
      }
    }
  }

  private buildAnalysisPrompt(
    text: string,
    mode: string,
    language: string,
  ): ChatMessage[] {
    const isZh = language === 'zh';

    const modeDescriptions: Record<string, string> = {
      correct: isZh
        ? '检查语法错误、拼写错误、标点符号问题'
        : 'Check grammar errors, spelling mistakes, punctuation issues',
      rewrite: isZh
        ? '改善文档结构、逻辑和表达方式'
        : 'Improve document structure, logic, and expression',
      polish: isZh
        ? '润色文字，提升可读性和专业性'
        : 'Polish text, improve readability and professionalism',
    };

    const systemPrompt = isZh
      ? `你是一个专业的文档审稿助手。任务：${modeDescriptions[mode]}

输出格式为 JSON 数组，每个元素包含：
- "original": 原文片段（精确匹配）
- "suggested": 建议修改后的文本
- "reason": 修改理由（简短）
- "category": 分类 (grammar|spelling|punctuation|style|clarity|structure|word-choice|redundancy|other)

只输出 JSON 数组，不要其他内容。如果没有需要修改的地方，输出空数组 []。`
      : `You are a professional document review assistant. Task: ${modeDescriptions[mode]}

Output format is a JSON array, each element contains:
- "original": original text fragment (exact match)
- "suggested": suggested revised text
- "reason": reason for change (brief)
- "category": category (grammar|spelling|punctuation|style|clarity|structure|word-choice|redundancy|other)

Only output the JSON array, nothing else. If no changes needed, output empty array [].`;

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Review this text:\n\n${text}` },
    ];
  }

  private parseReviewPoints(
    content: string,
    fullText: string,
  ): ReviewPoint[] {
    try {
      // Extract JSON from response (might be wrapped in markdown code block)
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const items = JSON.parse(jsonMatch[0]) as Array<{
        original: string;
        suggested: string;
        reason: string;
        category: string;
      }>;

      const results = items
        .filter(item => item.original && item.suggested && item.original !== item.suggested)
        .map(item => {
          const startOffset = fullText.indexOf(item.original);
          if (startOffset === -1) return null;

          const endOffset = startOffset + item.original.length;

          const point: ReviewPoint = {
            id: generateId(),
            originalRange: {
              start: this.offsetToPosition(fullText, startOffset),
              end: this.offsetToPosition(fullText, endOffset),
            },
            originalText: item.original,
            suggestedText: item.suggested,
            reason: item.reason,
            category: (item.category || 'other') as ReviewCategory,
            status: 'pending',
          };
          return point;
        })
        .filter((p): p is ReviewPoint => p !== null);
      return results;
    } catch (error) {
      console.error('[DocCopilot] Failed to parse review points:', error);
      return [];
    }
  }

  private offsetToPosition(text: string, offset: number): { line: number; character: number; offset: number } {
    const lines = text.slice(0, offset).split('\n');
    return {
      line: lines.length - 1,
      character: lines[lines.length - 1].length,
      offset,
    };
  }
}

export const reviewEngine = new ReviewEngine();
