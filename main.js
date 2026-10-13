'use strict';

const {
  app, BrowserWindow, globalShortcut, desktopCapturer, ipcMain, screen, dialog, safeStorage, clipboard,
} = require('electron');
const fs = require('fs');
const path = require('path');
const { tessCreateWorkerOptions, pngFromDataUrl, realWhisperCacheDir } = require('./logic');
const storage = require('./storage');
const {
  safeFileName, renderExportHtml, renderExportMarkdown, renderExportText, pngBuffer,
} = require('./export');
const {
  createOllamaProvider, summarizeCapture, summarizeTextWith, localAiStatus,
} = require('./summarizer');
const { createGeminiProvider, GeminiError } = require('./gemini');
const { createSettingsStore, SettingsError } = require('./settings-store');
const { createCaptureFlow, registerShortcut, unregisterShortcut } = require('./capture-flow');

const preload = path.join(__dirname, 'preload.js');
const CAPTURE_SHORTCUT = 'CommandOrControl+Shift+S';

let win;
let bubble;
let storeStatus = { ok: false, error: '' };
const importInfo = { count: 0, from: [], failed: [] };
let asr;
let ocrWorker;
let capturing = false;
let appQuitting = false;
let shortcutStatus = { ok: false, accelerator: CAPTURE_SHORTCUT, error: '' };
const ai = createOllamaProvider();

const prefs = {
  preload,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: false,
};

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function harden(contents) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    const allowed = contents.getURL();
    if (url !== allowed) event.preventDefault();
  });
}

// --- Internal note storage ----------------------------------------------------

// Notes live in Notely's own data folder; nothing is written elsewhere unless
// the user exports a note.
function notesRoot() {
  return path.join(app.getPath('userData'), 'notes');
}

function checkStorage() {
  try {
    storage.probeDir(notesRoot());
    storeStatus = { ok: true, error: '' };
  } catch (err) {
    storeStatus = { ok: false, error: `Notely cannot use its notes storage: ${err.message}` };
  }
  return storeStatus;
}

function activeRoot() {
  if (!checkStorage().ok) throw new storage.StorageError(storeStatus.error, 'EDIR');
  return notesRoot();
}

// Older versions saved notes as files in a chosen folder (cfg.json `dir`,
// default Documents\Notely). Copy them in once; the originals are left untouched.
function importOldNotes() {
  const userData = app.getPath('userData');
  const sources = [path.join(app.getPath('documents'), 'Notely')];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(userData, 'cfg.json'), 'utf8'));
    if (cfg && typeof cfg.dir === 'string' && path.isAbsolute(cfg.dir)) sources.unshift(cfg.dir);
  } catch { /* no old settings */ }

  const recordFile = path.join(userData, 'imported.json');
  let record = { sources: [] };
  try {
    const stored = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    if (stored && Array.isArray(stored.sources)) record = { sources: stored.sources.filter((s) => typeof s === 'string') };
  } catch { /* first run */ }

  const seen = new Set();
  for (const src of sources) {
    const key = path.resolve(src).toLowerCase();
    if (seen.has(key) || key === path.resolve(notesRoot()).toLowerCase() || !fs.existsSync(src)) continue;
    seen.add(key);
    const res = storage.importNotes(src, notesRoot(), new Set(record.sources));
    if (res.imported.length) {
      record.sources.push(...res.imported.map((i) => i.from));
      storage.writeFileAtomic(recordFile, JSON.stringify(record, null, 2));
      importInfo.count += res.imported.length;
      importInfo.from.push(src);
    }
    importInfo.failed.push(...res.failed);
  }
  if (importInfo.count) console.log(`Imported ${importInfo.count} note(s) from`, importInfo.from.join(', '));
  if (importInfo.failed.length) console.error('Could not import:', importInfo.failed.join(', '));
}

// --- Export -----------------------------------------------------------------

function uniqueExportPath(dir, base, ext) {
  const suffix = String(ext || 'html').replace(/^\./, '');
  for (let i = 1; i < 1000; i++) {
    const candidate = path.join(dir, `${base}${i === 1 ? '' : ` (${i})`}.${suffix}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base}.${suffix}`);
}

const SHARE_FORMATS = {
  html: { ext: 'html', label: 'Export web page', filter: { name: 'Web page (opens in any browser)', extensions: ['html'] } },
  markdown: { ext: 'md', label: 'Export Markdown', filter: { name: 'Markdown', extensions: ['md'] } },
  pdf: { ext: 'pdf', label: 'Export PDF', filter: { name: 'PDF', extensions: ['pdf'] } },
  png: { ext: 'png', label: 'Save screenshot', filter: { name: 'Screenshot image', extensions: ['png'] } },
};

const PDF_MS = 30000;
const PDF_URL_MAX = 8 * 1024 * 1024;

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new storage.StorageError(message, 'ETIMEOUT')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function htmlToPdf(html) {
  let w;
  try {
    const encoded = encodeURIComponent(html);
    if (encoded.length > PDF_URL_MAX) {
      throw new storage.StorageError('This note is too large to export as a PDF. Try without the screenshot, or export as a web page.', 'ETOOLONG');
    }
    w = new BrowserWindow({
      show: false,
      width: 800,
      height: 1100,
      webPreferences: {
        sandbox: true, contextIsolation: true, nodeIntegration: false,
      },
    });
    await withTimeout(
      w.loadURL(`data:text/html;charset=utf-8,${encoded}`),
      PDF_MS,
      'Creating the PDF took too long.',
    );
    return await withTimeout(
      w.webContents.printToPDF({ printBackground: true, pageSize: 'A4' }),
      PDF_MS,
      'Creating the PDF took too long.',
    );
  } finally {
    if (w && !w.isDestroyed()) w.destroy();
  }
}

function copyText(data) {
  const text = typeof data === 'string' ? data : renderExportText(data && typeof data === 'object' ? data : {});
  if (!text.trim()) throw new storage.StorageError('Nothing to copy.', 'EEMPTY');
  if (text.length > 500000) throw new storage.StorageError('That note is too long to copy at once.', 'ETOOLONG');
  clipboard.writeText(text);
  return { copied: true, bytes: Buffer.byteLength(text) };
}

async function shareNote(data = {}) {
  const format = SHARE_FORMATS[data.format] ? data.format : 'html';
  const includeShot = data.includeShot === true;
  const spec = SHARE_FORMATS[format];
  const note = storage.loadNote(activeRoot(), noteId(data.id));
  if (format === 'png') {
    const png = pngBuffer(note.shot);
    if (!png) throw new storage.StorageError('This note has no screenshot to save.', 'ENOSHOT');
    return writeShareFile(note, spec, png);
  }
  const body = format === 'markdown'
    ? renderExportMarkdown(note, { includeShot })
    : renderExportHtml(note, { includeShot });
  if (format === 'pdf') return writeShareFile(note, spec, await htmlToPdf(body));
  return writeShareFile(note, spec, body);
}

async function writeShareFile(note, spec, contents) {
  const result = await dialog.showSaveDialog(win, {
    title: spec.label,
    buttonLabel: 'Save',
    defaultPath: uniqueExportPath(app.getPath('documents'), safeFileName(note.title), spec.ext),
    filters: [spec.filter],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  let target = path.resolve(result.filePath);
  const extRe = new RegExp(`\\.${spec.ext}$`, 'i');
  if (!extRe.test(target)) target += `.${spec.ext}`;
  if (fs.existsSync(target)) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Replace', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `${path.basename(target)} already exists.`,
      detail: 'Replace it with this export?',
    });
    if (response !== 0) return { canceled: true };
  }
  try {
    storage.writeFileAtomic(target, contents);
    const expected = Buffer.isBuffer(contents) ? contents.length : Buffer.byteLength(contents);
    if (fs.statSync(target).size !== expected) throw new Error('The exported file is incomplete.');
  } catch (err) {
    throw new storage.StorageError(`Export failed: ${storage.friendlyFsError(err, path.dirname(target))}`, err.code || 'EEXPORT');
  }
  return { canceled: false, path: target, format: spec.ext };
}

// --- Speech model cache -----------------------------------------------------

function whisperOnnxPath(cacheDir) {
  return path.join(cacheDir, 'Xenova', 'whisper-tiny.en', 'onnx', 'encoder_model.onnx');
}

function resolveCacheDir() {
  const userDir = path.join(app.getPath('userData'), 'models');
  const userCache = realWhisperCacheDir(userDir);
  if (userCache) return userCache;
  const bundled = path.join(__dirname, 'node_modules', '@huggingface', 'transformers', '.cache');
  const bundledCache = realWhisperCacheDir(bundled);
  if (bundledCache) return bundledCache;
  fs.mkdirSync(userDir, { recursive: true });
  return userDir;
}

function whisperIsCached() {
  return fs.existsSync(whisperOnnxPath(resolveCacheDir()));
}

// --- Floating launcher ------------------------------------------------------

function positionBubble() {
  if (!bubble || bubble.isDestroyed()) return;
  const area = screen.getPrimaryDisplay().workArea;
  bubble.setPosition(area.x + area.width - 80, area.y + area.height - 80);
}

function syncBubble() {
  if (!bubble || bubble.isDestroyed()) return;
  if (capturing || appQuitting) {
    bubble.hide();
    return;
  }
  const mainUp = win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
  if (mainUp) {
    bubble.hide();
    return;
  }
  positionBubble();
  bubble.show();
}

function attachWindowGuards() {
  win.on('show', syncBubble);
  win.on('hide', syncBubble);
  win.on('minimize', syncBubble);
  win.on('restore', syncBubble);
  // The renderer blocks unload while a draft is unsaved; ask before discarding it.
  win.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Discard and close', 'Keep editing'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved note',
      message: 'You have a note that has not been saved.',
      detail: 'Close Notely and discard it?',
    });
    if (choice === 0) event.preventDefault();
  });
  win.on('closed', () => {
    win = null;
    appQuitting = true;
    if (bubble && !bubble.isDestroyed()) bubble.destroy();
  });
}

// --- Screen capture and OCR -------------------------------------------------

async function capturePng() {
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  let width = Math.round(display.size.width * scale);
  let height = Math.round(display.size.height * scale);
  const maxEdge = 2560;
  const edge = Math.max(width, height);
  if (edge > maxEdge) {
    const ratio = maxEdge / edge;
    width = Math.round(width * ratio);
    height = Math.round(height * ratio);
  }

  capturing = true;
  syncBubble();
  const wasVisible = win && !win.isDestroyed() && win.isVisible();
  try {
    if (wasVisible) win.hide();
    if (bubble && !bubble.isDestroyed()) bubble.hide();
    await new Promise((r) => setTimeout(r, 250));

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
    });
    const displayId = String(display.id);
    const source = sources.find((s) => String(s.display_id) === displayId) || sources[0];
    if (!source) throw new Error('No screen is available to capture.');
    const image = source.thumbnail;
    if (!image || image.isEmpty()) {
      throw new Error('The screenshot was empty. Allow screen recording for Notely in Windows Settings, then try again.');
    }
    const size = image.getSize();
    // OCR reads the full-resolution image; the preview and saved copy are smaller.
    const shot = size.width > 1600 ? image.resize({ width: 1600, quality: 'better' }) : image;
    return { ocrPng: image.toPNG(), shotPng: shot.toPNG(), width: size.width, height: size.height };
  } finally {
    capturing = false;
    if (wasVisible && win && !win.isDestroyed()) win.show();
    syncBubble();
  }
}

async function ensureOcrWorker() {
  if (ocrWorker) return ocrWorker;
  const Tesseract = require('tesseract.js');
  const tessRoot = path.dirname(require.resolve('tesseract.js/package.json'));
  const options = tessCreateWorkerOptions({
    appRoot: __dirname,
    tesseractRoot: tessRoot,
    resourcesPath: process.resourcesPath,
  });
  ocrWorker = await Tesseract.createWorker('eng', 1, {
    ...options,
    logger: () => {},
    errorHandler: (err) => {
      console.error('Tesseract worker error:', err);
    },
  });
  return ocrWorker;
}

async function runOcr(png) {
  let timer;
  try {
    const worker = await ensureOcrWorker();
    const { data } = await Promise.race([
      worker.recognize(png, {}, { text: true, blocks: true, hocr: false, tsv: false }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Reading the screen timed out. Try capturing again.')), 60000);
      }),
    ]);
    return data;
  } catch (err) {
    if (ocrWorker) {
      ocrWorker.terminate().catch(() => {});
      ocrWorker = null;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// --- Capture flow and optional local AI --------------------------------------

function stopOcr() {
  if (!ocrWorker) return;
  ocrWorker.terminate().catch(() => {});
  ocrWorker = null;
}

let settingsStore;
const settings = () => {
  if (!settingsStore) settingsStore = createSettingsStore({ dir: app.getPath('userData'), safeStorage });
  return settingsStore;
};
const gemini = createGeminiProvider({
  getKey: () => settings().getGeminiKey(),
  getModel: () => settings().load().geminiModel,
});

// Read fresh for every request, so a changed provider or revoked consent applies immediately.
function aiContext() {
  const s = settings().load();
  return {
    provider: s.provider, ollama: ai, gemini, consent: s.consent.granted,
  };
}

const captureFlow = createCaptureFlow({
  grab: capturePng,
  ocr: runOcr,
  summarize: (input, signal) => summarizeCapture(input, aiContext(), { signal }),
  send,
  stopOcr,
});

function regenerate(data = {}) {
  let image = null;
  if (data.shot != null) {
    image = pngFromDataUrl(data.shot);
    if (!image || image.length > 25 * 1024 * 1024) throw new storage.StorageError('The screenshot could not be read.', 'EINVAL');
  }
  return summarizeTextWith({ raw: data.raw, ocr: data.ocr, image }, aiContext());
}

async function testGemini(data = {}) {
  try {
    const key = typeof data.apiKey === 'string' ? data.apiKey.trim() : '';
    const model = typeof data.model === 'string' && data.model.trim() ? data.model.trim() : undefined;
    if (model && !/^[a-z0-9][a-z0-9.-]{1,63}$/.test(model)) throw new SettingsError('That model name is not valid.', 'EMODEL');
    const r = await gemini.testConnection({ key, model });
    return { ok: true, message: `Connected to Gemini. Model ${r.model} is available.` };
  } catch (err) {
    if (err instanceof GeminiError || err instanceof SettingsError) return { ok: false, message: err.message, code: err.code };
    throw err;
  }
}

// --- Speech -----------------------------------------------------------------

async function transcribe(event, samples) {
  const arr = samples instanceof Float32Array ? samples : Float32Array.from(samples || []);
  if (arr.length < 1600) throw new Error('Recording was too short. Speak for a second, then stop.');
  if (arr.length > 16000 * 90) throw new Error('Recording is too long. Keep it under 90 seconds.');

  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = resolveCacheDir();
  const cached = fs.existsSync(whisperOnnxPath(env.cacheDir));
  send('asr', { phase: cached ? 'transcribing' : 'download', cached });

  if (!asr) {
    asr = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
      dtype: 'fp32',
    });
  }
  send('asr', { phase: 'transcribing', cached: true });
  const result = await asr(arr, { sampling_rate: 16000 });
  const text = String(result && result.text ? result.text : '').trim();
  send('asr', { phase: 'done', cached: true });
  return text;
}

// --- IPC --------------------------------------------------------------------

// Every handler returns { ok, data } or { ok: false, error, code } so the
// renderer gets readable messages instead of Electron's wrapped errors.
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, arg) => {
    try {
      return { ok: true, data: await fn(arg, event) };
    } catch (err) {
      if (!(err instanceof storage.StorageError || err instanceof SettingsError || err instanceof GeminiError)) console.error(`[${channel}]`, err);
      return { ok: false, error: (err && err.message) || 'Something went wrong.', code: err && err.code };
    }
  });
}

function noteId(id) {
  if (typeof id !== 'string') throw new storage.StorageError('Invalid note id.', 'EINVAL');
  return id;
}

function registerIpc() {
  ipcMain.on('open', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    syncBubble();
  });
  handle('capture', () => captureFlow.start());
  handle('cancel', () => ({ cancelled: captureFlow.cancel() }));
  handle('polish', (data) => regenerate(data || {}));
  handle('settings-get', () => settings().getPublic());
  handle('settings-save', (data) => settings().save(data && typeof data === 'object' ? {
    provider: data.provider,
    geminiModel: data.geminiModel,
    consent: typeof data.consent === 'boolean' ? data.consent : undefined,
    apiKey: typeof data.apiKey === 'string' ? data.apiKey : undefined,
    removeKey: data.removeKey === true,
  } : {}));
  handle('settings-test', (data) => testGemini(data || {}));
  handle('transcribe', (samples) => transcribe(null, samples));
  handle('save', (data) => storage.saveNote(activeRoot(), data));
  handle('list', () => storage.listNotes(activeRoot()));
  handle('note', (id) => storage.loadNote(activeRoot(), noteId(id)));
  handle('delete', (id) => storage.deleteNote(activeRoot(), noteId(id)));
  handle('star', (data) => storage.setStarred(activeRoot(), noteId(data && data.id), data && data.starred));
  handle('export', (data) => shareNote(data && typeof data === 'object' ? data : { id: data }));
  handle('copy-text', (data) => copyText(data));
  handle('caps', async () => ({
    ai: await localAiStatus(settings().load().provider, ai),
    settings: settings().getPublic(),
    shortcut: { ...shortcutStatus },
    storage: { ...checkStorage() },
    imported: { count: importInfo.count, from: importInfo.from, failed: importInfo.failed.length },
    whisperCached: whisperIsCached(),
  }));
}

function createMainWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#F7F4FB',
    webPreferences: prefs,
  });
  win.setMenuBarVisibility(false);
  harden(win.webContents);
  win.webContents.on('did-fail-load', (_event, code, desc, url) => {
    console.error('Window failed to load:', code, desc, url);
  });
  win.webContents.on('console-message', (_event, level, message, line, source) => {
    if (level >= 2) console.error('Renderer:', message, source, line);
  });
  win.webContents.on('did-finish-load', () => {
    console.log('Notely window ready');
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  attachWindowGuards();
}

function createBubble() {
  bubble = new BrowserWindow({
    width: 64,
    height: 64,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    webPreferences: prefs,
  });
  harden(bubble.webContents);
  bubble.setIgnoreMouseEvents(false);
  bubble.loadFile(path.join(__dirname, 'bubble.html'));
  positionBubble();
}

app.whenReady().then(() => {
  if (checkStorage().ok) {
    try {
      importOldNotes();
    } catch (err) {
      console.error('Importing older notes failed:', err);
      importInfo.failed.push(String(err.message || err));
    }
  } else {
    console.error(storeStatus.error);
  }
  registerIpc();
  createMainWindow();
  createBubble();
  shortcutStatus = registerShortcut(globalShortcut, CAPTURE_SHORTCUT, () => captureFlow.onHotkey());
  syncBubble();
});

app.on('before-quit', () => {
  appQuitting = true;
});

app.on('will-quit', () => {
  unregisterShortcut(globalShortcut, CAPTURE_SHORTCUT);
  captureFlow.cancel();
  stopOcr();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
