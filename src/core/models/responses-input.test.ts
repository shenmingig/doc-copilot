import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage } from '../../shared/types/index';
import { toResponsesInput } from './responses-input.ts';

test('serializes assistant tool calls and tool results as native Responses items', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'please search' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search_document', arguments: '{"query":"attention"}' } }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'Found one passage.' },
  ];

  assert.deepEqual(toResponsesInput(messages), [
    { role: 'system', content: [{ type: 'input_text', text: 'system prompt' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'please search' }] },
    { type: 'function_call', call_id: 'call-1', name: 'search_document', arguments: '{"query":"attention"}' },
    { type: 'function_call_output', call_id: 'call-1', output: 'Found one passage.' },
  ]);
});

test('serializes multimodal user messages as Responses input text and image items', () => {
  const input = toResponsesInput([{
    role: 'user',
    content: [
      { type: 'text', text: 'What is in this picture?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc', detail: 'high' } },
    ],
  }]);

  assert.deepEqual(input, [{
    role: 'user',
    content: [
      { type: 'input_text', text: 'What is in this picture?' },
      { type: 'input_image', image_url: 'data:image/png;base64,abc', detail: 'high' },
    ],
  }]);
});
