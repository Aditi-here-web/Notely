'use strict';

const path = require('path');
const Tesseract = require('tesseract.js');
const { tessCreateWorkerOptions } = require('../logic');

const root = path.join(__dirname, '..');
const tessRoot = path.dirname(require.resolve('tesseract.js/package.json'));
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

(async () => {
  const options = tessCreateWorkerOptions({ appRoot: root, tesseractRoot: tessRoot });
  const worker = await Tesseract.createWorker('eng', 1, {
    ...options,
    logger: () => {},
    errorHandler: (err) => {
      console.error('Tesseract worker error:', err);
    },
  });
  console.log('tesseract worker: ok');
  const { data } = await worker.recognize(PNG_1x1);
  console.log('tesseract recognize: ok', JSON.stringify({ text: (data && data.text) || '' }));
  await worker.terminate();
  console.log('tesseract terminate: ok');
})().catch((err) => {
  console.error('tesseract FAIL', err);
  process.exit(1);
});
