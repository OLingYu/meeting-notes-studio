import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../../web/markdown.js';

test('转义 HTML，防止注入', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;/);
});

test('标题、列表、粗体与行内代码', () => {
  const html = renderMarkdown('# 会议纪要\n\n## 结论\n\n- 第一条\n- 第二条\n\n**重点** 与 `code`');
  assert.match(html, /<h1>会议纪要<\/h1>/);
  assert.match(html, /<h2>结论<\/h2>/);
  assert.match(html, /<ul><li>第一条<\/li><li>第二条<\/li><\/ul>/);
  assert.match(html, /<strong>重点<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
});

test('表格与引用', () => {
  const html = renderMarkdown('| 事项 | 负责人 |\n| --- | --- |\n| 同步 | 张三 |\n\n> 提示');
  assert.match(html, /<table>/);
  assert.match(html, /<th>事项<\/th>/);
  assert.match(html, /<td>张三<\/td>/);
  assert.match(html, /<blockquote>提示<\/blockquote>/);
});

test('代码块里的内容不被当作 Markdown', () => {
  const html = renderMarkdown('```\n# 不是标题\n**不加粗**\n```');
  assert.match(html, /<pre><code>/);
  assert.doesNotMatch(html, /<h1>/);
  assert.match(html, /\*\*不加粗\*\*/);
});

test('只允许 http(s) 链接', () => {
  const safe = renderMarkdown('[示例](https://example.com/a)');
  assert.match(safe, /<a href="https:\/\/example\.com\/a" target="_blank"/);
  const unsafe = renderMarkdown('[坏链接](javascript:alert(1))');
  assert.doesNotMatch(unsafe, /<a /);
  assert.match(unsafe, /\[坏链接\]/);
});

test('空文档也能渲染', () => {
  assert.match(renderMarkdown(''), /空文档/);
  assert.match(renderMarkdown('   \n\n  '), /空文档/);
});
