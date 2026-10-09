'use strict';

// One screen capture at a time: grab the screen, show the screenshot right away,
// then OCR → clean → notes → optional AI summary. The screenshot is sent before
// any text processing, so OCR or summary failures never lose it.

const { processOcr, composeDetails, fallbackTitle } = require('./notes-pipeline');
const { typeLabel } = require('./summarizer');

class CaptureCancelled extends Error {
  constructor() {
    super('Reading was cancelled.');
    this.code = 'ECANCELLED';
  }
}

function friendlyCaptureError(err) {
  const msg = String((err && err.message) || '');
  let text;
  if (/permission|denied|not allowed|empty/i.test(msg)) {
    text = 'Notely could not capture the screen. Allow screen capture for Notely in your system privacy settings, then try again.';
  } else if (/no screen/i.test(msg)) {
    text = 'No screen is available to capture.';
  } else {
    text = 'Screen capture failed. Try again.';
  }
  const out = new Error(text);
  out.code = 'ECAPTURE';
  return out;
}

function friendlyOcrError(err) {
  const msg = String((err && err.message) || '');
  return /timed out/i.test(msg) ? 'Reading the screen took too long.' : 'Text could not be read from this screenshot.';
}

function createCaptureFlow({
  grab, ocr, summarize, send, stopOcr = () => {}, analyze = processOcr, now = Date.now, log = console,
}) {
  let job = null;
  let hotkeyAt = 0;

  async function run(current, shot) {
    const { capturedAt } = current;
    const cancelled = new Promise((_, reject) => { current.reject = reject; });
    cancelled.catch(() => {});
    const guard = (p) => {
      Promise.resolve(p).catch(() => {});
      return Promise.race([p, cancelled]);
    };
    try {
      send('progress', { stage: 'ocr' });
      const data = await guard(ocr(shot.ocrPng));
      send('progress', { stage: 'clean' });
      const result = analyze(data, { width: shot.width, height: shot.height });
      const notes = result.notes;
      // The summarizer decides what to do with low-content screens (an image model can still read them).
      let summary;
      send('progress', { stage: 'summarize' });
      try {
        summary = await guard(summarize({ cleanText: result.cleanText, notes, image: shot.shotPng }, current.abort.signal));
      } catch (err) {
        if (err instanceof CaptureCancelled) throw err;
        log.error('Summarizing failed', err && err.message);
        summary = {
          method: 'rules', title: notes.title, points: notes.keyPoints, reason: 'failed', detail: 'The summary step failed.',
        };
      }
      const ai = summary.method === 'ai';
      const type = (ai && summary.contentType) || notes.type;
      send('ocr', {
        ok: true,
        capturedAt,
        rawText: result.rawText,
        cleanText: result.cleanText,
        stats: result.stats,
        contentType: type,
        contentLabel: typeLabel(type),
        method: summary.method,
        provider: summary.provider || '',
        model: summary.model || '',
        aiReason: summary.reason || null,
        aiDetail: summary.detail || '',
        lowContent: notes.lowContent && !(ai && summary.points.length),
        note: {
          title: summary.title || fallbackTitle(new Date(capturedAt)),
          points: summary.points,
          details: ai && summary.details ? summary.details : composeDetails(notes, notes.type),
        },
      });
    } catch (err) {
      if (err instanceof CaptureCancelled) {
        send('ocr', { ok: false, cancelled: true, capturedAt, error: 'Reading was cancelled. The screenshot is kept.' });
      } else {
        log.error('OCR failed', err);
        send('ocr', { ok: false, capturedAt, error: friendlyOcrError(err) });
      }
    } finally {
      if (job === current) job = null;
    }
  }

  // Resolves once the screenshot is taken; text processing continues in the background.
  async function start() {
    if (job) {
      const err = new Error('A capture is already in progress. Wait for it to finish, or cancel it.');
      err.code = 'EBUSY';
      throw err;
    }
    hotkeyAt = 0;
    const current = { capturedAt: 0, abort: new AbortController(), reject: null, done: null };
    job = current;
    let shot;
    try {
      send('progress', { stage: 'capture' });
      shot = await grab();
    } catch (err) {
      job = null;
      log.error('Screen capture failed', err);
      throw friendlyCaptureError(err);
    }
    current.capturedAt = now();
    send('shot', { dataUrl: `data:image/png;base64,${shot.shotPng.toString('base64')}`, capturedAt: current.capturedAt });
    current.done = run(current, shot);
    return { capturedAt: current.capturedAt };
  }

  function cancel() {
    if (!job || !job.reject) return false;
    job.abort.abort();
    job.reject(new CaptureCancelled());
    try { stopOcr(); } catch (err) { log.error('Stopping OCR failed', err); }
    return true;
  }

  // The renderer starts hotkey captures so it can protect an unsaved draft first.
  // Repeated presses while one is starting or running do not queue more captures.
  function onHotkey() {
    if (job) {
      send('notice', { message: 'A capture is already in progress.' });
      return false;
    }
    if (hotkeyAt && now() - hotkeyAt < 3000) return false;
    hotkeyAt = now();
    send('hotkey', {});
    return true;
  }

  return {
    start,
    cancel,
    onHotkey,
    busy: () => !!job,
    whenIdle: () => (job && job.done ? job.done : Promise.resolve()),
  };
}

// Registers the global capture shortcut once. If another app owns it, Electron
// does not intercept it and Notely reports that the button must be used instead.
function registerShortcut(globalShortcut, accelerator, handler, log = console) {
  if (globalShortcut.isRegistered(accelerator)) globalShortcut.unregister(accelerator);
  let ok = false;
  try {
    ok = globalShortcut.register(accelerator, () => {
      try {
        handler();
      } catch (err) {
        log.error('Capture shortcut failed', err);
      }
    });
  } catch (err) {
    log.error('Registering the capture shortcut failed', err);
    ok = false;
  }
  if (!ok) log.warn(`Could not register ${accelerator}; it may be used by another app.`);
  return {
    ok,
    accelerator,
    error: ok ? '' : 'Ctrl+Shift+S is used by another app, so Notely cannot listen for it. Use the Capture screen button instead.',
  };
}

function unregisterShortcut(globalShortcut, accelerator) {
  if (globalShortcut.isRegistered(accelerator)) globalShortcut.unregister(accelerator);
}

module.exports = {
  createCaptureFlow, registerShortcut, unregisterShortcut, friendlyCaptureError, CaptureCancelled,
};
