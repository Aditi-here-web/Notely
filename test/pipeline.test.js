'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  processOcr, processText, composeDetails, isGrounded, cleanUrl, isCodeLike, pickTitle, fallbackTitle,
} = require('../notes-pipeline');
const { layout, TUTORIAL_ROWS, WIDTH, HEIGHT } = require('./layout-fixture');

function run(rows) {
  return processOcr(layout(rows), { width: WIDTH, height: HEIGHT });
}

test('tutorial screen: main content kept, browser UI, sidebar and taskbar removed', () => {
  const r = run(TUTORIAL_ROWS);
  assert.equal(r.notes.title, 'Python Lists');
  assert.match(r.cleanText, /A list is an ordered collection/);
  for (const noise of ['New Tab', 'Inbox', 'utm_source', 'views', 'Learn Python in 10 minutes', 'Sponsored', '10:42']) {
    assert.ok(!r.cleanText.includes(noise), `clean text should not contain "${noise}"`);
  }
  assert.equal(r.stats.browserChrome, true);
  assert.equal(r.stats.sidebar, true);
  assert.ok(r.stats.removed['browser-ui'] >= 3);
  assert.equal(r.stats.removed.taskbar, 1);
});

test('raw OCR text is preserved separately from the cleaned text', () => {
  const r = run(TUTORIAL_ROWS);
  assert.match(r.rawText, /New Tab/);
  assert.match(r.rawText, /utm_source/);
  assert.ok(!r.cleanText.includes('New Tab'));
});

test('repeated lines appear only once', () => {
  const r = run(TUTORIAL_ROWS);
  const hits = r.cleanText.split('Important: lists are mutable').length - 1;
  assert.equal(hits, 1);
  assert.equal(r.stats.removed.duplicate, 1);
});

test('URLs and code in the main content are kept', () => {
  const r = run(TUTORIAL_ROWS);
  assert.deepEqual(r.notes.code, ["fruits = ['apple', 'banana', 'cherry']"]);
  assert.deepEqual(r.notes.links, ['https://docs.python.org/3/tutorial/datastructures.html']);
  const details = composeDetails(r.notes);
  assert.match(details, /```\nfruits = \['apple', 'banana', 'cherry'\]\n```/);
  assert.match(details, /docs\.python\.org/);
});

test('definitions and key points are structured, not a copy of every line', () => {
  const r = run(TUTORIAL_ROWS);
  assert.equal(r.notes.definitions.length, 1);
  assert.equal(r.notes.definitions[0].term, 'list');
  assert.ok(r.notes.keyPoints.length >= 1 && r.notes.keyPoints.length <= 7);
  assert.ok(!r.notes.keyPoints.includes('Python Lists'), 'title is not repeated as a key point');
  for (const p of r.notes.keyPoints) assert.ok(isGrounded(p, r.cleanText));
});

test('low-confidence fragments are dropped', () => {
  const rows = [
    { text: 'Photosynthesis', x: 380, y: 150, h: 36 },
    { text: 'Plants convert light energy into chemical energy stored in glucose.', x: 380, y: 210 },
    { text: 'xq7 ~~ rr', x: 380, y: 240, conf: 20 },
  ];
  const r = run(rows);
  assert.ok(!r.cleanText.includes('xq7'));
  assert.ok(r.stats.removed['low-confidence'] >= 1);
  assert.match(r.cleanText, /Plants convert light energy/);
});

test('screen with only browser chrome and controls reports low content', () => {
  const rows = [
    { text: 'New Tab x', x: 10, y: 8, h: 14 },
    { text: 'Settings x', x: 300, y: 8, h: 14 },
    { text: 'https://example.com/?utm_source=x', x: 120, y: 44, h: 14 },
    { text: '0:42 / 12:10', x: 380, y: 900, h: 12 },
    { text: '10:42 AM', x: 1500, y: 968, h: 12 },
  ];
  const r = run(rows);
  assert.equal(r.notes.lowContent, true);
  assert.equal(r.notes.keyPoints.length, 0);
});

test('processText (no layout) still filters metadata and dedupes', () => {
  const r = processText([
    'Mitochondria',
    'Mitochondria produce most of the energy a cell needs.',
    '1.2M views 3 days ago',
    'Mitochondria produce most of the energy a cell needs.',
  ].join('\n'));
  assert.equal(r.notes.title, 'Mitochondria');
  assert.ok(!r.cleanText.includes('views'));
  assert.equal(r.cleanText.split('produce most').length - 1, 1);
});

test('cleanUrl removes tracking parameters but keeps meaningful ones', () => {
  assert.equal(
    cleanUrl('https://example.com/page?id=7&utm_source=news&fbclid=abc'),
    'https://example.com/page?id=7',
  );
  assert.equal(cleanUrl('https://docs.python.org/3/'), 'https://docs.python.org/3/');
});

test('isCodeLike recognises code but not headings that mention a language', () => {
  assert.equal(isCodeLike("fruits = ['apple', 'banana']"), true);
  assert.equal(isCodeLike('def add(a, b):'), true);
  assert.equal(isCodeLike('Python Lists'), false);
});

test('title: a heading cut off on screen is completed from the full line', () => {
  assert.equal(
    pickTitle(['POV: Your Heart Bel'], ['Your Heart Belongs to Another Era', 'A playlist for old melodies.']),
    'Your Heart Belongs to Another Era',
  );
  assert.equal(
    pickTitle(['Getting Started with Rea…'], ['Getting Started with React Hooks - a guide']),
    'Getting Started with React Hooks',
  );
});

test('title: a complete heading is not "completed" into a longer sentence', () => {
  assert.equal(pickTitle(['Python List'], ['Python Lists are ordered collections.']), 'Python List');
});

test('title: cut-off text that cannot be completed is not used', () => {
  assert.equal(pickTitle(['Your Heart Belongs to Anoth...', 'Old Bollywood Playlist'], []), 'Old Bollywood Playlist');
});

test('title: browser/UI text and generic words are rejected; site suffix removed', () => {
  assert.equal(pickTitle(['New Tab x | Inbox x | Docs x', 'Notes', 'Screenshot', 'Subscribe', 'Photosynthesis']), 'Photosynthesis');
  assert.equal(pickTitle(['How Vaccines Work - YouTube']), 'How Vaccines Work');
  assert.equal(pickTitle(['https://example.com/page', '1.2M views 3 days ago']), '');
  assert.equal(pickTitle(['pyaar', 'Your Heart Belongs to Another Era']), 'Your Heart Belongs to Another Era');
});

test('title: long titles end at a word boundary within 70 characters', () => {
  const t = pickTitle(['Understanding the Fundamental Principles of Distributed Systems Design and the Tradeoffs of Consistency']);
  assert.ok(t.length <= 70, t);
  assert.ok(!/…|\.\.\.$/.test(t));
  assert.ok('Understanding the Fundamental Principles of Distributed Systems Design and the Tradeoffs of Consistency'.startsWith(t));
  assert.ok(!/\s(of|the|and)$/i.test(t), t);
});

test('title: fallback names the content type and time', () => {
  assert.match(fallbackTitle(new Date(2026, 9, 10, 0, 2)), /^Screen Notes - .*2026/);
  assert.match(fallbackTitle(new Date(2026, 9, 10, 0, 2), 'Notes'), /^Notes - /);
});

test('capture with a cut-off video overlay title gets the full title', () => {
  const r = run([
    { text: 'pyaar', x: 300, y: 200, h: 48 },
    { text: 'POV: Your Heart Bel', x: 120, y: 520, h: 30 },
    { text: ': Your Heart Belongs to Another Era', x: 120, y: 620, h: 22 },
    { text: 'A playlist for the ones who still find comfort in old melodies, timeless lyrics, and rare love.', x: 120, y: 700 },
  ]);
  assert.equal(r.notes.title, 'Your Heart Belongs to Another Era');
  assert.ok(!r.notes.keyPoints.some((p) => /Heart Bel\b/.test(p)));
  assert.ok(!r.notes.headings.some((h) => /Your Heart/.test(h)), 'title fragments are not repeated as sections');
});

test('isGrounded rejects content not present in the source', () => {
  const src = 'A list is an ordered collection of items.';
  assert.equal(isGrounded('Lists are ordered collections', src), true);
  assert.equal(isGrounded('Mars has two moons', src), false);
});
