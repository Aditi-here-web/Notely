'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  escapeHtml, safeFileName, renderExportHtml, renderExportText, renderExportMarkdown, pngBuffer,
} = require('../export');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('export is one HTML file with title, times, key points, notes and embedded screenshot', () => {
  const html = renderExportHtml({
    title: 'Python Lists',
    createdAt: Date.UTC(2026, 9, 9, 10, 0),
    updatedAt: Date.UTC(2026, 9, 9, 11, 0),
    points: ['Lists are ordered', 'Lists are mutable'],
    raw: 'Definitions\n- A list is a collection.\n\nCode\n```\nfruits = [1, 2]\n```',
    shot: PNG,
  }, { includeShot: true });
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

test('HTML and Markdown omit the screenshot unless the user opts in', () => {
  const note = { title: 'Python Lists', createdAt: 1, points: ['Lists are ordered'], raw: 'A list is a collection.', shot: PNG };
  const htmlOff = renderExportHtml(note);
  assert.ok(!htmlOff.includes('<img'), 'HTML default is text only');
  assert.ok(!htmlOff.includes(PNG.slice(-24)));
  const htmlOn = renderExportHtml(note, { includeShot: true });
  assert.ok(htmlOn.includes(`<img src="${PNG}"`));
  const mdOff = renderExportMarkdown(note);
  assert.ok(!mdOff.includes('data:image/png'));
  assert.match(mdOff, /^# Python Lists\n/);
  assert.match(mdOff, /- Lists are ordered/);
  const mdOn = renderExportMarkdown(note, { includeShot: true });
  assert.ok(mdOn.includes(`![Captured screen](${PNG})`));
});

test('copy text is title, key points and notes, never a screenshot', () => {
  const text = renderExportText({
    title: 'Python Lists', points: ['Lists are ordered'], raw: 'A list is a collection.', transcript: 'remember append', shot: PNG,
  });
  assert.equal(text, [
    'Python Lists', '', 'Key points', '- Lists are ordered', '', 'Notes', 'A list is a collection.', '', 'What you said', 'remember append',
  ].join('\n') + '\n');
  assert.ok(!text.includes('data:image'));
  assert.ok(!pngBuffer('javascript:alert(1)'));
  assert.ok(pngBuffer(PNG).length > 0);
});

test('safeFileName removes invalid characters and reserved names', () => {
  assert.equal(safeFileName('POV: Your Heart Belongs to Another Era'), 'POV Your Heart Belongs to Another Era');
  assert.equal(safeFileName('a/b\\c*d?"e<f>g|h'), 'a b c d e f g h');
  assert.equal(safeFileName('../../etc/passwd'), 'etc passwd');
  assert.equal(safeFileName('  ...  '), 'Notely note');
  assert.equal(safeFileName('CON'), 'CON note');
  assert.ok(safeFileName('word '.repeat(40)).length <= 80);
});
