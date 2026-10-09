'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  processText, processOcr, pickTitle, dedupePoints, composeDetails, detectContentType,
} = require('../notes-pipeline');
const { createOllamaProvider, summarizeScreen, summarizeText } = require('../summarizer');
const { layout } = require('./layout-fixture');

// --- Titles -------------------------------------------------------------------

test('titles drop social framing and use the complete heading', () => {
  assert.equal(pickTitle(['POV: Your Heart Belongs to Another Era']), 'Your Heart Belongs to Another Era');
  assert.equal(pickTitle(['POV: Your Heart Bel'], ['POV: Your Heart Belongs to Another Era']), 'Your Heart Belongs to Another Era');
  assert.equal(pickTitle(['Kesariya (Official Video) - YouTube']), 'Kesariya');
  assert.equal(pickTitle(['Watch: How Vaccines Work']), 'How Vaccines Work');
});

test('browser navigation text never becomes the title', () => {
  const r = processOcr(layout([
    { text: 'New Tab x', x: 10, y: 8, h: 14 },
    { text: 'https://www.youtube.com/watch?v=abc123', x: 120, y: 44, h: 14 },
    { text: 'POV: Your Heart Belongs to Another Era', x: 120, y: 560, h: 30 },
    { text: 'A playlist for the ones who still find comfort in old melodies and timeless lyrics.', x: 120, y: 620 },
    { text: '2.1M views 3 weeks ago', x: 120, y: 660, h: 12 },
  ]), { width: 1600, height: 900 });
  assert.equal(r.notes.title, 'Your Heart Belongs to Another Era');
});

test('insufficient content is flagged and gets no invented title', () => {
  const r = processText('OK\nx');
  assert.equal(r.notes.lowContent, true);
  assert.equal(r.notes.title, '');
});

// --- Content types and structure ---------------------------------------------------

test('content types are recognized from the screen', () => {
  const type = (text) => processText(text).notes.type;
  assert.equal(type('PS C:\\app> npm test\nnpm ERR! Missing script: "test"\nnpm install express\ngit status'), 'code');
  assert.equal(type('YouTube\nPython Lists Tutorial for Beginners\nA list is an ordered collection of items.\n1.2M views'), 'education');
  assert.equal(type('Page 3 of 12\nThe committee reviewed the annual budget in detail.\nSpending rose by four percent this year.'), 'document');
  assert.equal(type('fetch() - Web APIs\nSyntax\nParameters\nThe resource that you wish to fetch.\nReturns a Promise that resolves to a Response.'), 'docs');
  assert.equal(type([
    'City council approves new bike lanes',
    'The council voted on Tuesday to add twelve kilometres of protected bike lanes.',
    'Construction will begin in the spring and finish by the end of next year.',
    'Officials said the project is funded by a regional transport grant.',
    'Residents raised concerns about parking during the public meeting.',
  ].join('\n')), 'article');
});

test('code screens keep commands and code verbatim in the details', () => {
  const r = processText('Deploying the app\nRun these commands from the project folder.\nnpm install\nnpm run build\ngit push origin main');
  const details = composeDetails(r.notes, r.notes.type);
  assert.equal(r.notes.type, 'code');
  assert.match(details, /^Commands\n- npm install\n- npm run build\n- git push origin main/m);
});

test('educational and article notes use their own section names', () => {
  const edu = processText('Python Lists Tutorial\nA list is an ordered collection of items.\nLists are mutable, so items can be changed after creation.\nTuples are immutable and cannot be changed.');
  assert.equal(edu.notes.type, 'education');
  assert.match(composeDetails(edu.notes, 'education'), /Key concepts\n- A list is an ordered collection of items\./);
  const art = processText([
    'The council voted on Tuesday to add twelve kilometres of protected bike lanes.',
    'Construction will begin in the spring and finish by the end of next year.',
    'Officials said the project is funded by a regional transport grant.',
    'Residents raised concerns about parking during the public meeting.',
    'A second vote on the downtown section is expected next month.',
  ].join('\n'));
  const details = composeDetails(art.notes, 'article');
  assert.ok(!/Key concepts|Commands/.test(details));
});

test('key points never repeat the same sentence', () => {
  assert.deepEqual(dedupePoints([
    'Lists are mutable so you can change items.',
    'lists are mutable so you can change items.',
    'Lists are mutable so you can change items after creating them.',
    'Tuples are immutable.',
  ]), ['Lists are mutable so you can change items after creating them.', 'Tuples are immutable.']);
  const r = processText('Important: lists are mutable.\nImportant: lists are mutable.\nA list is an ordered collection of items that can hold values of different types.');
  const lower = r.notes.keyPoints.map((p) => p.toLowerCase());
  assert.equal(new Set(lower).size, lower.length);
});

test('detectContentType falls back to general for sparse screens', () => {
  assert.equal(detectContentType('', {
    code: [], commands: [], keyPoints: ['One point here'], details: [], steps: [], definitions: [],
  }), 'general');
});

// --- Summarizer: honest fallback, grounding, failures -------------------------------

const SCREEN = 'Photosynthesis\nPlants convert light energy into chemical energy.\nChlorophyll absorbs red and blue light.\nOxygen is released as a by-product.';

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    const handler = routes[new URL(url).pathname];
    if (!handler) throw new Error('ECONNREFUSED');
    return handler(init);
  };
  fn.calls = calls;
  return fn;
}
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('without a local model the rule-based notes are used and labelled as such', async () => {
  const provider = createOllamaProvider({ fetchImpl: fakeFetch({}) });
  const st = await provider.status();
  assert.equal(st.available, false);
  const notes = processText(SCREEN).notes;
  const r = await summarizeScreen({ cleanText: SCREEN, notes }, provider);
  assert.equal(r.method, 'rules');
  assert.equal(r.reason, 'unavailable');
  assert.deepEqual(r.points, notes.keyPoints);
  const t = await summarizeText({ raw: '', ocr: SCREEN }, provider);
  assert.equal(t.method, 'rules');
  assert.equal(t.ai, false);
});

test('an installed model is detected and its grounded points are used', async () => {
  const fetchImpl = fakeFetch({
    '/api/tags': () => json({ models: [{ name: 'nomic-embed-text:latest' }, { name: 'qwen2.5:3b' }] }),
    '/api/generate': () => json({
      response: JSON.stringify({
        title: 'Photosynthesis basics',
        points: [
          'Plants convert light energy into chemical energy.',
          'Plants convert light energy into chemical energy.',
          'Chlorophyll absorbs red and blue light.',
          'Mars has two small moons.',
        ],
      }),
    }),
  });
  const provider = createOllamaProvider({ fetchImpl });
  const notes = processText(SCREEN).notes;
  const r = await summarizeScreen({ cleanText: SCREEN, notes }, provider);
  assert.equal(r.method, 'ai');
  assert.equal(r.model, 'qwen2.5:3b');
  assert.deepEqual(r.points, ['Plants convert light energy into chemical energy.', 'Chlorophyll absorbs red and blue light.']);
  assert.equal(r.title, notes.title, 'the on-screen heading is kept as the title');
  const gen = fetchImpl.calls.find((c) => c.url.endsWith('/api/generate'));
  assert.equal(new URL(gen.url).hostname, '127.0.0.1', 'only the local server is contacted');
});

test('a failing or invented AI answer falls back to the rule-based notes', async () => {
  const notes = processText(SCREEN).notes;
  const failing = createOllamaProvider({
    fetchImpl: fakeFetch({ '/api/tags': () => json({ models: [{ name: 'llama3.2' }] }), '/api/generate': () => json({}, 500) }),
  });
  const r1 = await summarizeScreen({ cleanText: SCREEN, notes }, failing);
  assert.equal(r1.method, 'rules');
  assert.equal(r1.reason, 'failed');
  assert.deepEqual(r1.points, notes.keyPoints);

  const inventing = createOllamaProvider({
    fetchImpl: fakeFetch({
      '/api/tags': () => json({ models: [{ name: 'llama3.2' }] }),
      '/api/generate': () => json({ response: '{"title":"Space","points":["Mars has two moons","Jupiter is a gas giant"]}' }),
    }),
  });
  const r2 = await summarizeScreen({ cleanText: SCREEN, notes }, inventing);
  assert.equal(r2.method, 'rules');
  assert.equal(r2.reason, 'ungrounded');

  const r3 = await summarizeText({ raw: '', ocr: SCREEN }, failing);
  assert.equal(r3.method, 'rules');
  assert.equal(r3.reason, 'failed');
  assert.ok(r3.points.length > 0);
});

test('low-content screens are not sent to the AI', async () => {
  const fetchImpl = fakeFetch({ '/api/tags': () => json({ models: [{ name: 'llama3.2' }] }) });
  const notes = processText('OK').notes;
  const r = await summarizeScreen({ cleanText: 'OK', notes }, createOllamaProvider({ fetchImpl }));
  assert.equal(r.reason, 'low-content');
  assert.equal(fetchImpl.calls.length, 0);
});
