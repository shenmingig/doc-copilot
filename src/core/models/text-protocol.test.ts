import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isAnthropicMessagesOnlyEndpoint,
  isClaudeModel,
  prefersAnthropicMessages,
  resolveTextProtocolRouting,
} from './text-protocol.ts';

test('recognizes native Anthropic and explicit Messages endpoints as Anthropic-only', () => {
  assert.equal(isAnthropicMessagesOnlyEndpoint('https://api.anthropic.com'), true);
  assert.equal(isAnthropicMessagesOnlyEndpoint('https://gateway.example.com/v1/messages'), true);
});

test('keeps Claude model requests compatible with OpenAI gateways after Messages endpoint misses', () => {
  assert.equal(isClaudeModel('claude-opus-5-5'), true);
  assert.equal(isAnthropicMessagesOnlyEndpoint('https://gateway.example.com/v1'), false);
  assert.equal(prefersAnthropicMessages('claude-opus-5-5', 'https://gateway.example.com/v1'), true);
  assert.equal(prefersAnthropicMessages('claude-opus-5-5', 'https://gateway.example.com/v1/chat/completions'), false);
  assert.equal(prefersAnthropicMessages('gpt-4.1', 'https://gateway.example.com/v1/messages'), true);
});

test('manual API protocol selection overrides model-name heuristics', () => {
  assert.deepEqual(resolveTextProtocolRouting('claude-opus-5-5', 'https://gateway.example/v1', 'openai-chat-completions'), {
    protocol: 'openai-chat-completions',
    locked: true,
    anthropicOnly: false,
    openAiV1Only: true,
    preferMessages: false,
    responsesOnly: false,
  });
  assert.equal(resolveTextProtocolRouting('claude-opus-5-5', 'https://gateway.example/v1', 'openai-responses').responsesOnly, true);
  assert.equal(resolveTextProtocolRouting('gpt-4.1', 'https://gateway.example/v1', 'anthropic-messages').preferMessages, true);
  assert.equal(resolveTextProtocolRouting('claude-opus-5-5', 'https://api.anthropic.com', 'auto').anthropicOnly, true);
});

test('manual Responses selection disables chat and Messages fallbacks', () => {
  const route = resolveTextProtocolRouting('claude-opus-5-5', 'https://gateway.example/v1', 'openai-responses');
  assert.equal(route.locked, true);
  assert.equal(route.protocol, 'openai-responses');
  assert.equal(route.openAiV1Only, true);
  assert.equal(route.responsesOnly, true);
  assert.equal(route.preferMessages, false);
});
