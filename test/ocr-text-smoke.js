'use strict';

const path = require('path');
const Tesseract = require('tesseract.js');
const { tessCreateWorkerOptions } = require('../logic');

(async () => {
  const sharp = require('sharp');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="120">
    <rect width="100%" height="100%" fill="white"/>
    <text x="24" y="72" font-size="48" font-family="Arial" fill="black">HELLO OCR</text>
  </svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const tessRoot = path.dirname(require.resolve('tesseract.js/package.json'));
  const options = tessCreateWorkerOptions({
    appRoot: path.join(__dirname, '..'),
    tesseractRoot: tessRoot,
  });
  const worker = await Tesseract.createWorker('eng', 1, {
    ...options,
    logger: () => {},
    errorHandler: (err) => console.error(err),
  });
  const { data } = await worker.recognize(png);
  const text = String(data && data.text ? data.text : '').replace(/\s+/g, ' ').trim();
  console.log('OCR TEXT:', text);
  await worker.terminate();
  if (!/HELLO/i.test(text) && !/OCR/i.test(text)) {
    throw new Error('Expected OCR to read HELLO OCR, got: ' + JSON.stringify(text));
  }
  console.log('ocr text smoke: ok');
})().catch((err) => {
  console.error('ocr text smoke FAIL', err);
  process.exit(1);
});
