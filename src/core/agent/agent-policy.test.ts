import assert from 'node:assert/strict';
import test from 'node:test';
import { isDocumentEditRequest } from './agent-policy.ts';

test('recognizes edit requests for candidate text while edit tools are disabled', () => {
  assert.equal(isDocumentEditRequest('请把这一段改写得更清楚'), true);
  assert.equal(isDocumentEditRequest('第五节之后可以按照前四节的风格重新写一下吗'), true);
  assert.equal(isDocumentEditRequest('按照前四节风格重写第五节'), true);
  assert.equal(isDocumentEditRequest('总结一下这篇文章'), false);
});
