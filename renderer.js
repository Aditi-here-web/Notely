'use strict';

const state = {
  id: null,
  createdAt: 0,
  updatedAt: 0,
  shot: null,
  shotIsNew: false,
  capturedAt: 0,
  ocrText: '',
  ocrClean: '',
  transcript: '',
  pointsEdited: false,
  dirty: false,
  starred: false,
  notes: [],
  store: null,
  filter: 'all',
  query: '',
  busy: false,
  recording: false,
  whisperCached: false,
  stage: 'idle',
  saving: false,
  saveError: false,
  reading: false,
  ai: null,
  settings: null,
};

let rec = null;
let recStream = null;
let chunks = [];

const $ = (id) => document.getElementById(id);

async function api(channel, data) {
  const res = await n.call(channel, data);
  if (res && res.ok) return res.data;
  const err = new Error((res && res.error) || 'Something went wrong.');
  err.code = res && res.code;
  throw err;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function say(text, kind) {
  const el = $('msg');
  el.textContent = text || '';
  el.className = kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : 'muted';
}

function formatTime(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

const STEP_ORDER = ['capture', 'ocr', 'clean', 'review', 'saved'];

function setStage(stage, failed) {
  state.stage = stage;
  const active = stage === 'summarize' ? 'clean' : stage;
  const idx = STEP_ORDER.indexOf(active);
  for (const li of $('steps').children) {
    const i = STEP_ORDER.indexOf(li.dataset.step);
    li.className = '';
    if (idx < 0) continue;
    if (i < idx || (stage === 'saved' && i === idx)) li.className = 'done';
    else if (i === idx) li.className = failed ? 'failed' : 'active';
  }
}

function setBusy(busy) {
  state.busy = busy;
  const locked = busy || state.recording;
  // While the screen is being read, the Capture button cancels the reading instead.
  const cancelMode = busy && state.reading;
  $('capture').disabled = locked && !cancelMode;
  $('capture').textContent = cancelMode ? 'Cancel reading' : 'Capture screen';
  $('capture').classList.toggle('l', cancelMode);
  $('capture').classList.toggle('p', !cancelMode);
  $('refresh').disabled = locked;
  $('save').disabled = locked || !(state.store && state.store.ok);
  $('export').disabled = locked;
  $('starNote').disabled = locked;
  $('newNote').disabled = locked;
  $('remove').disabled = locked;
  $('more').disabled = locked;
  if (locked) closeMenu(false);
  $('mic').disabled = busy && !state.recording;
  for (const b of $('list').querySelectorAll('button')) b.disabled = locked;
}

function markDirty() {
  if (state.saveError) {
    state.saveError = false;
    renderBadge();
  }
  if (!state.dirty) {
    state.dirty = true;
    renderBadge();
    if (state.stage === 'saved') setStage('review');
  }
}

function confirmDiscard(action) {
  if (!state.dirty) return true;
  return window.confirm(`You have unsaved changes in this note. ${action}`);
}

function getPoints() {
  return $('points').value
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-•*]|\d{1,2}[.)])\s+/, '').trim())
    .filter(Boolean);
}

function setPoints(points) {
  $('points').value = (points || []).join('\n');
  state.pointsEdited = false;
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

// --- Rendering ----------------------------------------------------------------

function renderShot() {
  const img = $('shot');
  if (state.shot) {
    if (img.getAttribute('src') !== state.shot) img.src = state.shot;
    $('zoomShot').hidden = false;
    $('shotEmpty').hidden = true;
  } else {
    img.removeAttribute('src');
    $('zoomShot').hidden = true;
    $('shotEmpty').textContent = 'Captured screen will appear here.';
    $('shotEmpty').hidden = false;
  }
}

$('shot').addEventListener('error', () => {
  if (!state.shot) return;
  $('zoomShot').hidden = true;
  $('shotEmpty').textContent = 'This screenshot could not be displayed. The rest of the note is unaffected.';
  $('shotEmpty').hidden = false;
});

// --- Screenshot viewer ------------------------------------------------------
// Shows the note's stored screenshot (the same data URL as the preview); nothing
// is copied or saved, and the note itself is never touched.

const viewer = {
  scale: 1, fit: 1, x: 0, y: 0, w: 0, h: 0, drag: null, opener: null, cleanups: [],
};
const VIEW_MIN = 0.05;
const VIEW_MAX = 8;

function viewerStageSize() {
  const r = $('viewerStage').getBoundingClientRect();
  return { sw: r.width, sh: r.height };
}

function applyView() {
  const { sw, sh } = viewerStageSize();
  const w = viewer.w * viewer.scale;
  const h = viewer.h * viewer.scale;
  // Centered when smaller than the stage; otherwise panning stops at the image edges.
  viewer.x = w <= sw ? (sw - w) / 2 : Math.min(0, Math.max(sw - w, viewer.x));
  viewer.y = h <= sh ? (sh - h) / 2 : Math.min(0, Math.max(sh - h, viewer.y));
  const img = $('viewerImg');
  img.style.width = `${w}px`;
  img.style.height = `${h}px`;
  img.style.transform = `translate(${viewer.x}px, ${viewer.y}px)`;
  $('viewerStage').classList.toggle('pannable', w > sw + 1 || h > sh + 1);
  $('vZoom').textContent = `${Math.round(viewer.scale * 100)}%`;
  $('vZoomOut').disabled = viewer.scale <= VIEW_MIN + 1e-6;
  $('vZoomIn').disabled = viewer.scale >= VIEW_MAX - 1e-6;
}

// Zooms keeping the image point under (cx, cy) in place; defaults to the stage center.
function zoomTo(scale, cx, cy) {
  const { sw, sh } = viewerStageSize();
  const px = cx == null ? sw / 2 : cx;
  const py = cy == null ? sh / 2 : cy;
  const next = Math.min(VIEW_MAX, Math.max(VIEW_MIN, scale));
  const ix = (px - viewer.x) / viewer.scale;
  const iy = (py - viewer.y) / viewer.scale;
  viewer.scale = next;
  viewer.x = px - ix * next;
  viewer.y = py - iy * next;
  applyView();
}

function fitView() {
  const { sw, sh } = viewerStageSize();
  viewer.fit = Math.min(1, (sw - 32) / viewer.w, (sh - 32) / viewer.h);
  viewer.scale = Math.max(VIEW_MIN, viewer.fit);
  applyView();
}

function openViewer() {
  if (!state.shot || !$('viewer').hidden) return;
  viewer.opener = document.activeElement;
  const img = $('viewerImg');
  $('viewerError').hidden = true;
  img.hidden = true;
  $('viewer').hidden = false;
  requestAnimationFrame(() => $('viewer').classList.add('open'));
  const listen = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    viewer.cleanups.push(() => target.removeEventListener(type, fn, opts));
  };
  listen(document, 'keydown', onViewerKey, true);
  listen(window, 'resize', () => { if (viewer.w) fitView(); });
  img.onload = () => {
    viewer.w = img.naturalWidth;
    viewer.h = img.naturalHeight;
    img.hidden = false;
    fitView();
  };
  img.onerror = () => {
    viewer.w = 0;
    img.hidden = true;
    $('viewerError').hidden = false;
  };
  img.src = state.shot;
  $('vClose').focus();
}

function closeViewer() {
  if ($('viewer').hidden) return;
  for (const off of viewer.cleanups.splice(0)) off();
  const img = $('viewerImg');
  img.onload = null;
  img.onerror = null;
  img.removeAttribute('src');
  img.removeAttribute('style');
  Object.assign(viewer, { w: 0, h: 0, drag: null });
  $('viewer').classList.remove('open');
  $('viewer').hidden = true;
  const back = viewer.opener;
  viewer.opener = null;
  if (back && document.contains(back) && !back.hidden) back.focus();
}

function onViewerKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeViewer();
    return;
  }
  if (e.key === 'Tab') {
    const items = [...$('viewer').querySelectorAll('button:not(:disabled)')];
    const i = items.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); items[items.length - 1].focus(); }
    else if (!e.shiftKey && i === items.length - 1) { e.preventDefault(); items[0].focus(); }
    return;
  }
  if (!viewer.w || e.ctrlKey || e.metaKey || e.altKey) return;
  const step = 60;
  const keys = {
    '+': () => zoomTo(viewer.scale * 1.25),
    '=': () => zoomTo(viewer.scale * 1.25),
    '-': () => zoomTo(viewer.scale / 1.25),
    0: () => zoomTo(1),
    f: fitView,
    F: fitView,
    ArrowLeft: () => { viewer.x += step; applyView(); },
    ArrowRight: () => { viewer.x -= step; applyView(); },
    ArrowUp: () => { viewer.y += step; applyView(); },
    ArrowDown: () => { viewer.y -= step; applyView(); },
  };
  if (keys[e.key]) {
    e.preventDefault();
    keys[e.key]();
  }
}

$('zoomShot').addEventListener('click', openViewer);
$('vClose').addEventListener('click', closeViewer);
$('vZoomIn').addEventListener('click', () => zoomTo(viewer.scale * 1.25));
$('vZoomOut').addEventListener('click', () => zoomTo(viewer.scale / 1.25));
$('vReset').addEventListener('click', () => zoomTo(1));
$('vFit').addEventListener('click', fitView);
$('viewerStage').addEventListener('wheel', (e) => {
  e.preventDefault();
  if (!viewer.w) return;
  const r = $('viewerStage').getBoundingClientRect();
  zoomTo(viewer.scale * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });
$('viewerStage').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  // A press on the backdrop (not the image) may close the viewer on release.
  viewer.drag = {
    id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: viewer.x, oy: viewer.y, moved: false, onImage: e.target === $('viewerImg'),
  };
  if (viewer.drag.onImage) {
    e.preventDefault();
    try {
      $('viewerStage').setPointerCapture(e.pointerId);
    } catch { /* pointer already released */ }
  }
});
$('viewerStage').addEventListener('pointermove', (e) => {
  const d = viewer.drag;
  if (!d || d.id !== e.pointerId) return;
  const dx = e.clientX - d.sx;
  const dy = e.clientY - d.sy;
  if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
  if (!d.onImage || !d.moved) return;
  $('viewerStage').classList.add('dragging');
  viewer.x = d.ox + dx;
  viewer.y = d.oy + dy;
  applyView();
});
const endDrag = (e) => {
  const d = viewer.drag;
  if (!d || d.id !== e.pointerId) return;
  viewer.drag = null;
  $('viewerStage').classList.remove('dragging');
  if (e.type === 'pointerup' && !d.onImage && !d.moved && e.target === $('viewerStage')) closeViewer();
};
$('viewerStage').addEventListener('pointerup', endDrag);
$('viewerStage').addEventListener('pointercancel', endDrag);

function renderBadge() {
  const el = $('draftState');
  if (state.saving) {
    el.textContent = 'Saving…';
    el.className = 'badge';
  } else if (state.saveError && state.dirty) {
    el.textContent = 'Not saved';
    el.className = 'badge error';
  } else if (state.dirty) {
    el.textContent = state.id ? 'Unsaved changes' : 'Unsaved draft';
    el.className = 'badge unsaved';
  } else if (state.id) {
    el.textContent = `Saved · ${formatTime(state.updatedAt)}`;
    el.className = 'badge saved';
  } else {
    el.textContent = 'New note';
    el.className = 'badge';
  }
}

// The title is a one-line textarea so long titles wrap instead of being clipped.
function fitTitle() {
  const el = $('title');
  el.style.height = 'auto';
  const border = el.offsetHeight - el.clientHeight;
  el.style.height = `${el.scrollHeight + border}px`;
}

function setTitle(value) {
  $('title').value = value || '';
  fitTitle();
}

// Every search word must appear in the title, key points or notes (case-insensitive).
function visibleNotes() {
  const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  return state.notes.filter((note) => (state.filter !== 'starred' || note.starred)
    && terms.every((t) => note.search.includes(t)));
}

function renderNotes() {
  const list = $('list');
  const shown = visibleNotes();
  const empty = $('listEmpty');
  if (!shown.length) {
    list.innerHTML = '';
    empty.hidden = false;
    if (!state.notes.length) empty.textContent = 'No saved notes yet. Capture a screen or speak, review the draft, then save.';
    else if (state.query.trim()) empty.textContent = `No ${state.filter === 'starred' ? 'starred ' : ''}notes match "${state.query.trim()}".`;
    else empty.textContent = 'No starred notes yet. Click ☆ on a note to star it.';
    return;
  }
  empty.hidden = true;
  list.innerHTML = shown.map((note) => {
    const current = note.id === state.id ? ' current' : '';
    const count = note.pointCount === 1 ? '1 point' : `${note.pointCount} points`;
    const edited = note.updatedAt && note.updatedAt !== note.createdAt ? `Edited ${formatTime(note.updatedAt)}` : formatTime(note.createdAt);
    const star = note.starred ? '★' : '☆';
    const label = note.starred ? 'Unstar' : 'Star';
    return `<div class="note-row"><button class="card${current}" type="button" data-id="${esc(note.id)}" title="Created ${esc(formatTime(note.createdAt))}">${esc(note.title)}<small>${esc(edited)} · ${count}</small></button>`
      + `<button class="star-btn${note.starred ? ' on' : ''}" type="button" data-star="${esc(note.id)}" aria-pressed="${note.starred}" aria-label="${label} ${esc(note.title)}" title="${label}">${star}</button></div>`;
  }).join('');
  for (const b of list.querySelectorAll('button')) b.disabled = state.busy || state.recording;
}

function renderStore() {
  const s = state.store;
  $('dirError').hidden = !(s && !s.ok);
  $('dirError').textContent = s && !s.ok ? s.error : '';
  $('folderCard').classList.toggle('warn', !!(s && !s.ok));
}

function renderStar() {
  const btn = $('starNote');
  btn.hidden = !state.id;
  btn.textContent = state.starred ? '★' : '☆';
  btn.classList.toggle('on', state.starred);
  btn.setAttribute('aria-pressed', String(state.starred));
  btn.title = state.starred ? 'Unstar this note' : 'Star this note';
}

function render() {
  renderShot();
  renderBadge();
  renderNotes();
  renderStore();
  renderStar();
  $('remove').hidden = !state.id;
  $('export').hidden = !state.id;
  $('menuSep').hidden = !state.id;
  $('mic').textContent = state.recording ? 'Stop speaking' : 'Start speaking';
  $('mic').classList.toggle('live', state.recording);
  setBusy(state.busy);
}

// --- Draft management -----------------------------------------------------

function clearDraft() {
  Object.assign(state, {
    id: null,
    createdAt: 0,
    updatedAt: 0,
    shot: null,
    shotIsNew: false,
    capturedAt: 0,
    ocrText: '',
    ocrClean: '',
    transcript: '',
    starred: false,
    dirty: false,
    saveError: false,
  });
  setTitle('');
  $('raw').value = '';
  setPoints([]);
  $('ptsNote').textContent = 'Capture a screen or speak to generate key points. You can also type them, one per line.';
  setStage('idle');
  render();
}

function applyNote(note) {
  Object.assign(state, {
    id: note.id,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    shot: note.shot,
    shotIsNew: false,
    capturedAt: note.capturedAt || 0,
    ocrText: note.ocrText || '',
    ocrClean: note.ocrClean || '',
    transcript: note.transcript || '',
    starred: !!note.starred,
    dirty: false,
    saveError: false,
  });
  setTitle(note.title);
  $('raw').value = note.raw || '';
  setPoints(note.points);
  $('ptsNote').textContent = `Saved note · created ${formatTime(note.createdAt)}`;
  setStage('saved');
  render();
}

async function loadNotes() {
  try {
    const caps = await api('caps');
    state.store = caps.storage;
    state.whisperCached = !!caps.whisperCached;
    state.ai = caps.ai || null;
    state.settings = caps.settings || null;
    $('modelHint').hidden = state.whisperCached;
    renderStore();
    if (!state.store.ok) {
      state.notes = [];
      renderNotes();
      say(state.store.error, 'err');
      setBusy(state.busy);
      return;
    }
    const result = await api('list');
    state.notes = result.notes;
    renderNotes();
    if (result.unreadable.length) {
      say(`${result.unreadable.length} saved note(s) could not be read and are not shown.`, 'err');
    }
    return caps;
  } catch (err) {
    say(err.message || 'Could not load saved notes.', 'err');
  } finally {
    setBusy(state.busy);
  }
}

async function openNote(id) {
  if (id === state.id && !state.dirty) return;
  if (!confirmDiscard('Open another note and discard them?')) return;
  try {
    setBusy(true);
    const note = await api('note', id);
    applyNote(note);
    say('');
  } catch (err) {
    say(err.message || 'Could not open that note.', 'err');
    await loadNotes();
  } finally {
    setBusy(false);
  }
}

// --- Screen capture ---------------------------------------------------------

async function capture(fromHotkey) {
  if (state.busy || state.recording) {
    say('Please wait for the current task to finish.', 'err');
    return;
  }
  if (state.dirty) {
    if (fromHotkey) n.open();
    if (!confirmDiscard('Capturing starts a new draft. Discard the current changes?')) return;
  }
  try {
    setBusy(true);
    setStage('capture');
    say('Step 1 of 4: capturing the screen...');
    await api('capture');
  } catch (err) {
    setStage('capture', true);
    say(err.message || 'Screen capture failed.', 'err');
    if (fromHotkey) n.open();
    setBusy(false);
  }
}

async function cancelReading() {
  if (!state.reading) return;
  try {
    await api('cancel');
  } catch (err) {
    say(err.message || 'Could not cancel.', 'err');
  }
}

// Says where the key points came from; never calls rule-based output "AI".
function sourceNote(result, contentLabel) {
  const kind = contentLabel ? ` Detected: ${contentLabel}.` : '';
  if (result.method === 'ai' && result.provider === 'Gemini') {
    return `Analyzed by Google Gemini (${result.model}) from the screenshot, in the cloud.${kind} Check and edit as needed.`;
  }
  if (result.method === 'ai') {
    return `Summarized by local AI (${result.model || 'Ollama'}) from the screen text, on this computer.${kind} Edit as needed.`;
  }
  const reasons = {
    unavailable: ' AI summary unavailable: no local AI model found.',
    disabled: ' AI is turned off in Settings.',
    ungrounded: ' The local AI answer did not match the screen text, so it was not used.',
    'no-consent': ' Gemini is selected, but cloud processing has not been agreed to in Settings; nothing was sent.',
    'no-key': ' Gemini is selected, but no usable API key is saved in Settings; nothing was sent.',
  };
  let reason = reasons[result.reason] || '';
  if (result.reason === 'failed') {
    reason = result.provider === 'Gemini' || /^Gemini:/.test(result.detail || '')
      ? ` ${result.detail || 'Gemini failed.'} Rule-based extraction was used instead.`
      : ' The local AI failed, so rule-based extraction was used.';
  }
  return `Extracted with rules, not AI.${kind}${reason} Edit as needed.`;
}

const geminiOn = () => !!(state.settings && state.settings.provider === 'gemini');

n.on('notice', (info) => {
  if (info && info.message) say(info.message, 'err');
});

n.on('shot', (payload) => {
  const dataUrl = payload && typeof payload === 'object' ? payload.dataUrl : payload;
  Object.assign(state, {
    id: null,
    createdAt: 0,
    updatedAt: 0,
    shot: dataUrl,
    shotIsNew: true,
    capturedAt: (payload && payload.capturedAt) || Date.now(),
    ocrText: '',
    ocrClean: '',
    transcript: '',
    dirty: true,
    saveError: false,
    reading: true,
  });
  closeViewer();
  setTitle('');
  $('raw').value = '';
  setPoints([]);
  $('ptsNote').textContent = 'Reading the screen...';
  setStage('ocr');
  render();
  setBusy(true);
  n.open();
  say('Step 2 of 4: reading text from the screenshot... (Cancel reading keeps the screenshot.)');
});

n.on('progress', (info) => {
  if (!info || !state.busy) return;
  if (info.stage === 'clean') {
    setStage('clean');
    say('Step 3 of 4: removing browser, sidebar and duplicate text...');
  } else if (info.stage === 'summarize') {
    setStage('summarize');
    say(geminiOn()
      ? 'Step 3 of 4: sending the screenshot to Google Gemini for analysis...'
      : 'Step 3 of 4: building notes from the main content...');
  }
});

n.on('ocr', (payload) => {
  if (!payload || payload.capturedAt !== state.capturedAt) return;
  state.reading = false;
  setBusy(false);
  if (!payload.ok) {
    if (payload.cancelled) {
      setStage('review');
      $('ptsNote').textContent = 'Reading was cancelled. Type your own key points, or capture again.';
      say('Reading cancelled. The screenshot is kept; you can still save it as a note.', 'ok');
      return;
    }
    setStage('ocr', true);
    $('ptsNote').textContent = 'Text could not be read from this screenshot. The screenshot is kept.';
    say(`${payload.error} The screenshot is kept: type your own notes and save, or capture again.`, 'err');
    return;
  }
  state.ocrText = payload.rawText || '';
  state.ocrClean = payload.cleanText || '';
  setStage('review');
  if (payload.lowContent) {
    $('ptsNote').textContent = 'No main content was found on this screen. The screenshot is kept.';
    say('Could not find meaningful content on this screen. Try capturing again, or type your own notes.', 'err');
    return;
  }
  const note = payload.note;
  // Anything typed while the screen was being read is kept.
  if (!$('title').value.trim()) setTitle(note.title);
  const keptPoints = state.pointsEdited && getPoints().length;
  if (!keptPoints) setPoints(note.points);
  if (!$('raw').value.trim()) $('raw').value = note.details || '';
  $('ptsNote').textContent = sourceNote({
    method: payload.method, provider: payload.provider, model: payload.model, reason: payload.aiReason, detail: payload.aiDetail,
  }, payload.contentLabel);
  if (payload.aiReason === 'failed' && payload.provider === 'Gemini') {
    say(`${payload.aiDetail.replace(/^Gemini: (?=.*Gemini)/, '')} Rule-based notes are shown instead; nothing was lost.`, 'err');
    return;
  }
  say(keptPoints
    ? 'Your key points were kept. Click Regenerate key points to replace them with the generated ones.'
    : 'Step 4 of 4: review and edit the draft, then click Save note. Nothing is saved yet.', 'ok');
});

n.on('hotkey', () => capture(true));

// --- Key points -------------------------------------------------------------

async function regeneratePoints() {
  const typed = $('raw').value.trim();
  const screen = state.ocrClean || (state.transcript ? '' : typed);
  const sendShot = geminiOn() && !!state.shot;
  if (!state.transcript && !screen && !sendShot) {
    say('Capture a screen, speak, or type some notes first.', 'err');
    return;
  }
  if (state.pointsEdited && getPoints().length && !window.confirm('Replace the key points you edited?')) return;
  try {
    setBusy(true);
    say(sendShot ? 'Sending the screenshot to Google Gemini...' : 'Generating key points...');
    const result = await api('polish', { raw: state.transcript, ocr: screen, shot: sendShot ? state.shot : undefined });
    if (!result.points.length) {
      say('No key points could be extracted from this content.', 'err');
      return;
    }
    // Only the key points are replaced; the title and Notes & details stay as the user left them.
    setPoints(result.points);
    if (!$('title').value.trim()) setTitle(result.title);
    markDirty();
    $('ptsNote').textContent = sourceNote(result);
    if (result.reason === 'failed' && result.provider === 'Gemini') {
      say(`${result.detail.replace(/^Gemini: (?=.*Gemini)/, '')} Rule-based key points are shown instead.`, 'err');
      return;
    }
    say('Key points updated. Review them, then save.', 'ok');
  } catch (err) {
    say(err.message || 'Could not generate key points.', 'err');
  } finally {
    setBusy(false);
  }
}

// --- Voice ------------------------------------------------------------------

async function toggleMic() {
  if (state.busy && !state.recording) return;
  if (state.recording && rec) {
    rec.stop();
    return;
  }
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    say('Microphone access was blocked. Allow the microphone for Notely in Windows Settings, then try again.', 'err');
    return;
  }
  chunks = [];
  try {
    rec = new MediaRecorder(recStream);
  } catch (err) {
    recStream.getTracks().forEach((t) => t.stop());
    recStream = null;
    say(err.message || 'Could not start the recorder.', 'err');
    return;
  }
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  rec.onerror = () => say('Recording failed.', 'err');
  rec.onstop = finishRecording;
  rec.start();
  state.recording = true;
  setBusy(true);
  render();
  say('Listening... click Stop speaking when you are done.');
}

async function finishRecording() {
  state.recording = false;
  if (recStream) {
    recStream.getTracks().forEach((t) => t.stop());
    recStream = null;
  }
  rec = null;
  render();
  if (!chunks.length) {
    setBusy(false);
    say('No audio was captured. Try speaking again.', 'err');
    return;
  }
  try {
    say(state.whisperCached
      ? 'Transcribing...'
      : 'Downloading the speech model, then transcribing. This can take a few minutes the first time.');
    const blob = new Blob(chunks);
    chunks = [];
    const ctx = new AudioContext();
    const audioBuf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const samples = resampleTo16k(audioBuf.getChannelData(0), audioBuf.sampleRate);
    await ctx.close();
    if (samples.length < 1600) throw new Error('Recording was too short. Speak for a second, then stop.');
    const text = await api('transcribe', samples);
    if (!text) {
      say('Nothing was heard. Try again a little closer to the microphone.', 'err');
      return;
    }
    state.transcript = `${state.transcript} ${text}`.trim();
    const raw = $('raw').value.trim();
    $('raw').value = raw ? `${raw}\n\n${text}` : text;
    markDirty();
    if (state.pointsEdited && getPoints().length) {
      say('Added what you said to the notes. Click Regenerate key points to include it in the key points.', 'ok');
      return;
    }
    const result = await api('polish', { raw: state.transcript, ocr: state.ocrClean });
    if (result.points.length) setPoints(result.points);
    if (!$('title').value.trim()) setTitle(result.title);
    say(result.ai ? 'Key points ready. Review, then save.' : 'Key points ready (rule-based). Review, then save.', 'ok');
  } catch (err) {
    say(err.message || 'Transcription failed.', 'err');
  } finally {
    setBusy(false);
    render();
  }
}

// --- Save / delete ------------------------------------------------

// Resolves true only after the note was written to Notely's storage.
async function save() {
  if (state.busy || state.recording) return false;
  const points = getPoints();
  const raw = $('raw').value.trim();
  if (!points.length && !raw && !state.shot) {
    say('Nothing to save yet.', 'err');
    return false;
  }
  try {
    setBusy(true);
    state.saving = true;
    state.saveError = false;
    renderBadge();
    say('Saving...');
    const result = await api('save', {
      id: state.id,
      baseUpdatedAt: state.updatedAt,
      title: $('title').value.trim(),
      points,
      raw,
      transcript: state.transcript,
      ocrText: state.ocrText,
      ocrClean: state.ocrClean,
      capturedAt: state.capturedAt,
      shot: state.shotIsNew ? state.shot : null,
    });
    Object.assign(state, {
      id: result.id,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
      starred: result.starred,
      shotIsNew: false,
      dirty: false,
      saving: false,
    });
    setTitle(result.title);
    setStage('saved');
    await loadNotes();
    render();
    say(`Saved in Notely · ${formatTime(result.updatedAt)}`, 'ok');
    return true;
  } catch (err) {
    if (err.code === 'EMISSING') {
      Object.assign(state, { id: null, createdAt: 0, updatedAt: 0, shotIsNew: !!state.shot });
      render();
    }
    state.saving = false;
    state.saveError = true;
    renderBadge();
    say(err.message || 'Could not save the note. Nothing was saved.', 'err');
    return false;
  } finally {
    state.saving = false;
    setBusy(false);
  }
}

async function removeNote() {
  if (!state.id) return;
  const title = $('title').value.trim() || 'this note';
  if (!window.confirm(`Delete "${title}"? This cannot be undone. Files you exported earlier are not affected.`)) return;
  try {
    setBusy(true);
    await api('delete', state.id);
    clearDraft();
    await loadNotes();
    say('Note deleted.', 'ok');
  } catch (err) {
    say(err.message || 'Could not delete that note.', 'err');
  } finally {
    setBusy(false);
  }
}

// Star changes only the star flag; unsaved edits in the open note stay as they are.
async function toggleStar(id) {
  const note = state.notes.find((x) => x.id === id);
  const next = !(note ? note.starred : state.starred);
  try {
    setBusy(true);
    await api('star', { id, starred: next });
    if (note) note.starred = next;
    if (id === state.id) state.starred = next;
    renderNotes();
    renderStar();
    say(next ? 'Starred.' : 'Removed star.', 'ok');
  } catch (err) {
    say(err.message || 'Could not change the star.', 'err');
  } finally {
    setBusy(false);
  }
}

// Export writes the saved version of the note to a file the user picks.
async function exportCurrent() {
  if (!state.id) return;
  if (state.dirty) {
    if (!window.confirm('This note has unsaved changes. Save them in Notely before exporting?')) return;
    if (!(await save())) return;
  }
  try {
    setBusy(true);
    say('Choose where to export the note...');
    const result = await api('export', state.id);
    if (result.canceled) say('Export cancelled. The note is still saved in Notely.');
    else say(`Exported to ${result.path}`, 'ok');
  } catch (err) {
    say(`${err.message || 'Export failed.'} The note is still saved in Notely.`, 'err');
  } finally {
    setBusy(false);
  }
}

function setFilter(filter) {
  state.filter = filter;
  $('showAll').classList.toggle('on', filter === 'all');
  $('showStarred').classList.toggle('on', filter === 'starred');
  $('showAll').setAttribute('aria-pressed', String(filter === 'all'));
  $('showStarred').setAttribute('aria-pressed', String(filter === 'starred'));
  renderNotes();
}

let searchTimer = null;
function onSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = $('search').value;
    renderNotes();
  }, 120);
}

function newNote() {
  if (!confirmDiscard('Start a new note and discard them?')) return;
  clearDraft();
  say('New note.');
}

// --- Wiring -----------------------------------------------------------------

n.on('asr', (info) => {
  if (!info) return;
  if (info.cached) state.whisperCached = true;
  $('modelHint').hidden = state.whisperCached;
  if (info.phase === 'download') say('Downloading the free speech model (~150 MB). Later runs work offline...');
  if (info.phase === 'transcribing') say('Transcribing...');
});

n.on('app-error', (info) => {
  setBusy(false);
  say((info && info.message) || 'Something went wrong.', 'err');
});

// --- Settings ---------------------------------------------------------------
// The API key goes from this form to the main process only; it is never read back.

const settingsUi = { opener: null, cleanup: null };

function settingsSay(text, kind) {
  const el = $('settingsMsg');
  el.textContent = text || '';
  el.className = kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : 'muted';
}

const chosenProvider = () => {
  const r = document.querySelector('input[name="provider"]:checked');
  return r ? r.value : 'ollama';
};

function renderSettings(s) {
  $('geminiBox').hidden = chosenProvider() !== 'gemini';
  if (!s) return;
  const where = s.storageBackend ? ` (${s.storageBackend})` : '';
  $('keyState').textContent = !s.secureStorage
    ? 'Secure storage is not available on this system, so a key cannot be saved.'
    : s.keyUnreadable
      ? 'A saved key exists but can no longer be unlocked on this computer or account. Paste your key again to replace it.'
      : s.hasGeminiKey
        ? `A key is saved, encrypted by your operating system${where}. It is never shown. Leave the field empty to keep it, or paste a new key to replace it.`
        : 'No key saved yet. Get one from Google AI Studio.';
  $('geminiKey').placeholder = s.hasGeminiKey ? 'Saved key kept (paste a new key to replace it)' : 'Paste your key from Google AI Studio';
  $('removeKey').hidden = !(s.hasGeminiKey || s.keyUnreadable);
}

async function openSettings() {
  if (!$('settings').hidden) return;
  const active = document.activeElement;
  settingsUi.opener = active && active !== document.body ? active : $('openSettings');
  closeMenu(false);
  let s;
  try {
    s = await api('settings-get');
  } catch (err) {
    say(err.message || 'Could not open Settings.', 'err');
    return;
  }
  state.settings = s;
  for (const r of document.querySelectorAll('input[name="provider"]')) r.checked = r.value === s.provider;
  $('geminiKey').value = '';
  $('geminiModel').value = s.geminiModel;
  $('geminiModel').placeholder = s.defaultGeminiModel;
  $('consent').checked = s.consent.granted;
  settingsSay('');
  renderSettings(s);
  $('settings').hidden = false;
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeSettings();
    } else if (e.key === 'Tab') {
      const items = [...$('settings').querySelectorAll('input, button')].filter((el) => !el.disabled && el.offsetParent !== null);
      const i = items.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); items[items.length - 1].focus(); }
      else if (!e.shiftKey && i === items.length - 1) { e.preventDefault(); items[0].focus(); }
    }
  };
  document.addEventListener('keydown', onKey, true);
  settingsUi.cleanup = () => document.removeEventListener('keydown', onKey, true);
  (document.querySelector('input[name="provider"]:checked') || $('settingsCancel')).focus();
}

function closeSettings() {
  if ($('settings').hidden) return;
  $('geminiKey').value = '';
  if (settingsUi.cleanup) settingsUi.cleanup();
  settingsUi.cleanup = null;
  $('settings').hidden = true;
  const back = settingsUi.opener;
  settingsUi.opener = null;
  if (back && document.contains(back)) back.focus();
}

async function saveSettings(e) {
  e.preventDefault();
  const provider = chosenProvider();
  if (provider === 'gemini' && !$('consent').checked) {
    settingsSay('To use Gemini, tick the box to agree to sending screenshots to Google.', 'err');
    $('consent').focus();
    return;
  }
  $('settingsSave').disabled = true;
  try {
    const s = await api('settings-save', {
      provider,
      geminiModel: $('geminiModel').value.trim(),
      consent: $('consent').checked,
      apiKey: $('geminiKey').value.trim() || undefined,
    });
    state.settings = s;
    closeSettings();
    const label = { rules: 'rules only (no AI)', ollama: 'local AI when available, otherwise rules', gemini: `Google Gemini (${s.geminiModel}) in the cloud` }[s.provider];
    say(`Settings saved. New notes will use ${label}.`, 'ok');
  } catch (err) {
    settingsSay(err.message || 'Could not save settings.', 'err');
  } finally {
    $('settingsSave').disabled = false;
  }
}

async function testConnection() {
  $('testConn').disabled = true;
  settingsSay('Testing the connection to Gemini... (no screenshot is sent)');
  try {
    const r = await api('settings-test', { apiKey: $('geminiKey').value.trim() || undefined, model: $('geminiModel').value.trim() || undefined });
    settingsSay(r.message, r.ok ? 'ok' : 'err');
  } catch (err) {
    settingsSay(err.message || 'The connection test failed.', 'err');
  } finally {
    $('testConn').disabled = false;
  }
}

async function removeKey() {
  if (!window.confirm('Remove the saved Gemini API key from this computer?')) return;
  try {
    // Keep the saved choice; only a saved Gemini choice has to change, since it needs the key.
    const saved = state.settings ? state.settings.provider : 'ollama';
    const provider = saved === 'gemini' ? 'ollama' : saved;
    const s = await api('settings-save', { provider, removeKey: true });
    state.settings = s;
    for (const r of document.querySelectorAll('input[name="provider"]')) r.checked = r.value === s.provider;
    renderSettings(s);
    settingsSay(saved === 'gemini'
      ? 'Key removed. Gemini is off; Notely now uses Local AI (Ollama) when installed, otherwise rules.'
      : 'Key removed.', 'ok');
  } catch (err) {
    settingsSay(err.message || 'Could not remove the key.', 'err');
  }
}

$('openSettings').addEventListener('click', openSettings);
$('settingsCancel').addEventListener('click', closeSettings);
$('settingsForm').addEventListener('submit', saveSettings);
$('testConn').addEventListener('click', testConnection);
$('removeKey').addEventListener('click', removeKey);
for (const r of document.querySelectorAll('input[name="provider"]')) r.addEventListener('change', () => renderSettings(null));
$('settings').addEventListener('click', (e) => { if (e.target === $('settings')) closeSettings(); });

// --- More actions menu ------------------------------------------------------

const menuItems = () => [...$('moreMenu').querySelectorAll('[role="menuitem"]')].filter((b) => !b.hidden && !b.disabled);

function placeMenu() {
  const menu = $('moreMenu');
  const btn = $('more').getBoundingClientRect();
  const gap = 6;
  const margin = 8;
  const { innerWidth: vw, innerHeight: vh } = window;
  const left = Math.min(Math.max(margin, btn.right - menu.offsetWidth), vw - menu.offsetWidth - margin);
  let top = btn.bottom + gap;
  if (top + menu.offsetHeight > vh - margin) top = Math.max(margin, btn.top - gap - menu.offsetHeight);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function openMenu(focus = 'first') {
  if ($('more').disabled) return;
  $('moreMenu').hidden = false;
  $('more').setAttribute('aria-expanded', 'true');
  placeMenu();
  const items = menuItems();
  if (focus && items.length) (focus === 'last' ? items[items.length - 1] : items[0]).focus();
}

function closeMenu(refocus = true) {
  if ($('moreMenu').hidden) return;
  $('moreMenu').hidden = true;
  $('more').setAttribute('aria-expanded', 'false');
  if (refocus) $('more').focus();
}

$('more').addEventListener('click', () => {
  if ($('moreMenu').hidden) openMenu();
  else closeMenu();
});
$('more').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    openMenu(e.key === 'ArrowUp' ? 'last' : 'first');
  }
});
$('moreMenu').addEventListener('keydown', (e) => {
  const items = menuItems();
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') {
    e.preventDefault();
    closeMenu();
  } else if (e.key === 'Tab') {
    closeMenu(false);
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    if (!items.length) return;
    const next = e.key === 'Home' ? 0
      : e.key === 'End' ? items.length - 1
        : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  }
});
// Capture phase: the menu closes before the item's own handler runs (e.g. Delete's confirm).
$('moreMenu').addEventListener('click', (e) => {
  if (e.target.closest('[role="menuitem"]')) closeMenu();
}, true);
document.addEventListener('pointerdown', (e) => {
  if (!$('moreMenu').hidden && !e.target.closest('#moreMenu, #more')) closeMenu(false);
});
window.addEventListener('resize', () => closeMenu(false));
window.addEventListener('blur', () => closeMenu(false));
document.querySelector('main').addEventListener('scroll', () => closeMenu(false));

$('capture').addEventListener('click', () => (state.reading ? cancelReading() : capture(false)));
$('mic').addEventListener('click', toggleMic);
$('save').addEventListener('click', save);
$('export').addEventListener('click', exportCurrent);
$('starNote').addEventListener('click', () => { if (state.id) toggleStar(state.id); });
$('refresh').addEventListener('click', regeneratePoints);
$('newNote').addEventListener('click', newNote);
$('remove').addEventListener('click', removeNote);
$('search').addEventListener('input', onSearch);
$('showAll').addEventListener('click', () => setFilter('all'));
$('showStarred').addEventListener('click', () => setFilter('starred'));
$('list').addEventListener('click', (e) => {
  const star = e.target.closest('button[data-star]');
  if (star) {
    toggleStar(star.getAttribute('data-star'));
    return;
  }
  const btn = e.target.closest('button[data-id]');
  if (btn) openNote(btn.getAttribute('data-id'));
});
$('title').addEventListener('input', () => {
  const el = $('title');
  if (/\n/.test(el.value)) el.value = el.value.replace(/\s*\n\s*/g, ' ');
  fitTitle();
  markDirty();
});
$('title').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.preventDefault();
});
window.addEventListener('resize', fitTitle);
$('raw').addEventListener('input', markDirty);
$('points').addEventListener('input', () => {
  state.pointsEdited = true;
  markDirty();
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
  }
});

// Blocks closing the window with an unsaved draft; the main process asks the user.
window.addEventListener('beforeunload', (e) => {
  if (state.dirty) e.returnValue = false;
});

setStage('idle');
render();
loadNotes().then((caps) => {
  const imp = caps && caps.imported;
  if (imp && imp.count) {
    say(`Imported ${imp.count} earlier note(s) into Notely from ${imp.from.join(', ')}. The original files were left in place.`, 'ok');
  } else if (imp && imp.failed) {
    say(`${imp.failed} earlier note(s) could not be imported. Their original files were left in place.`, 'err');
  } else if (caps && caps.shortcut && !caps.shortcut.ok) {
    say(caps.shortcut.error, 'err');
  }
  if (caps && caps.shortcut) {
    $('capture').title = caps.shortcut.ok ? 'Capture screen (Ctrl + Shift + S, works from any app)' : 'Capture screen';
  }
});
