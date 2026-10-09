'use strict';

// Prints the title, key points and headings Notely would produce for image files.
// Read-only. Usage: node test/ocr-file.js <image.png> [...]

const fs = require('fs');
const path = require('path');
const Tesseract = require('tesseract.js');
const { tessCreateWorkerOptions } = require('../logic');
const { processOcr } = require('../notes-pipeline');

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) throw new Error('Pass one or more image paths.');
  const worker = await Tesseract.createWorker('eng', 1, {
    ...tessCreateWorkerOptions({
      appRoot: path.join(__dirname, '..'),
      tesseractRoot: path.dirname(require.resolve('tesseract.js/package.json')),
    }),
    logger: () => {},
  });
  try {
    for (const file of files) {
      const png = fs.readFileSync(file);
      const width = png.readUInt32BE(16);
      const height = png.readUInt32BE(20);
      const { data } = await worker.recognize(png, {}, { text: true, blocks: true });
      const r = processOcr(data, { width, height });
      console.log(path.basename(path.dirname(file)));
      console.log('  title   :', JSON.stringify(r.notes.title));
      console.log('  points  :', JSON.stringify(r.notes.keyPoints));
      console.log('  headings:', JSON.stringify(r.notes.headings));
    }
  } finally {
    await worker.terminate();
  }
})().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
