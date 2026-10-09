'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createGeminiProvider, validateAnalysis, analysisToNote, NOTE_SCHEMA,
} = require('../gemini');
const { summarizeCapture, summarizeTextWith, localAiStatus } = require('../summarizer');
const { createSettingsStore, DEFAULT_GEMINI_MODEL } = require('../settings-store');
const { processText } = require('../notes-pipeline');

const KEY = 'AIzaSyTEST-not-a-real-key-0123456789';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const GOOD = {
  title: 'POV: Your Heart Belongs to Another Era',
  contentType: 'video',
  mainIdea: 'A playlist video of old romantic songs.',
  keyPoints: [
    'The playlist is for people who find comfort in old melodies.',
    'The playlist is for people who find comfort in old melodies.',
    'Songs were chosen for warm vocals and gentle piano.',
  ],
  detailedNotes: ['Uploaded 3 weeks ago.', 'Run it with:\n```\nnpm start\n```'],
  importantTerms: [{ term: 'Lofi', meaning: 'Relaxed, low-fidelity music.' }, { term: '', meaning: 'dropped' }],
  warnings: ['Part of the description is cut off.'],
};

const geminiBody = (obj, extra = {}) => ({
  candidates: [{ content: { parts: [{ text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] }, finishReason: 'STOP', ...extra }],
});

function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    return handler(url, init, calls.length);
  };
  fn.calls = calls;
  return fn;
}
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });

function provider(fetchImpl, extra = {}) {
  return createGeminiProvider({
    getKey: () => KEY, getModel: () => DEFAULT_GEMINI_MODEL, fetchImpl, ...extra,
  });
}

// --- Request: the real screenshot is sent as an image ------------------------------

test('the screenshot is sent as inline PNG image input, with OCR text as context', async () => {
  const fetchImpl = mockFetch(() => reply(200, geminiBody(GOOD)));
  await provider(fetchImpl).analyze({ png: PNG, ocrText: 'Your Heart Belongs to Another Era\nSubscribe' });
  const [call] = fetchImpl.calls;
  assert.equal(call.url, `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['x-goog-api-key'], KEY);
  assert.ok(!call.url.includes(KEY), 'the key is never put in the URL');
  const parts = call.body.contents[0].parts;
  assert.deepEqual(parts[0], { inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } });
  assert.match(parts[1].text, /Analyze this screenshot/);
  assert.match(parts[1].text, /supporting context[\s\S]*Your Heart Belongs to Another Era/);
  assert.match(call.body.systemInstruction.parts[0].text, /Ignore browser tabs.*advertisements, recommendations/s);
  // generateContent's TextResponseFormat.mimeType is an enum; the API rejects "application/json" with 400.
  assert.deepEqual(call.body.generationConfig.responseFormat.text, { mimeType: 'APPLICATION_JSON', schema: NOTE_SCHEMA });
  assert.equal(call.body.generationConfig.responseMimeType, undefined, 'deprecated fields are not mixed in');
  assert.deepEqual(NOTE_SCHEMA.required, ['title', 'contentType', 'mainIdea', 'keyPoints', 'detailedNotes', 'importantTerms', 'warnings']);
});

// --- Structured response ---------------------------------------------------------------

test('a structured response becomes a Notely note', async () => {
  const fetchImpl = mockFetch(() => reply(200, geminiBody(GOOD)));
  const r = await provider(fetchImpl).analyze({ png: PNG });
  assert.equal(r.title, 'Your Heart Belongs to Another Era');
  assert.equal(r.contentType, 'video');
  assert.deepEqual(r.points, [
    'The playlist is for people who find comfort in old melodies.',
    'Songs were chosen for warm vocals and gentle piano.',
  ], 'duplicates removed');
  assert.equal(r.model, DEFAULT_GEMINI_MODEL);
  assert.equal(r.details, [
    'Main idea\nA playlist video of old romantic songs.',
    'Detailed notes\n- Uploaded 3 weeks ago.\nRun it with:\n```\nnpm start\n```',
    'Important terms\n- Lofi: Relaxed, low-fidelity music.',
    'Warnings\n- Part of the description is cut off.',
  ].join('\n\n'));
});

test('validation tolerates missing optional lists and unknown content types', () => {
  const a = validateAnalysis({ title: 'Hooks', contentType: 'podcast', keyPoints: ['useState stores state.'] });
  assert.equal(a.contentType, 'general');
  assert.deepEqual(a.detailedNotes, []);
  assert.equal(analysisToNote(a).details, '');
});

// --- Malformed output ------------------------------------------------------------------

test('malformed or unusable responses are rejected before display', async () => {
  const bad = [
    geminiBody('this is not json'),
    geminiBody({ title: 'x' }),
    geminiBody({ title: 'x', keyPoints: 'one point' }),
    geminiBody({ title: 'x', keyPoints: ['   ', ''] }),
    geminiBody({ title: 'x', keyPoints: ['ok'], warnings: 'none' }),
    geminiBody(['an', 'array']),
    { candidates: [] },
    { candidates: [{ content: { parts: [] } }] },
  ];
  for (const body of bad) {
    const p = provider(mockFetch(() => reply(200, body)));
    await assert.rejects(p.analyze({ png: PNG }), { code: 'invalid-response' }, JSON.stringify(body));
  }
  const blocked = provider(mockFetch(() => reply(200, { promptFeedback: { blockReason: 'SAFETY' } })));
  await assert.rejects(blocked.analyze({ png: PNG }), { code: 'blocked' });
  const unsafe = provider(mockFetch(() => reply(200, geminiBody(GOOD, { finishReason: 'SAFETY' }))));
  await assert.rejects(unsafe.analyze({ png: PNG }), { code: 'blocked' });
  const notJson = provider(mockFetch(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } })));
  await assert.rejects(notJson.analyze({ png: PNG }), { code: 'invalid-response' });
});

// --- API errors --------------------------------------------------------------------------

test('API errors become short, specific messages without the key', async () => {
  const cases = [
    [400, { error: { status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } }, 'invalid-key', /rejected the API key/],
    [403, { error: { status: 'PERMISSION_DENIED', message: 'Method doesn\'t allow unregistered callers.' } }, 'permission', /not allowed/],
    [404, { error: { status: 'NOT_FOUND', message: 'models/x is not found' } }, 'model', /model is not available/],
    [429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 10 per minute. Please retry in 30s.' } }, 'rate-limit', /Too many requests/],
    [429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota, please check your plan and billing details.', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } }, 'quota', /quota is used up/],
    [500, { error: { status: 'INTERNAL', message: 'oops' } }, 'server', /temporarily unavailable/],
    [503, null, 'server', /temporarily unavailable/],
    [504, null, 'timeout', /too long/],
    [400, { error: { status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.' } }, 'bad-request', /could not process/],
  ];
  for (const [status, body, code, msg] of cases) {
    const p = provider(mockFetch(() => reply(status, body)));
    await assert.rejects(p.analyze({ png: PNG }), (err) => {
      assert.equal(err.code, code, `${status} ${JSON.stringify(body)}`);
      assert.match(err.message, msg);
      assert.ok(!err.message.includes(KEY));
      return true;
    });
  }
});

test('network failures, timeouts and cancellation are reported separately', async () => {
  const offline = provider(mockFetch(() => { throw new TypeError('fetch failed'); }));
  await assert.rejects(offline.analyze({ png: PNG }), { code: 'network' });

  const hang = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  const slow = provider(mockFetch(hang), { timeoutMs: 30 });
  await assert.rejects(slow.analyze({ png: PNG }), { code: 'timeout' });

  const ac = new AbortController();
  const pending = provider(mockFetch(hang)).analyze({ png: PNG }, { signal: ac.signal });
  ac.abort();
  await assert.rejects(pending, { code: 'cancelled' });
});

test('Test connection checks the key and model without sending content', async () => {
  const fetchImpl = mockFetch((url) => (url.endsWith('/models/gemini-3.8-flash')
    ? reply(200, { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent', 'countTokens'] })
    : reply(404, { error: { status: 'NOT_FOUND' } })));
  const p = provider(fetchImpl);
  const ok = await p.testConnection({ key: 'AIzaSyOTHER-typed-key-0123456789' });
  assert.equal(ok.ok, true);
  assert.equal(fetchImpl.calls[0].init.method, 'GET');
  assert.equal(fetchImpl.calls[0].init.headers['x-goog-api-key'], 'AIzaSyOTHER-typed-key-0123456789', 'a typed, unsaved key can be tested');
  assert.equal(fetchImpl.calls[0].body, null, 'no screenshot or text is sent');
  await assert.rejects(p.testConnection({ model: 'gemini-unknown' }), { code: 'model' });
  const embedOnly = provider(mockFetch(() => reply(200, { supportedGenerationMethods: ['embedContent'] })));
  await assert.rejects(embedOnly.testConnection({}), { code: 'model' });
  const noKey = createGeminiProvider({ getKey: () => '', getModel: () => DEFAULT_GEMINI_MODEL, fetchImpl: mockFetch(() => reply(200, {})) });
  await assert.rejects(noKey.testConnection({}), { code: 'no-key' });
});

// --- Provider choice, consent, fallback -------------------------------------------------

const SCREEN = 'Photosynthesis\nPlants convert light energy into chemical energy.\nChlorophyll absorbs red and blue light.\nOxygen is released as a by-product.';
const notes = () => processText(SCREEN).notes;
const ollamaDown = { status: async () => ({ available: false, reason: 'No local AI model was found.' }), generate: async () => { throw new Error('no'); } };

function ctxWith(fetchImpl, over = {}) {
  return {
    provider: 'gemini', consent: true, ollama: ollamaDown, gemini: provider(fetchImpl), ...over,
  };
}

test('Gemini analysis is used and labelled as AI only after consent', async () => {
  const fetchImpl = mockFetch(() => reply(200, geminiBody(GOOD)));
  const r = await summarizeCapture({ cleanText: SCREEN, notes: notes(), image: PNG }, ctxWith(fetchImpl));
  assert.equal(r.method, 'ai');
  assert.equal(r.provider, 'Gemini');
  assert.equal(r.model, DEFAULT_GEMINI_MODEL);
  assert.equal(r.title, 'Your Heart Belongs to Another Era');
  assert.match(r.details, /^Main idea\n/);
  assert.equal(fetchImpl.calls.length, 1);
});

test('without consent or a key nothing is uploaded and rules are used', async () => {
  const fetchImpl = mockFetch(() => reply(200, geminiBody(GOOD)));
  const n = notes();
  const r1 = await summarizeCapture({ cleanText: SCREEN, notes: n, image: PNG }, ctxWith(fetchImpl, { consent: false }));
  assert.equal(r1.method, 'rules');
  assert.equal(r1.reason, 'no-consent');
  assert.deepEqual(r1.points, n.keyPoints);
  const keyless = createGeminiProvider({ getKey: () => '', getModel: () => DEFAULT_GEMINI_MODEL, fetchImpl });
  const r2 = await summarizeCapture({ cleanText: SCREEN, notes: n, image: PNG }, ctxWith(fetchImpl, { gemini: keyless }));
  assert.equal(r2.reason, 'no-key');
  const r3 = await summarizeTextWith({ raw: '', ocr: SCREEN, image: PNG }, ctxWith(fetchImpl, { consent: false }));
  assert.equal(r3.method, 'rules');
  assert.equal(r3.reason, 'no-consent');
  assert.equal(fetchImpl.calls.length, 0, 'no request was made');
});

test('Rules only never contacts Ollama, including the startup capability check', async () => {
  const seen = [];
  const ollama = {
    status: async () => { seen.push('status'); return { available: true, name: 'Ollama', model: 'llama3.2' }; },
    generate: async () => { seen.push('generate'); return {}; },
  };
  const fetchImpl = mockFetch(() => reply(200, geminiBody(GOOD)));
  const n = notes();
  assert.equal((await localAiStatus('rules', ollama)).available, false);
  assert.equal((await localAiStatus('gemini', ollama)).available, false);
  await summarizeCapture({ cleanText: SCREEN, notes: n, image: PNG }, ctxWith(fetchImpl, { provider: 'rules', ollama }));
  await summarizeTextWith({ raw: '', ocr: SCREEN, image: PNG }, ctxWith(fetchImpl, { provider: 'rules', ollama }));
  assert.deepEqual(seen, [], 'Ollama was never called');
  assert.equal(fetchImpl.calls.length, 0, 'Google was never called');
  assert.equal((await localAiStatus('ollama', ollama)).available, true);
  assert.deepEqual(seen, ['status'], 'Local AI is checked only when selected');
});

test('local-only and rules-only choices never contact Gemini', async () => {
  const fetchImpl = mockFetch(() => reply(200, geminiBody(GOOD)));
  const n = notes();
  const local = await summarizeCapture({ cleanText: SCREEN, notes: n, image: PNG }, ctxWith(fetchImpl, { provider: 'ollama' }));
  assert.equal(local.method, 'rules');
  assert.equal(local.reason, 'unavailable', 'Ollama missing -> rules, not the cloud');
  const off = await summarizeCapture({ cleanText: SCREEN, notes: n, image: PNG }, ctxWith(fetchImpl, { provider: 'rules' }));
  assert.equal(off.method, 'rules');
  assert.equal(off.reason, 'disabled');
  const regen = await summarizeTextWith({ raw: '', ocr: SCREEN, image: PNG }, ctxWith(fetchImpl, { provider: 'rules' }));
  assert.equal(regen.method, 'rules');
  assert.equal(fetchImpl.calls.length, 0);
});

test('Gemini failures fall back to rules, labelled with the reason', async () => {
  const n = notes();
  const limited = mockFetch(() => reply(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'retry in 20s' } }));
  const r = await summarizeCapture({ cleanText: SCREEN, notes: n, image: PNG }, ctxWith(limited));
  assert.equal(r.method, 'rules');
  assert.equal(r.reason, 'failed');
  assert.match(r.detail, /^Gemini: Too many requests/);
  assert.deepEqual(r.points, n.keyPoints);
  const garbage = mockFetch(() => reply(200, geminiBody('nope')));
  const t = await summarizeTextWith({ raw: '', ocr: SCREEN, image: PNG }, ctxWith(garbage));
  assert.equal(t.method, 'rules');
  assert.equal(t.ai, false);
  assert.match(t.detail, /could not use/);
  assert.ok(t.points.length > 0);
});

test('regenerating with Gemini sends the screenshot, OCR text and speech', async () => {
  const fetchImpl = mockFetch(() => reply(200, geminiBody(GOOD)));
  const r = await summarizeTextWith({ raw: 'this is about old songs', ocr: SCREEN, image: PNG }, ctxWith(fetchImpl));
  assert.equal(r.method, 'ai');
  assert.equal(r.ai, true);
  const parts = fetchImpl.calls[0].body.contents[0].parts;
  assert.equal(parts[0].inlineData.mimeType, 'image/png');
  assert.match(parts[1].text, /What the user said[\s\S]*old songs/);
});

// --- Settings, consent record, secure key storage ---------------------------------------

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`ENC:${Buffer.from(s).reverse().toString('base64')}`),
    decryptString: (b) => Buffer.from(String(b).slice(4), 'base64').reverse().toString(),
    getSelectedStorageBackend: () => 'dpapi-test',
  };
}

test('the API key is stored encrypted and never returned to the renderer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notely-settings-'));
  try {
    const s = createSettingsStore({ dir, safeStorage: fakeSafeStorage() });
    const pub = s.save({ provider: 'gemini', consent: true, apiKey: KEY }, 1234);
    assert.equal(pub.provider, 'gemini');
    assert.equal(pub.hasGeminiKey, true);
    assert.deepEqual(pub.consent, { granted: true, at: 1234 });
    assert.ok(!JSON.stringify(pub).includes(KEY), 'public settings never contain the key');
    for (const f of fs.readdirSync(dir)) assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes(KEY), `${f} has no plain-text key`);
    assert.equal(s.getGeminiKey(), KEY);
    s.save({ provider: 'ollama', removeKey: true });
    assert.equal(s.hasGeminiKey(), false);
    assert.equal(s.getGeminiKey(), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Gemini cannot be enabled without consent and a key; consent can be withdrawn', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notely-settings-'));
  try {
    const s = createSettingsStore({ dir, safeStorage: fakeSafeStorage() });
    assert.equal(s.load().provider, 'ollama', 'default stays local');
    assert.throws(() => s.save({ provider: 'gemini', apiKey: KEY }), { code: 'ECONSENT' });
    assert.throws(() => s.save({ provider: 'gemini', consent: true }), { code: 'ENOKEY' });
    assert.equal(s.hasGeminiKey(), false);
    assert.throws(() => s.save({ provider: 'gemini', consent: true, apiKey: 'short' }), { code: 'EKEYFORMAT' });
    assert.throws(() => s.save({ provider: 'gemini', consent: true, apiKey: KEY, geminiModel: '../../evil' }), { code: 'EMODEL' });
    s.save({ provider: 'gemini', consent: true, apiKey: KEY });
    assert.throws(() => s.save({ provider: 'gemini', consent: false }), { code: 'ECONSENT' });
    s.save({ provider: 'rules', consent: false });
    assert.equal(s.load().consent.granted, false);
    // A hand-edited settings file cannot turn on Gemini without consent.
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ provider: 'gemini', consent: { granted: false } }));
    assert.equal(s.load().provider, 'ollama');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a saved key that can no longer be decrypted is reported as unusable, not as saved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notely-settings-'));
  try {
    const ss = fakeSafeStorage();
    const s = createSettingsStore({ dir, safeStorage: ss });
    s.save({ provider: 'gemini', consent: true, apiKey: KEY });
    ss.decryptString = () => { throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.'); };
    const pub = s.getPublic();
    assert.equal(pub.hasGeminiKey, false);
    assert.equal(pub.keyUnreadable, true);
    assert.equal(s.getGeminiKey(), '');
    assert.throws(() => s.save({ provider: 'gemini', consent: true }), { code: 'ENOKEY' }, 'an unusable key cannot keep Gemini on');
    s.save({ provider: 'rules', removeKey: true });
    assert.deepEqual([s.getPublic().hasGeminiKey, s.getPublic().keyUnreadable], [false, false]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Linux basic_text storage (hard-coded password) is not treated as secure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notely-settings-'));
  try {
    const s = createSettingsStore({ dir, safeStorage: { ...fakeSafeStorage(), getSelectedStorageBackend: () => 'basic_text' } });
    assert.equal(s.getPublic().secureStorage, false);
    assert.throws(() => s.save({ provider: 'gemini', consent: true, apiKey: KEY }), { code: 'ENOSECURE' });
    assert.equal(fs.existsSync(path.join(dir, 'gemini-key.bin')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without OS secure storage the key is refused, not saved in plain text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notely-settings-'));
  try {
    const s = createSettingsStore({ dir, safeStorage: fakeSafeStorage(false) });
    assert.throws(() => s.save({ provider: 'gemini', consent: true, apiKey: KEY }), { code: 'ENOSECURE' });
    assert.equal(s.hasGeminiKey(), false);
    assert.equal(s.getPublic().secureStorage, false);
    assert.ok(!fs.readdirSync(dir).some((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes(KEY)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
