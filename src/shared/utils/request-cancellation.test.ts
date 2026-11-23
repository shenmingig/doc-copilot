import assert from 'node:assert/strict';
import test from 'node:test';
import { ActiveRequest, ScopedRequestRegistry, abortableDelay, linkRequestAbort } from './request-cancellation.ts';

test('late chunks and terminal results cannot replace a newer request', () => {
  const active = new ActiveRequest();
  active.start('old');
  assert.equal(active.clear(), 'old');
  assert.equal(active.matches('old'), false);
  active.start('new');
  assert.equal(active.matches('old'), false);
  assert.equal(active.matches(undefined), false);
  assert.equal(active.matches('new'), true);
});

test('cancel only aborts the matching tab/frame operation and stale cleanup preserves the new run', () => {
  const registry = new ScopedRequestRegistry();
  const old = registry.start('tab1/frame0', 'old');
  const other = registry.start('tab2/frame0', 'other');
  assert.equal(registry.cancel('tab2/frame0', 'old'), false);
  assert.equal(registry.cancel('tab1/frame0', 'old'), true);
  assert.equal(old.signal.aborted, true);
  assert.equal(other.signal.aborted, false);
  const next = registry.start('tab1/frame0', 'next');
  registry.finish('tab1/frame0', old);
  assert.equal(registry.cancel('tab1/frame0', 'old'), false);
  assert.equal(next.signal.aborted, false);
  assert.equal(registry.cancel('tab1/frame0', 'next'), true);
});

test('abort reaches the linked fetch controller and interrupts retry backoff', async () => {
  const parent = new AbortController();
  const transport = new AbortController();
  const unlink = linkRequestAbort(transport, parent.signal);
  const waiting = abortableDelay(60000, transport.signal);
  parent.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(transport.signal.aborted, true);
  unlink();
});

test('pre-cancelled requests abort immediately and removed links do not affect other operations', async () => {
  const parent = new AbortController();
  parent.abort();
  const transport = new AbortController();
  linkRequestAbort(transport, parent.signal)();
  assert.equal(transport.signal.aborted, true);
  await assert.rejects(abortableDelay(1000, parent.signal), { name: 'AbortError' });
  const activeParent = new AbortController();
  const done = new AbortController();
  linkRequestAbort(done, activeParent.signal)();
  activeParent.abort();
  assert.equal(done.signal.aborted, false);
});
