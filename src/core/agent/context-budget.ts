import type { ChatMessage } from '../../shared/types/index';

export const AUTO_COMPACT_THRESHOLD = 0.85;

export function estimateChatMessageTokens(messages: ChatMessage[]): number {
  let characters = 0;
  let imageCount = 0;

  for (const message of messages) {
    if (typeof message.content === 'string') {
      characters += message.content.length;
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'image_url') imageCount++;
        else characters += part.text?.length || 0;
      }
    }
  }

  return Math.ceil(characters / 2) + imageCount * 1500;
}

export function shouldCompactChatMessages(messages: ChatMessage[], contextWindow: number): boolean {
  return estimateChatMessageTokens(messages) >= Math.max(1000, contextWindow) * AUTO_COMPACT_THRESHOLD;
}

export function compactDocumentBudget(maxChars: number, contextWindow: number): number {
  return Math.min(
    Math.max(1000, maxChars),
    80000,
    Math.max(4000, Math.floor(Math.max(1000, contextWindow) * 0.35)),
  );
}
