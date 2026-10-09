'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtml, safeFileName, renderExportHtml } = require('../export');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('export is one HTML file with title, times, key points, notes and embedded screenshot', () => {
  const html = renderExportHtml({
    title: 'Python Lists',
    createdAt: Date.UTC(2026, 9, 9, 10, 0),
    updatedAt: Date.UTC(2026, 9, 9, 11, 0),
    points: ['Lists are ordered', 'Lists are mutable'],
    raw: 'Definitions\n- A list is a collection.\n\nCode\n```\nfruits = [1, 2]\n```',
    shot: PNG,
  });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Python Lists<\/title>/);
  assert.match(html, /<h1>Python Lists<\/h1>/);
  assert.match(html, /Created .*2026.* · Updated /);
  assert.match(html, /<li>Lists are ordered<\/li>\s*<li>Lists are mutable<\/li>/);
  assert.match(html, /<h3>Definitions<\/h3>\s*<ul>\s*<li>A list is a collection\.<\/li>/);
  assert.match(html, /<h3>Code<\/h3>\s*<pre><code>fruits = \[1, 2\]<\/code><\/pre>/);
  assert.ok(!html.includes('```'));
  assert.ok(html.includes(`<img src="${PNG}"`));
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; img-src data:/);
  assert.ok(!/<script/i.test(html));
});

test('export escapes note content so it cannot inject markup', () => {
  const html = renderExportHtml({
    title: '<script>alert(1)</script>',
    createdAt: 1,
    points: ['<img src=x onerror=alert(1)>'],
    raw: '"quoted" & <b>bold</b>',
    shot: 'javascript:alert(1)',
  });
  assert.ok(!html.includes('<script>alert'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&quot;quoted&quot; &amp; &lt;b&gt;bold&lt;/b&gt;'));
  assert.ok(!html.includes('javascript:'), 'non-PNG screenshot data is dropped');
  assert.equal(escapeHtml(`a'b`), 'a&#39;b');
});

test('export without screenshot or points still produces a clean file', () => {
  const html = renderExportHtml({ title: 'Plain', createdAt: 1, updatedAt: 1, points: [], raw: '', shot: null });
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('Key points'));
  assert.ok(!html.includes('Updated'));
});

test('safeFileName removes invalid characters and reserved names', () => {
  assert.equal(safeFileName('POV: Your Heart Belongs to Another Era'), 'POV Your Heart Belongs to Another Era');
  assert.equal(safeFileName('a/b\\c*d?"e<f>g|h'), 'a b c d e f g h');
  assert.equal(safeFileName('../../etc/passwd'), 'etc passwd');
  assert.equal(safeFileName('  ...  '), 'Notely note');
  assert.equal(safeFileName('CON'), 'CON note');
  assert.ok(safeFileName('word '.repeat(40)).length <= 80);
});
