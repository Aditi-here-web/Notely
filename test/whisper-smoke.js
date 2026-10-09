'use strict';

const path = require('path');
const fs = require('fs');

(async () => {
  const { pipeline, env } = await import('@huggingface/transformers');
  const bundled = path.join(__dirname, '..', 'node_modules', '@huggingface', 'transformers', '.cache');
  env.cacheDir = bundled;
  const modelPath = path.join(bundled, 'Xenova', 'whisper-tiny.en', 'onnx', 'encoder_model.onnx');
  console.log('whisper cache present:', fs.existsSync(modelPath));
  const asr = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', { dtype: 'fp32' });
  const audio = new Float32Array(16000);
  const result = await asr(audio, { sampling_rate: 16000 });
  console.log('whisper result:', JSON.stringify(result));
  console.log('whisper: ok');
})().catch((err) => {
  console.error('whisper FAIL', err);
  process.exit(1);
});
