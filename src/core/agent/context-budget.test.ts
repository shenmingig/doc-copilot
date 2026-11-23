import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage } from '../../shared/types/index';
import {
  AUTO_COMPACT_THRESHOLD,
  compactDocumentBudget,
  estimateChatMessageTokens,
  shouldCompactChatMessages,
} from './context-budget.ts';

test('estimates text and image tokens without counting base64 payload size', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'a'.repeat(2000) },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'b'.repeat(1000) },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${'x'.repeat(100000)}` } },
      ],
    },
  ];

  assert.equal(estimateChatMessageTokens(messages), 3000);
});

test('compacts at the configured context threshold', () => {
  const limit = 10000;
  const below: ChatMessage[] = [{ role: 'user', content: 'x'.repeat(16990) }];
  const above: ChatMessage[] = [{ role: 'user', content: 'x'.repeat(17000) }];

  assert.equal(shouldCompactChatMessages(below, limit), false);
  assert.equal(shouldCompactChatMessages(above, limit), true);
  assert.equal(AUTO_COMPACT_THRESHOLD, 0.85);
});

test('reserves a smaller bounded document budget for compact requests', () => {
  assert.equal(compactDocumentBudget(800000, 32000), 11200);
  assert.equal(compactDocumentBudget(20000, 1000000), 20000);
});
