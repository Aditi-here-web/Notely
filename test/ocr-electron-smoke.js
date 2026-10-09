'use strict';

const { app } = require('electron');
const path = require('path');
const Tesseract = require('tesseract.js');
const { tessCreateWorkerOptions } = require('../logic');

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

app.whenReady().then(async () => {
  process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT', err);
    app.exit(1);
  });
  try {
    const tessRoot = path.dirname(require.resolve('tesseract.js/package.json'));
    const options = tessCreateWorkerOptions({
      appRoot: path.join(__dirname, '..'),
      tesseractRoot: tessRoot,
      resourcesPath: process.resourcesPath,
    });
    console.log('electron env versions.electron', process.versions.electron);
    console.log('ocr options', {
      workerPath: options.workerPath,
      cachePath: options.cachePath,
      cacheMethod: options.cacheMethod,
      hasLangPath: Object.prototype.hasOwnProperty.call(options, 'langPath'),
    });
    const worker = await Tesseract.createWorker('eng', 1, {
      ...options,
      logger: () => {},
      errorHandler: (err) => {
        console.error('Tesseract worker error:', err);
      },
    });
    console.log('tesseract worker: ok');
    const blank = await worker.recognize(PNG_1x1);
    console.log('tesseract recognize blank: ok', JSON.stringify({ text: (blank.data && blank.data.text) || '' }));
    const sharp = require('sharp');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="120">
      <rect width="100%" height="100%" fill="white"/>
      <text x="24" y="72" font-size="48" font-family="Arial" fill="black">HELLO OCR</text>
    </svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const { data } = await worker.recognize(png);
    const text = String(data && data.text ? data.text : '').replace(/\s+/g, ' ').trim();
    console.log('OCR TEXT:', text);
    await worker.terminate();
    if (!/HELLO/i.test(text) && !/OCR/i.test(text)) {
      throw new Error('Expected OCR to read HELLO OCR, got: ' + JSON.stringify(text));
    }
    console.log('electron ocr smoke: ok');
    app.exit(0);
  } catch (err) {
    console.error('electron ocr smoke FAIL', err);
    app.exit(1);
  }
});
