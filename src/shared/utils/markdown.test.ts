import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown } from './index.ts';

test('renders a heading that follows paragraph text on the same line as a block', () => {
  const html = renderMarkdown('前面先讲完。 ### 3.4 算一下 10 万 token');

  assert.match(html, /<p class="dc-p">前面先讲完。<\/p>/);
  assert.match(html, /<h3 class="dc-h3">3\.4 算一下 10 万 token<\/h3>/);
  assert.doesNotMatch(html, /前面先讲完。<br>.*###/);
});

test('does not split heading-like text inside inline code', () => {
  const html = renderMarkdown('Use `### not a heading` as a literal token.');

  assert.match(html, /Use <code class="dc-inline-code">### not a heading<\/code> as a literal token\./);
  assert.doesNotMatch(html, /<h3 class="dc-h3">not a heading<\/h3>/);
});

test('splits merged bold dash-list items into separate list rows', () => {
  const html = renderMarkdown([
    '我可以帮你做这些事：',
    '- **解释概念：** 说明 SWA、KV 和 CED。 - **核对内容：** 对比图和正文。 - **算显存账：** 估算 KV 大小。 - **总结或生成配图：** 归纳本节。',
  ].join('\n'));

  assert.equal((html.match(/<li class="dc-li">/g) || []).length, 4);
  assert.match(html, /<strong>核对内容：<\/strong>/);
  assert.match(html, /<strong>总结或生成配图：<\/strong>/);
});

test('does not split dash-list markers inside inline code', () => {
  const html = renderMarkdown('文档里的示例是 ` - **literal**`。');

  assert.equal((html.match(/<li class="dc-li">/g) || []).length, 0);
  assert.match(html, /<code class="dc-inline-code"> - \*\*literal\*\*<\/code>/);
});

test('renders a Markdown table that starts after prose on the same line', () => {
  const html = renderMarkdown([
    '下面是参数。 | 方案 | 数量 |',
    '|---|---|',
    '| 模型 A | 128 |',
    '| 模型 B | 256 |',
  ].join('\n'));

  assert.match(html, /<p class="dc-p">下面是参数。<\/p>/);
  assert.match(html, /<table class="dc-table"><thead><tr>/);
  assert.match(html, /<th class="dc-th"[^>]*>方案<\/th>/);
  assert.match(html, /<td class="dc-td"[^>]*>256<\/td>/);
});

test('preserves code pipe characters while splitting a following table', () => {
  const html = renderMarkdown([
    '代码 `left | right` | 方案 | 数量 |',
    '|---|---|',
    '| 模型 A | 128 |',
  ].join('\n'));

  assert.match(html, /<code class="dc-inline-code">left \| right<\/code>/);
  assert.match(html, /<th class="dc-th"[^>]*>方案<\/th>/);
});
