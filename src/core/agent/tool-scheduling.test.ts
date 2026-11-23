import assert from 'node:assert/strict';
import test from 'node:test';
import { partitionToolCalls } from './tool-scheduling.ts';

test('only read-only document searches are parallelized; actions keep request order', () => {
  const calls = [
    { id: '1', function: { name: 'search_document' } },
    { id: '2', function: { name: 'replace_text' } },
    { id: '3', function: { name: 'search_document' } },
    { id: '4', function: { name: 'generate_image' } },
    { id: '5', function: { name: 'insert_at_cursor' } },
  ];

  const groups = partitionToolCalls(calls);
  assert.deepEqual(groups.parallel.map(call => call.id), ['1', '3']);
  assert.deepEqual(groups.serial.map(call => call.id), ['2', '4', '5']);
});
