'use strict';

const fs = require('fs');
const path = require('path');
const {
  processText, isGrounded, pickTitle, clauseTitle,
} = require('./notes-pipeline');

function splitPoints(raw) {
  return String(raw || '')
    .split(/[.;]|\band also\b|\bthen\b/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 1)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1));
}

// Rule-based key points: spoken notes first, then the cleaned screen text.
// `ocr` must already be cleaned text, never raw OCR output.
// `title` is '' when nothing meaningful was found; the caller decides the fallback.
function fallbackPolish(raw, ocr) {
  const fromSpeech = splitPoints(raw);
  const screen = String(ocr || '').trim() ? processText(ocr).notes : null;
  const fromScreen = screen ? screen.keyPoints : [];
  const title = (screen && screen.title) || pickTitle(fromSpeech.map(clauseTitle), fromSpeech);
  const points = [...fromSpeech, ...fromScreen.filter((p) => !fromSpeech.includes(p))].slice(0, 12);
  return { title, points, ai: false };
}

// Accepts AI output only when its points are supported by the source text.
function normalizePolish(parsed, raw, ocr) {
  if (!parsed || typeof parsed !== 'object') return fallbackPolish(raw, ocr);
  const source = `${raw || ''}\n${ocr || ''}`;
  const points = Array.isArray(parsed.points)
    ? parsed.points.map((p) => String(p).trim()).filter((p) => p && isGrounded(p, source)).slice(0, 12)
    : [];
  if (!points.length) return fallbackPolish(raw, ocr);
  const aiTitle = String(parsed.title || '').trim();
  const cleaned = aiTitle && isGrounded(aiTitle, source) ? pickTitle([aiTitle]) : '';
  return { title: cleaned || fallbackPolish(raw, ocr).title, points, ai: true };
}

function parseJsonObject(text) {
  if (text && typeof text === 'object') return text;
  const s = String(text || '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(s.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

// Folder-name part of a note id: lowercase ASCII words, cut at a word boundary.
function slugTitle(title) {
  let slug = String(title || 'note')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > 40) {
    slug = slug.slice(0, 41);
    const cut = slug.lastIndexOf('-');
    slug = cut >= 15 ? slug.slice(0, cut) : slug.slice(0, 40);
  }
  return slug.replace(/-+$/, '') || 'note';
}

function makeNoteId(title, now = new Date()) {
  const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `${stamp}-${slugTitle(title)}`;
}

function isSafeNoteId(id) {
  if (typeof id !== 'string' || !id) return false;
  if (id.length > 120) return false;
  if (id.includes('..') || id.includes('/') || id.includes('\\') || id.includes('\0')) return false;
  if (/^[a-zA-Z]:/.test(id)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}

function pngFromDataUrl(shot) {
  if (!shot || typeof shot !== 'string') return null;
  const m = shot.match(/^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/);
  if (!m) return null;
  return Buffer.from(m[1], 'base64');
}

function resampleTo16k(input, fromRate) {
  const rate = Number(fromRate) || 0;
  if (!input || !input.length || rate <= 0) return new Float32Array(0);
  if (Math.abs(rate - 16000) < 1) return Float32Array.from(input);
  const ratio = rate / 16000;
  const outLen = Math.max(0, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = input[Math.min(input.length - 1, Math.floor(i * ratio))];
  return out;
}

function tessLangDir(appRoot, resourcesPath) {
  const dirs = [appRoot];
  if (resourcesPath) {
    dirs.push(path.join(resourcesPath, 'app.asar.unpacked'));
    dirs.push(resourcesPath);
  }
  for (const dir of dirs) {
    if (dir && fs.existsSync(path.join(dir, 'eng.traineddata'))) return path.resolve(dir);
  }
  return null;
}

function tessWorkerPath(tesseractRoot) {
  const nested = path.join(tesseractRoot, 'src', 'worker-script', 'node', 'index.js');
  const asarSep = `${path.sep}app.asar${path.sep}`;
  const unpackedSep = `${path.sep}app.asar.unpacked${path.sep}`;
  const unpacked = nested.includes(asarSep) && !nested.includes(unpackedSep)
    ? nested.replace(asarSep, unpackedSep)
    : nested;
  if (fs.existsSync(unpacked)) return unpacked;
  return nested;
}

// ONNX Runtime opens model files with the OS, not Node's fs, so a path inside
// app.asar is not a readable model. Prefer the unpacked file when it exists.
function realWhisperCacheDir(cacheDir) {
  if (!cacheDir) return null;
  const onnx = path.join(cacheDir, 'Xenova', 'whisper-tiny.en', 'onnx', 'encoder_model.onnx');
  const asarSep = `${path.sep}app.asar${path.sep}`;
  const unpackedSep = `${path.sep}app.asar.unpacked${path.sep}`;
  let candidate = onnx;
  if (onnx.includes(asarSep) && !onnx.includes(unpackedSep)) {
    candidate = onnx.replace(asarSep, unpackedSep);
  } else if (!fs.existsSync(onnx)) {
    return null;
  } else {
    return cacheDir;
  }
  if (!fs.existsSync(candidate)) return null;
  return path.dirname(path.dirname(path.dirname(path.dirname(candidate))));
}

function tessCreateWorkerOptions({ appRoot, tesseractRoot, resourcesPath }) {
  const workerPath = tessWorkerPath(tesseractRoot);
  const cachePath = tessLangDir(appRoot, resourcesPath);
  if (!path.isAbsolute(workerPath)) {
    throw new Error('Tesseract workerPath must be an absolute file path.');
  }
  if (!fs.existsSync(workerPath)) {
    throw new Error('Tesseract worker script was not found.');
  }
  if (!cachePath) {
    throw new Error('English OCR data (eng.traineddata) was not found.');
  }
  return {
    workerPath,
    cachePath,
    cacheMethod: 'readOnly',
    gzip: false,
    workerBlobURL: false,
  };
}

module.exports = {
  splitPoints,
  fallbackPolish,
  normalizePolish,
  parseJsonObject,
  slugTitle,
  makeNoteId,
  isSafeNoteId,
  pngFromDataUrl,
  resampleTo16k,
  tessLangDir,
  tessWorkerPath,
  tessCreateWorkerOptions,
  realWhisperCacheDir,
};
