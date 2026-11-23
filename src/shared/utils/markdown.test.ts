import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown } from './index.ts';

test('renders the screenshot state equation and inline LaTeX as native math', () => {
  const html = renderMarkdown(String.raw`其核心状态更新可以简化表示为：

\[
h_t=\bar A_t h_{t-1}+\bar B_t x_t,\qquad y_t=C_t h_t
\]

其中，\(h_{t-1}\) 是此前累积的状态，\(x_t\) 是当前输入，\(h_t\) 是更新后的状态。`);
  assert.equal((html.match(/<math[ >]/g) || []).length, 4);
  assert.match(html, /class="dc-math-block"/);
  assert.match(html, /display="block"/);
  assert.match(html, /<msub>/);
  assert.match(html, /<mover/);
  assert.match(html, /class="dc-math-inline"/);
  assert.doesNotMatch(html, /dc-math-fallback|\u0000DC_/);
});

test('supports dollar math, matrices and comparisons without corrupting Markdown', () => {
  const html = renderMarkdown(String.raw`## 公式
**概率**：$p(x)=\frac{1}{2}$。
$$\begin{pmatrix}a & b \\ c & d\end{pmatrix}$$
\[a < b \quad x > 0\]`);
  assert.equal((html.match(/<math[ >]/g) || []).length, 3);
  assert.ok(html.includes('<strong>概率</strong>'));
  assert.match(html, /<mfrac>/);
  assert.match(html, /<mtable/);
  assert.doesNotMatch(html, /dc-math-fallback|<table class="dc-table"/);
});

test('leaves math code examples and incomplete code fences literal', () => {
  const html = renderMarkdown([
    '代码 `' + String.raw`\(x_t\)` + '` 和 `$x$`。',
    '```latex',
    String.raw`\[x_t=\bar A_t\]`,
    '```',
    '~~~latex',
    '$$x^2$$',
  ].join('\n'));
  assert.doesNotMatch(html, /<math[ >]/);
  assert.equal((html.match(/dc-code-block/g) || []).length, 2);
  assert.equal((html.match(/dc-inline-code/g) || []).length, 2);
});

test('preserves prices escaped dollars and URLs with dollar signs', () => {
  const source = String.raw`价格 $20 和 $30，\$5；链接 [价格](https://example.com/$20$30) 与 https://example.com/$40$50`;
  const html = renderMarkdown(source);
  assert.doesNotMatch(html, /<math[ >]/);
  assert.match(html, /价格 \$20 和 \$30/);
  assert.ok(html.includes('href="https://example.com/$20$30"'));
});

test('incomplete and unsupported equations stay readable without breaking following text', () => {
  for (const source of [String.raw`前文 \(x_`, String.raw`前文 \[x_`, String.raw`前文 \(\notARealCommand{x}\) 后文`]) {
    const html = renderMarkdown(source);
    assert.match(html, /前文/);
    assert.doesNotMatch(html, /undefined|\u0000DC_/);
  }
  assert.match(renderMarkdown(String.raw`\(\notARealCommand{x}\) 后文`), /后文/);
});

test('math cannot inject scripts attributes or trusted HTML commands', () => {
  const html = renderMarkdown(String.raw`<img src=x onerror=alert(1)>
\(\href{javascript:alert(1)}{x}\)
\(\htmlClass{dangerous}{x}\)`);
  assert.doesNotMatch(html, /<script|<img|href="javascript:|class="dangerous"|<[^>]*onerror=/i);
  assert.match(html, /&lt;img/);
});

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
