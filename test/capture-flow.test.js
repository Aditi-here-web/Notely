'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCaptureFlow, registerShortcut, unregisterShortcut } = require('../capture-flow');
const { layout } = require('./layout-fixture');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SCREEN = layout([
  { text: 'Photosynthesis', x: 300, y: 150, h: 36 },
  { text: 'Plants convert light energy into chemical energy inside their leaves.', x: 300, y: 210 },
  { text: 'Chlorophyll absorbs red and blue light and reflects green light.', x: 300, y: 240 },
  { text: 'Oxygen is released as a by-product of the light reactions.', x: 300, y: 270 },
]);
const quiet = { error() {}, warn() {} };
const rules = async ({ notes }) => ({ method: 'rules', title: notes.title, points: notes.keyPoints, reason: 'unavailable' });

function setup(overrides = {}) {
  const sent = [];
  let grabs = 0;
  const flow = createCaptureFlow({
    grab: async () => { grabs += 1; return { ocrPng: PNG, shotPng: PNG, width: 1600, height: 900 }; },
    ocr: async () => SCREEN,
    summarize: rules,
    send: (channel, data) => sent.push({ channel, data }),
    log: quiet,
    ...overrides,
  });
  return { flow, sent, grabs: () => grabs, of: (ch) => sent.filter((s) => s.channel === ch).map((s) => s.data) };
}

test('a capture sends the screenshot first, then an editable note', async () => {
  const t = setup();
  const { capturedAt } = await t.flow.start();
  assert.equal(t.of('shot').length, 1);
  assert.match(t.of('shot')[0].dataUrl, /^data:image\/png;base64,/);
  await t.flow.whenIdle();
  const [ocr] = t.of('ocr');
  assert.equal(ocr.ok, true);
  assert.equal(ocr.capturedAt, capturedAt);
  assert.equal(ocr.note.title, 'Photosynthesis');
  assert.ok(ocr.note.points.length >= 2);
  assert.equal(ocr.method, 'rules');
  assert.equal(ocr.aiReason, 'unavailable');
  assert.ok(ocr.contentLabel);
  assert.equal(t.flow.busy(), false);
});

test('a second request while one is running does not start another capture', async () => {
  let release;
  const t = setup({ ocr: () => new Promise((r) => { release = () => r(SCREEN); }) });
  await t.flow.start();
  await assert.rejects(t.flow.start(), { code: 'EBUSY' });
  assert.equal(t.flow.onHotkey(), false, 'hotkey ignored while busy');
  assert.equal(t.of('hotkey').length, 0);
  assert.match(t.of('notice')[0].message, /already in progress/);
  release();
  await t.flow.whenIdle();
  assert.equal(t.grabs(), 1);
  assert.equal(t.of('shot').length, 1);
  assert.equal(t.of('ocr').length, 1);
});

test('repeated shortcut presses only ask the window to capture once', () => {
  let clock = 1000;
  const t = setup({ now: () => clock });
  assert.equal(t.flow.onHotkey(), true);
  assert.equal(t.flow.onHotkey(), false);
  clock += 500;
  assert.equal(t.flow.onHotkey(), false);
  assert.equal(t.of('hotkey').length, 1);
  clock += 5000;
  assert.equal(t.flow.onHotkey(), true, 'a later press works again');
});

test('capture errors are reported plainly and leave the flow usable', async () => {
  let fail = true;
  const t = setup({
    grab: async () => {
      if (fail) throw new Error('Failed to get sources: NotAllowedError permission denied at desktopCapturer.js:42');
      return { ocrPng: PNG, shotPng: PNG, width: 10, height: 10 };
    },
  });
  await assert.rejects(t.flow.start(), (err) => {
    assert.equal(err.code, 'ECAPTURE');
    assert.match(err.message, /Allow screen capture/);
    assert.doesNotMatch(err.message, /desktopCapturer|\.js:/);
    return true;
  });
  assert.equal(t.flow.busy(), false);
  fail = false;
  await t.flow.start();
  await t.flow.whenIdle();
  assert.equal(t.of('shot').length, 1);
});

test('OCR failure keeps the screenshot and reports a short message', async () => {
  const t = setup({ ocr: async () => { throw new Error('worker crashed: TypeError at tesseract.js:12'); } });
  await t.flow.start();
  await t.flow.whenIdle();
  assert.equal(t.of('shot').length, 1, 'the screenshot was already delivered');
  const [ocr] = t.of('ocr');
  assert.equal(ocr.ok, false);
  assert.equal(ocr.error, 'Text could not be read from this screenshot.');
  assert.equal(t.flow.busy(), false);
});

test('a summarizer crash falls back to the rule-based notes', async () => {
  const t = setup({ summarize: async () => { throw new Error('boom'); } });
  await t.flow.start();
  await t.flow.whenIdle();
  const [ocr] = t.of('ocr');
  assert.equal(ocr.ok, true);
  assert.equal(ocr.method, 'rules');
  assert.equal(ocr.aiReason, 'failed');
  assert.ok(ocr.note.points.length >= 2);
});

test('cancelling stops the reading, keeps the screenshot and frees the flow', async () => {
  let stopped = 0;
  const t = setup({ ocr: () => new Promise(() => {}), stopOcr: () => { stopped += 1; } });
  await t.flow.start();
  assert.equal(t.flow.cancel(), true);
  await t.flow.whenIdle();
  const [ocr] = t.of('ocr');
  assert.equal(ocr.ok, false);
  assert.equal(ocr.cancelled, true);
  assert.equal(stopped, 1);
  assert.equal(t.flow.busy(), false);
  assert.equal(t.flow.cancel(), false, 'nothing left to cancel');
  assert.equal(t.of('shot').length, 1);
});

test('the shortcut is registered once, reports conflicts, and is cleaned up', () => {
  const registered = new Map();
  const gs = {
    isRegistered: (a) => registered.has(a),
    register: (a, fn) => { if (a === 'Taken') return false; registered.set(a, fn); return true; },
    unregister: (a) => registered.delete(a),
  };
  let presses = 0;
  const s1 = registerShortcut(gs, 'CommandOrControl+Shift+S', () => { presses += 1; }, quiet);
  const s2 = registerShortcut(gs, 'CommandOrControl+Shift+S', () => { presses += 1; }, quiet);
  assert.equal(s1.ok, true);
  assert.equal(s2.ok, true);
  assert.equal(registered.size, 1, 'no duplicate registration');
  registered.get('CommandOrControl+Shift+S')();
  assert.equal(presses, 1);
  const taken = registerShortcut(gs, 'Taken', () => {}, quiet);
  assert.equal(taken.ok, false);
  assert.match(taken.error, /Capture screen button/);
  assert.equal(registered.has('Taken'), false, 'nothing intercepted when registration fails');
  unregisterShortcut(gs, 'CommandOrControl+Shift+S');
  assert.equal(registered.size, 0);
  const throwing = registerShortcut({ ...gs, register: () => { throw new Error('bad accelerator'); } }, 'X', () => {}, quiet);
  assert.equal(throwing.ok, false);
});
