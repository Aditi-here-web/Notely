'use strict';

// Google Gemini screenshot analysis (REST generateContent, main process only).
// The screenshot is sent as an inline PNG image; OCR text is optional context.
// Responses are requested as JSON matching NOTE_SCHEMA and validated before use.

const { pickTitle, dedupePoints, CONTENT_TYPES } = require('./notes-pipeline');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const CONTENT_TYPE_IDS = Object.keys(CONTENT_TYPES);
const LIMITS = { title: 200, text: 4000, items: 20, ocr: 6000 };

const NOTE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short, specific title of the main subject (at most 70 characters). Not the website, app or channel name.' },
    contentType: { type: 'string', enum: CONTENT_TYPE_IDS, description: 'Kind of content on screen.' },
    mainIdea: { type: 'string', description: 'One or two sentences: what the screen is mainly about.' },
    keyPoints: { type: 'array', items: { type: 'string' }, description: '3 to 7 concise, non-overlapping key points.' },
    detailedNotes: { type: 'array', items: { type: 'string' }, description: 'Supporting details. Code goes in fenced code blocks, exactly as shown.' },
    importantTerms: {
      type: 'array',
      items: {
        type: 'object',
        properties: { term: { type: 'string' }, meaning: { type: 'string' } },
        required: ['term', 'meaning'],
      },
    },
    warnings: { type: 'array', items: { type: 'string' }, description: 'Warnings, errors or caveats shown on screen, and parts that were unreadable. Empty if none.' },
  },
  required: ['title', 'contentType', 'mainIdea', 'keyPoints', 'detailedNotes', 'importantTerms', 'warnings'],
};

const SYSTEM_PROMPT = `You turn screenshots into accurate, well-organized study notes.
Identify the main content the user is looking at. Ignore browser tabs, address bars, toolbars, menus, navigation, sidebars, advertisements, recommendations, comments, notifications and other unrelated interface text.
Use only what is visible in the screenshot. Do not add outside facts. If something is unreadable or cut off, say so in warnings instead of guessing.
Keep code, commands, URLs, file names, numbers and technical terms exactly as shown.
Do not repeat the same idea in several key points.`;

class GeminiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const MESSAGES = {
  'no-key': 'No usable Gemini API key is saved. Add your key in Settings.',
  'invalid-key': 'Gemini rejected the API key. Check the key in Settings.',
  permission: 'This API key is not allowed to use Gemini. Check the key\'s restrictions in Google AI Studio.',
  model: 'The selected Gemini model is not available for this key. Choose another model in Settings.',
  'rate-limit': 'Too many requests to Gemini right now. Wait a minute, then try again.',
  quota: 'Your Gemini quota is used up. Try again later, or check your plan in Google AI Studio.',
  'bad-request': 'Gemini could not process this request.',
  server: 'Gemini is temporarily unavailable. Try again shortly.',
  network: 'Could not reach Gemini. Check your internet connection.',
  timeout: 'Gemini took too long to respond.',
  blocked: 'Gemini declined to analyze this screenshot.',
  'invalid-response': 'Gemini returned a response Notely could not use.',
  cancelled: 'Cancelled.',
};

function geminiError(code) {
  return new GeminiError(code, MESSAGES[code] || MESSAGES['bad-request']);
}

// Maps an HTTP error response to a short, user-facing error. Never echoes the body.
function classifyHttpError(status, body) {
  const err = (body && body.error) || {};
  const text = `${err.status || ''} ${err.message || ''} ${JSON.stringify(err.details || [])}`;
  if (/API_KEY_INVALID|API key not valid|API key expired/i.test(text)) return geminiError('invalid-key');
  if (status === 401) return geminiError('invalid-key');
  if (status === 403) return geminiError('permission');
  if (status === 404) return geminiError('model');
  if (status === 429) {
    if (/PerMinute|per minute|retry in/i.test(text)) return geminiError('rate-limit');
    if (/quota|PerDay|per day|billing/i.test(text)) return geminiError('quota');
    return geminiError('rate-limit');
  }
  if (status === 408 || status === 504) return geminiError('timeout');
  if (status >= 500) return geminiError('server');
  return geminiError('bad-request');
}

const cleanText = (v, max) => String(v == null ? '' : v)
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  .trim()
  .slice(0, max);

const cleanList = (v) => (Array.isArray(v) ? v : [])
  .map((x) => cleanText(x, LIMITS.text))
  .filter(Boolean)
  .slice(0, LIMITS.items);

// Throws GeminiError('invalid-response') unless the object has the expected shape.
function validateAnalysis(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw geminiError('invalid-response');
  if (typeof obj.title !== 'string' || !Array.isArray(obj.keyPoints)) throw geminiError('invalid-response');
  for (const field of ['detailedNotes', 'importantTerms', 'warnings']) {
    if (obj[field] != null && !Array.isArray(obj[field])) throw geminiError('invalid-response');
  }
  if (obj.mainIdea != null && typeof obj.mainIdea !== 'string') throw geminiError('invalid-response');
  const keyPoints = dedupePoints(cleanList(obj.keyPoints).map((p) => p.replace(/^[-*•]\s+/, '')));
  if (!keyPoints.length) throw geminiError('invalid-response');
  return {
    title: cleanText(obj.title, LIMITS.title),
    contentType: CONTENT_TYPE_IDS.includes(obj.contentType) ? obj.contentType : 'general',
    mainIdea: cleanText(obj.mainIdea, LIMITS.text),
    keyPoints,
    detailedNotes: cleanList(obj.detailedNotes),
    importantTerms: (Array.isArray(obj.importantTerms) ? obj.importantTerms : [])
      .filter((t) => t && typeof t === 'object')
      .map((t) => ({ term: cleanText(t.term, 200), meaning: cleanText(t.meaning, LIMITS.text) }))
      .filter((t) => t.term && t.meaning)
      .slice(0, LIMITS.items),
    warnings: cleanList(obj.warnings),
  };
}

// Fits the analysis into Notely's note: title, key points, and the Notes & details text.
function analysisToNote(a) {
  const item = (s) => (/\n|```/.test(s) ? s : `- ${s}`);
  const parts = [];
  if (a.mainIdea) parts.push(`Main idea\n${a.mainIdea}`);
  if (a.detailedNotes.length) parts.push(`Detailed notes\n${a.detailedNotes.map(item).join('\n')}`);
  if (a.importantTerms.length) parts.push(`Important terms\n${a.importantTerms.map((t) => `- ${t.term}: ${t.meaning}`).join('\n')}`);
  if (a.warnings.length) parts.push(`Warnings\n${a.warnings.map(item).join('\n')}`);
  return {
    title: pickTitle([a.title]) || '',
    points: a.keyPoints,
    details: parts.join('\n\n'),
    contentType: a.contentType,
  };
}

function analysisPrompt({ ocrText, spoken, hasImage }) {
  const lines = [hasImage
    ? 'Analyze this screenshot and write notes about its main subject.'
    : 'Write notes from the text below.'];
  lines.push(`contentType must be one of: ${CONTENT_TYPE_IDS.join(', ')}.`);
  const ocr = cleanText(ocrText, LIMITS.ocr);
  if (ocr) {
    lines.push('Text read from the screen by OCR (may be incomplete or mixed with unrelated interface text; use it only as supporting context):');
    lines.push(`"""\n${ocr}\n"""`);
  }
  const said = cleanText(spoken, LIMITS.text);
  if (said) lines.push(`What the user said about it:\n"""\n${said}\n"""`);
  return lines.join('\n');
}

function extractJson(body) {
  const fb = body && body.promptFeedback;
  if (fb && fb.blockReason) throw geminiError('blocked');
  const cand = body && Array.isArray(body.candidates) ? body.candidates[0] : null;
  if (!cand) throw geminiError('invalid-response');
  if (['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY'].includes(cand.finishReason)) throw geminiError('blocked');
  const text = ((cand.content && cand.content.parts) || []).map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('').trim();
  if (!text) throw geminiError('invalid-response');
  try {
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw geminiError('invalid-response');
  }
}

function createGeminiProvider({
  getKey, getModel, fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 60000, baseUrl = API_BASE,
}) {
  async function request(pathPart, init, key, signal, ms = timeoutMs) {
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, ms);
    const onAbort = () => ac.abort();
    if (signal) {
      if (signal.aborted) throw geminiError('cancelled');
      signal.addEventListener('abort', onAbort, { once: true });
    }
    let res;
    try {
      res = await fetchImpl(`${baseUrl}/${pathPart}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key, ...(init.headers || {}) },
        signal: ac.signal,
      });
    } catch {
      if (signal && signal.aborted) throw geminiError('cancelled');
      throw geminiError(timedOut ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      if (res.ok) throw geminiError('invalid-response');
    }
    if (!res.ok) throw classifyHttpError(res.status, body);
    return body;
  }

  const modelPath = () => `models/${encodeURIComponent(getModel())}`;

  function status() {
    if (!getKey()) return { available: false, reason: MESSAGES['no-key'] };
    return { available: true, name: 'Gemini', model: getModel() };
  }

  // png: Buffer (optional); ocrText and spoken: optional context.
  async function analyze({ png, ocrText, spoken } = {}, { signal } = {}) {
    const key = getKey();
    if (!key) throw geminiError('no-key');
    const parts = [];
    if (png && png.length) parts.push({ inlineData: { mimeType: 'image/png', data: png.toString('base64') } });
    parts.push({ text: analysisPrompt({ ocrText, spoken, hasImage: parts.length > 0 }) });
    const body = await request(`${modelPath()}:generateContent`, {
      method: 'POST',
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts }],
        generationConfig: {
          // generateContent takes the MimeType enum name here, not a MIME string ("application/json" is rejected with 400).
          responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: NOTE_SCHEMA } },
          maxOutputTokens: 4096,
        },
      }),
    }, key, signal);
    const analysis = validateAnalysis(extractJson(body));
    return { ...analysisToNote(analysis), analysis, model: getModel() };
  }

  // Checks the key and model without sending any screenshot or note content.
  async function testConnection({ key: keyOverride, model } = {}) {
    const key = keyOverride || getKey();
    if (!key) throw geminiError('no-key');
    const name = model || getModel();
    const info = await request(`models/${encodeURIComponent(name)}`, { method: 'GET' }, key, null, 15000);
    const methods = (info && info.supportedGenerationMethods) || [];
    if (methods.length && !methods.includes('generateContent')) {
      throw new GeminiError('model', `The model "${name}" cannot analyze screenshots. Choose another model.`);
    }
    return { ok: true, model: name, displayName: (info && info.displayName) || name };
  }

  return {
    id: 'gemini', status, analyze, testConnection,
  };
}

module.exports = {
  createGeminiProvider, validateAnalysis, analysisToNote, classifyHttpError, GeminiError, NOTE_SCHEMA, MESSAGES, API_BASE,
};
