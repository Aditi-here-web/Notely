'use strict';

// End-to-end check with real Tesseract OCR: rendered tutorial page -> OCR -> cleaned notes.
const path = require('path');
const assert = require('assert/strict');
const Tesseract = require('tesseract.js');
const { tessCreateWorkerOptions } = require('../logic');
const { processOcr, composeDetails } = require('../notes-pipeline');
const { TUTORIAL_SVG } = require('./fixtures');

(async () => {
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    console.log('SKIP: sharp is not available to render the test image');
    return;
  }
  const png = await sharp(Buffer.from(TUTORIAL_SVG)).png().toBuffer();
  const tessRoot = path.dirname(require.resolve('tesseract.js/package.json'));
  const worker = await Tesseract.createWorker('eng', 1, {
    ...tessCreateWorkerOptions({ appRoot: path.join(__dirname, '..'), tesseractRoot: tessRoot }),
    logger: () => {},
  });
  const { data } = await worker.recognize(png, {}, { text: true, blocks: true, hocr: false, tsv: false });
  await worker.terminate();

  const debug = process.argv.includes('--debug');
  const result = processOcr(data, {
    width: 1600,
    height: 1000,
    debug: debug ? (rows) => rows.forEach((e) => console.log((e.reason || 'KEEP').padEnd(16), Math.round(e.seg.h), e.seg.text)) : undefined,
  });
  const notes = result.notes;
  const details = composeDetails(notes);
  const all = [notes.title, ...notes.keyPoints, details].join('\n');
  console.log('STATS', JSON.stringify(result.stats));
  console.log('TITLE', notes.title);
  console.log('KEY POINTS', JSON.stringify(notes.keyPoints, null, 2));
  console.log('DETAILS\n' + details);

  assert.match(notes.title, /Python Lists/i, 'title from main heading');
  assert.match(all, /ordered collection/i, 'definition kept');
  assert.ok(notes.steps.length >= 2, 'numbered steps kept');
  assert.ok(notes.code.some((c) => /fruits/.test(c)), 'code kept');
  assert.ok(notes.links.some((l) => l.startsWith('https://docs.python.org/3/tutorial/datastructures.html')), 'content URL kept');
  assert.doesNotMatch(all, /utm_source/i, 'tracking parameters removed');
  assert.doesNotMatch(all, /New tab|Inbox|Weather/i, 'browser tabs removed');
  assert.doesNotMatch(all, /Learn Java|Coding Laptops|Cloud Hosting|views|Sponsored/i, 'sidebar removed');
  assert.doesNotMatch(all, /11:37|09-10-2026/, 'taskbar removed');
  const negatives = all.match(/negative indexes count/gi) || [];
  assert.equal(negatives.length, 1, 'duplicate line kept once');
  assert.match(result.rawText, /views/i, 'raw OCR preserved separately');
  assert.doesNotMatch(result.cleanText, /views/i, 'cleaned text excludes sidebar metadata');
  console.log('ocr pipeline smoke: ok');
})().catch((err) => {
  console.error('ocr pipeline smoke FAIL', err);
  process.exit(1);
});
