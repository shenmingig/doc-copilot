import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// Exercise the real background message handler and provider, with network/Chrome stubs.
const result = await build({
  configFile: false, logLevel: 'silent',
  build: { write: false, target: 'chrome110', minify: false,
    lib: { entry: fileURLToPath(new URL('../src/background/index.ts', import.meta.url)), formats: ['iife'], name: 'testBackground' },
  },
});
const source = (Array.isArray(result) ? result[0] : result).output.find(file => file.type === 'chunk').code;

function harness() {
  let listener;
  let behavior;
  const calls = [], pushes = [], timers = new Set();
  const events = { addListener() {} };
  const config = { name: 'local fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-only', modelId: 'fixture-text', apiProtocol: 'openai-chat-completions', temperature: 0.7, maxTokens: 8192 };
  const settings = { models: { smart: config, image: { ...config, modelId: 'fixture-image' } } };
  const context = vm.createContext({
    console: { log() {}, info() {}, warn() {}, error() {} },
    Response, Request, Headers, URL, AbortController, DOMException, TextDecoder, TextEncoder, Uint8Array,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    setTimeout: (fn, ms) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); return timer; },
    clearTimeout: timer => { timers.delete(timer); clearTimeout(timer); },
    fetch: async (url, init) => { const call = { url: String(url), init }; calls.push(call); return behavior(call); },
    chrome: {
      runtime: { getManifest: () => ({ version: 'fixture' }), onMessage: { addListener: fn => { listener = fn; } }, onInstalled: events, onStartup: events },
      permissions: { onAdded: events, onRemoved: events },
      contextMenus: { onClicked: events }, commands: { onCommand: events },
      storage: { local: { get: async key => ({ [key]: key === 'doc_copilot_settings' ? settings : undefined }), set: async () => {} } },
      tabs: { sendMessage: async (tabId, message, options) => { pushes.push({ tabId, message, options }); } },
    },
  });
  vm.runInContext(source, context);
  return { calls, pushes,
    setBehavior(fn) { behavior = fn; },
    send(type, payload, tabId = 7, frameId = 0) {
      return new Promise(resolve => listener({ type, payload }, { tab: { id: tabId }, frameId }, resolve));
    },
    close() { for (const timer of timers) clearTimeout(timer); },
  };
}

const waitUntil = async predicate => {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(predicate(), 'Expected the request to reach the intended stage');
};
const hanging = signal => new Promise((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});
const completion = text => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }), { headers: { 'content-type': 'application/json' } });
const payload = (requestId, prompt = '配图') => ({ requestId, prompt, selectedText: '技术文档状态方程' });

test('cancelling prompt refinement prevents image generation and allows a new text request', async t => {
  const app = harness(); t.after(() => app.close());
  app.setBehavior(call => hanging(call.init.signal));
  const pending = app.send('SELECTION_ACTION_REQUEST', payload('image-old'));
  await waitUntil(() => app.calls.length === 1);
  const wrongScope = await app.send('SELECTION_ACTION_CANCEL', { requestId: 'image-old' }, 8);
  assert.equal(wrongScope.cancelled, false);
  assert.equal(app.calls[0].init.signal.aborted, false);
  await app.send('SELECTION_ACTION_CANCEL', { requestId: 'image-old' });
  assert.equal((await pending).cancelled, true);
  assert.equal(app.calls[0].init.signal.aborted, true);
  assert.equal(app.calls.length, 1, 'No image endpoint or protocol fallback after cancellation');
  app.setBehavior(() => completion('文本已恢复'));
  const next = await app.send('SELECTION_ACTION_REQUEST', payload('text-new', '优化'));
  assert.equal(next.action, 'edit');
  assert.match(next.result, /文本已恢复/);
  assert.equal(app.pushes.filter(x => x.message.type === 'SELECTION_ACTION_STREAM_END').length, 1);
  assert.equal(app.pushes.at(-1).message.payload.requestId, 'text-new');
  assert.equal(app.pushes.at(-1).options.frameId, 0);
});

test('cancelling image generation interrupts fetch and never enters alternate image transports', async t => {
  const app = harness(); t.after(() => app.close());
  app.setBehavior(call => app.calls.length === 1 ? completion('A technical state diagram with blue arrows') : hanging(call.init.signal));
  const pending = app.send('SELECTION_ACTION_REQUEST', payload('image-generate'), 7, 3);
  await waitUntil(() => app.calls.length === 2);
  assert.ok(app.calls[1].url.endsWith('/images/generations'));
  await app.send('SELECTION_ACTION_CANCEL', { requestId: 'image-generate' }, 7, 3);
  assert.equal((await pending).cancelled, true);
  assert.equal(app.calls[1].init.signal.aborted, true);
  assert.equal(app.calls.length, 2);
  assert.ok(app.pushes.every(x => x.options.frameId === 3));
  assert.equal(app.pushes.some(x => x.message.type === 'SELECTION_ACTION_STREAM_END'), false);
});

test('cancelling image download aborts materialization and suppresses the late image result', async t => {
  const app = harness(); t.after(() => app.close());
  app.setBehavior(call => {
    if (app.calls.length === 1) return completion('A technical state diagram with blue arrows');
    if (app.calls.length === 2) return new Response(JSON.stringify({ data: [{ url: 'https://fixture.invalid/image.png' }] }));
    return hanging(call.init.signal);
  });
  const pending = app.send('SELECTION_ACTION_REQUEST', payload('image-download'));
  await waitUntil(() => app.calls.length === 3);
  await app.send('SELECTION_ACTION_CANCEL', { requestId: 'image-download' });
  assert.equal((await pending).cancelled, true);
  assert.equal(app.calls[2].init.signal.aborted, true);
  assert.equal(app.calls.length, 3);
  assert.equal(app.pushes.some(x => x.message.type === 'SELECTION_ACTION_STREAM_END'), false);
});

test('cancelling retry backoff prevents a second network attempt', async t => {
  const app = harness(); t.after(() => app.close());
  app.setBehavior(() => new Response('temporarily unavailable', { status: 503 }));
  const pending = app.send('SELECTION_ACTION_REQUEST', payload('backoff', '优化'));
  await waitUntil(() => app.calls.length === 1);
  await app.send('SELECTION_ACTION_CANCEL', { requestId: 'backoff' });
  assert.equal((await pending).cancelled, true);
  assert.equal(app.calls.length, 1);
});
