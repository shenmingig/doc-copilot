import assert from 'node:assert/strict';
import test from 'node:test';
import { isDirectIllustrationRequest, isDocumentPlanRequest } from './document-plan.ts';

test('recognizes direct drawing requests without treating image questions as generation', () => {
  assert.equal(isDirectIllustrationRequest('这个过程可以画图给我一下吗？这个例子'), true);
  assert.equal(isDirectIllustrationRequest('请调用画图接口生成这个图'), true);
  assert.equal(isDirectIllustrationRequest('画一个图给我看看'), true);
  assert.equal(isDirectIllustrationRequest('这张图片里画的是什么？'), false);
  assert.equal(isDocumentPlanRequest('请给这篇文章配图并调整结构'), true);
});
