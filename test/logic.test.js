'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fallbackPolish,
  normalizePolish,
  parseJsonObject,
  slugTitle,
  makeNoteId,
  isSafeNoteId,
  pngFromDataUrl,
  resampleTo16k,
} = require('../logic');

test('fallbackPolish splits spoken sentences into bullets', () => {
  const r = fallbackPolish('first idea. second idea and also a third', '');
  assert.equal(r.ai, false);
  assert.ok(r.points.length >= 2);
  assert.equal(r.points[0], 'First idea');
});

test('fallbackPolish uses the screen heading as title, not as a key point', () => {
  const r = fallbackPolish('', 'Photosynthesis\nPlants convert light to energy\n');
  assert.equal(r.title, 'Photosynthesis');
  assert.deepEqual(r.points, ['Plants convert light to energy']);
});

test('normalizePolish rejects empty or invalid model output', () => {
  const fallback = fallbackPolish('hello world', '');
  assert.deepEqual(normalizePolish(null, 'hello world', ''), fallback);
  assert.deepEqual(normalizePolish({ title: 'X', points: [] }, 'hello world', ''), fallback);
});

test('normalizePolish keeps only AI points supported by the source text', () => {
  const r = normalizePolish(
    { title: 'Cells', points: ['The nucleus holds DNA', 'Mars has two moons'] },
    'the nucleus holds DNA in cells',
    '',
  );
  assert.equal(r.ai, true);
  assert.equal(r.title, 'Cells');
  assert.deepEqual(r.points, ['The nucleus holds DNA']);
});

test('normalizePolish falls back when every AI point is invented', () => {
  const r = normalizePolish({ title: 'Space', points: ['Mars has two moons'] }, 'the nucleus holds DNA', '');
  assert.equal(r.ai, false);
  assert.ok(!r.points.includes('Mars has two moons'));
});

test('parseJsonObject extracts an object from noisy text', () => {
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonObject('Sure.\n{"title":"T","points":["A"]}\n'), { title: 'T', points: ['A'] });
  assert.equal(parseJsonObject('not json'), null);
});

test('slugTitle and makeNoteId stay filesystem-safe', () => {
  assert.equal(slugTitle('Hello, World!!'), 'hello-world');
  const id = makeNoteId('Algebra 101', new Date('2026-04-09T14:30:00.000Z'));
  assert.equal(id, '2026-04-09-14-30-algebra-101');
  assert.equal(isSafeNoteId(id), true);
});

test('slugTitle cuts long titles at a word boundary', () => {
  const slug = slugTitle('POV: Your Heart Belongs to Another Era and Many More Words Here');
  assert.ok(slug.length <= 40, slug);
  assert.equal(slug, 'pov-your-heart-belongs-to-another-era');
});

test('fallbackPolish speech title is a whole clause, never a hard cut', () => {
  const r = fallbackPolish('mitochondria make energy for the cell. they have their own DNA', '');
  assert.equal(r.title, 'Mitochondria make energy for the cell');
  assert.equal(fallbackPolish('', '').title, '');
});

test('isSafeNoteId blocks path traversal', () => {
  assert.equal(isSafeNoteId('../secret'), false);
  assert.equal(isSafeNoteId('a/b'), false);
  assert.equal(isSafeNoteId('a\\b'), false);
  assert.equal(isSafeNoteId('C:foo'), false);
  assert.equal(isSafeNoteId(''), false);
  assert.equal(isSafeNoteId('ok-note_1.jsonish'), true);
});

test('pngFromDataUrl only accepts PNG data URLs', () => {
  const buf = pngFromDataUrl('data:image/png;base64,aGVsbG8=');
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.toString(), 'hello');
  assert.equal(pngFromDataUrl('data:image/jpeg;base64,aGVsbG8='), null);
  assert.equal(pngFromDataUrl('not-an-image'), null);
});

test('resampleTo16k downsamples audio length', () => {
  const input = new Float32Array(48000);
  for (let i = 0; i < input.length; i++) input[i] = i;
  const out = resampleTo16k(input, 48000);
  assert.equal(out.length, 16000);
  assert.equal(out[0], 0);
  const same = resampleTo16k(input.slice(0, 16000), 16000);
  assert.equal(same.length, 16000);
});

const fs = require('node:fs');
const path = require('node:path');
const { tessLangDir, tessWorkerPath, tessCreateWorkerOptions } = require('../logic');

test('tessLangDir finds local eng.traineddata', () => {
  const root = path.join(__dirname, '..');
  const dir = tessLangDir(root, null);
  assert.equal(dir, path.resolve(root));
  assert.ok(fs.existsSync(path.join(dir, 'eng.traineddata')));
});

test('tessWorkerPath is absolute and exists', () => {
  const tessRoot = path.dirname(require.resolve('tesseract.js/package.json'));
  const workerPath = tessWorkerPath(tessRoot);
  assert.equal(path.isAbsolute(workerPath), true);
  assert.ok(workerPath.endsWith(path.join('worker-script', 'node', 'index.js')));
  assert.ok(fs.existsSync(workerPath));
});

test('tessCreateWorkerOptions uses cachePath instead of a filesystem langPath', () => {
  const root = path.join(__dirname, '..');
  const tessRoot = path.dirname(require.resolve('tesseract.js/package.json'));
  const opts = tessCreateWorkerOptions({ appRoot: root, tesseractRoot: tessRoot });
  assert.equal(path.isAbsolute(opts.workerPath), true);
  assert.equal(path.isAbsolute(opts.cachePath), true);
  assert.equal(opts.cacheMethod, 'readOnly');
  assert.equal('langPath' in opts, false);
  assert.ok(fs.existsSync(path.join(opts.cachePath, 'eng.traineddata')));
});

test('tessCreateWorkerOptions rejects a missing language pack', () => {
  const tessRoot = path.dirname(require.resolve('tesseract.js/package.json'));
  assert.throws(
    () => tessCreateWorkerOptions({ appRoot: path.join(__dirname, 'missing-lang'), tesseractRoot: tessRoot }),
    /eng\.traineddata/,
  );
});

test('a Windows language path is not a valid fetch URL for Tesseract', async () => {
  const fetch = require('node-fetch');
  await assert.rejects(
    () => fetch('D:/notely-app/eng.traineddata'),
    /absolute URL|HTTP\(S\)/i,
  );
  await assert.rejects(
    () => fetch('D:\\notely-app\\eng.traineddata'),
    /absolute URL|HTTP\(S\)/i,
  );
});
