'use strict';

// Optional AI summarization behind a small provider interface:
//   provider.status()            -> { available, name, model } or { available: false, reason }
//   provider.generate(prompt, o) -> parsed JSON object, throws on failure
// The local provider is an Ollama server, so screen text never leaves the computer.
// Google Gemini (gemini.js) is used only when chosen in Settings with consent.
// Without an AI result, callers get the rule-based notes and a reason why.

const { parseJsonObject, normalizePolish, fallbackPolish } = require('./logic');
const {
  isGrounded, pickTitle, dedupePoints, CONTENT_TYPES,
} = require('./notes-pipeline');

const PREFERRED_MODELS = ['llama3.2', 'llama3.1', 'llama3', 'qwen2.5', 'mistral', 'gemma2', 'phi3'];

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs, outerSignal) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onAbort = () => ac.abort();
  if (outerSignal) outerSignal.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetchImpl(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener('abort', onAbort);
  }
}

function createOllamaProvider({ baseUrl = 'http://127.0.0.1:11434', fetchImpl = globalThis.fetch, model = '' } = {}) {
  let cached = null;

  async function status() {
    if (cached && Date.now() - cached.at < 30000) return cached.status;
    let s;
    try {
      const res = await fetchWithTimeout(fetchImpl, `${baseUrl}/api/tags`, {}, 1500);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const names = (body && Array.isArray(body.models) ? body.models : [])
        .map((m) => String((m && (m.name || m.model)) || ''))
        .filter((n) => n && !/embed/i.test(n));
      const pick = (model && names.find((n) => n === model || n.startsWith(`${model}:`)))
        || names.find((n) => PREFERRED_MODELS.some((p) => n.startsWith(p)))
        || names[0];
      s = pick
        ? { available: true, name: 'Ollama', model: pick }
        : { available: false, reason: 'Ollama is running but has no text model installed.' };
    } catch {
      s = { available: false, reason: 'No local AI model was found (Ollama is not running on this computer).' };
    }
    cached = { at: Date.now(), status: s };
    return s;
  }

  async function generate(prompt, { timeoutMs = 45000, signal } = {}) {
    const st = await status();
    if (!st.available) throw new Error(st.reason);
    let res;
    try {
      res = await fetchWithTimeout(fetchImpl, `${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: st.model, prompt, format: 'json', stream: false, options: { temperature: 0.2 },
        }),
      }, timeoutMs, signal);
    } catch (err) {
      cached = null;
      throw new Error(signal && signal.aborted ? 'Cancelled.' : 'The local AI did not respond in time.');
    }
    if (!res.ok) throw new Error(`The local AI returned an error (${res.status}).`);
    const body = await res.json();
    const parsed = parseJsonObject(body && body.response);
    if (!parsed || typeof parsed !== 'object') throw new Error('The local AI returned output Notely could not read.');
    return parsed;
  }

  return { id: 'ollama', status, generate };
}

const TYPE_GUIDANCE = {
  education: 'This is a lesson or tutorial. Cover the topic, the key concepts, and important details.',
  video: 'This is a video page. Cover what the video is about and any concrete details shown.',
  code: 'This is code or terminal output. Cover the purpose, the important code or concepts, and relevant commands. Keep code, commands, file names, errors and URLs exactly as written.',
  docs: 'This is technical documentation. Cover the purpose, important APIs or concepts, and implementation details. Keep names, commands and URLs exactly as written.',
  document: 'This is a document. Start with the main idea, then key points and supporting details.',
  article: 'This is an article or web page. Start with the main idea, then key points and supporting details.',
  general: 'Summarize the useful information on the screen.',
};

function screenPrompt(cleanText, type) {
  return `You turn text captured from a screen into concise study notes.
${TYPE_GUIDANCE[type] || TYPE_GUIDANCE.general}
Rules: use only facts that appear in the text. Do not add outside knowledge. Do not invent or complete URLs, counts, dates or descriptions that are not in the text. Do not repeat the same idea twice.
Each point is one clear sentence. Ignore menus, buttons, ads and recommendations.
Screen text:
"""
${cleanText.slice(0, 4000)}
"""
Return JSON only: {"title":"short title taken from the content","points":["key point", ...]} with 3 to 7 points.`;
}

function rulesResult(notes, reason, detail) {
  return {
    method: 'rules', title: notes.title || '', points: notes.keyPoints || [], reason, detail: detail || '',
  };
}

// Screen capture: AI points when a local model is available and its output is
// grounded in the screen text; otherwise the rule-based notes, with the reason.
async function summarizeScreen({ cleanText, notes }, provider, { signal } = {}) {
  if (!cleanText || notes.lowContent) return rulesResult(notes, 'low-content');
  const st = provider ? await provider.status() : { available: false, reason: 'No AI provider is configured.' };
  if (!st.available) return rulesResult(notes, 'unavailable', st.reason);
  let parsed;
  try {
    parsed = await provider.generate(screenPrompt(cleanText, notes.type), { signal });
  } catch (err) {
    if (signal && signal.aborted) throw err;
    return rulesResult(notes, 'failed', err.message);
  }
  const points = dedupePoints((Array.isArray(parsed.points) ? parsed.points : [])
    .map((p) => String(p).trim())
    .filter((p) => p && isGrounded(p, cleanText)))
    .slice(0, 7);
  if (!points.length) return rulesResult(notes, 'ungrounded', 'The local AI output did not match the screen text, so it was not used.');
  // A complete heading from the screen beats a paraphrase.
  const aiTitle = String(parsed.title || '').trim();
  const title = notes.title || (aiTitle && isGrounded(aiTitle, cleanText) ? pickTitle([aiTitle]) : '');
  return {
    method: 'ai', provider: st.name, model: st.model, title, points, reason: null, detail: '',
  };
}

// Regenerate key points from speech and/or cleaned screen text.
async function summarizeText({ raw, ocr }, provider) {
  const spoken = String(raw || '').trim();
  const screenText = String(ocr || '').trim();
  if (!spoken && !screenText) return { title: '', points: [], ai: false, method: 'rules', reason: 'empty' };
  const rules = (reason, detail) => {
    const fb = fallbackPolish(spoken, screenText);
    return { ...fb, points: dedupePoints(fb.points), method: 'rules', reason, detail: detail || '' };
  };
  const st = provider ? await provider.status() : { available: false, reason: 'No AI provider is configured.' };
  if (!st.available) return rules('unavailable', st.reason);
  let parsed;
  try {
    parsed = await provider.generate(`You make concise study notes. Use only facts from the text below. Do not repeat the same idea twice.
Keep code, commands and URLs exactly as written.
Screen text (already cleaned): ${screenText.slice(0, 2500)}
What the user said: ${spoken}
Return JSON only: {"title":"short title","points":["clear, concise point",...]}`);
  } catch (err) {
    return rules('failed', err.message);
  }
  const normalized = normalizePolish(parsed, spoken, screenText);
  if (!normalized.ai) return rules('ungrounded', 'The local AI output did not match the source text, so it was not used.');
  return {
    ...normalized, points: dedupePoints(normalized.points), method: 'ai', provider: st.name, model: st.model, reason: null, detail: '',
  };
}

function typeLabel(type) {
  return CONTENT_TYPES[type] || CONTENT_TYPES.general;
}

// --- Provider choice ------------------------------------------------------------
// ctx: { provider: 'rules' | 'ollama' | 'gemini', ollama, gemini, consent }
// The chosen provider is never swapped for another AI: a local-only choice never
// reaches the cloud, and Gemini failures fall back to rules (labelled as such).

// Local AI status for the app's capability check; Ollama is only contacted when it is the chosen provider.
async function localAiStatus(provider, ollama) {
  if (provider !== 'ollama') return { available: false, reason: 'Local AI is not selected in Settings.' };
  return ollama ? ollama.status() : { available: false, reason: 'No AI provider is configured.' };
}

function geminiBlocked(ctx) {
  if (!ctx.consent) return { reason: 'no-consent', detail: 'Cloud processing has not been agreed to in Settings, so nothing was sent.' };
  if (!ctx.gemini || !ctx.gemini.status().available) return { reason: 'no-key', detail: 'No usable Gemini API key is saved, so nothing was sent.' };
  return null;
}

// Screen capture. `image` is the PNG screenshot (Buffer); only Gemini receives it.
async function summarizeCapture({ cleanText, notes, image }, ctx, { signal } = {}) {
  if (ctx.provider === 'rules') return rulesResult(notes, 'disabled');
  if (ctx.provider !== 'gemini') {
    const r = await summarizeScreen({ cleanText, notes }, ctx.ollama, { signal });
    return r.method === 'ai' ? r : { ...r, provider: 'Ollama' };
  }
  const blocked = geminiBlocked(ctx);
  if (blocked) return { ...rulesResult(notes, blocked.reason, blocked.detail), provider: 'Gemini' };
  try {
    const r = await ctx.gemini.analyze({ png: image, ocrText: cleanText }, { signal });
    return {
      method: 'ai',
      provider: 'Gemini',
      model: r.model,
      title: r.title || notes.title,
      points: r.points,
      details: r.details,
      contentType: r.contentType,
      reason: null,
      detail: '',
    };
  } catch (err) {
    if (signal && signal.aborted) throw err;
    return { ...rulesResult(notes, 'failed', `Gemini: ${err.message}`), provider: 'Gemini' };
  }
}

// Regenerate key points. `image` (PNG Buffer) is the note's screenshot, if any.
async function summarizeTextWith({ raw, ocr, image }, ctx) {
  const spoken = String(raw || '').trim();
  const screenText = String(ocr || '').trim();
  const rules = (reason, detail) => {
    const fb = fallbackPolish(spoken, screenText);
    return {
      ...fb, points: dedupePoints(fb.points), method: 'rules', reason, detail: detail || '', provider: ctx.provider === 'gemini' ? 'Gemini' : '',
    };
  };
  if (!spoken && !screenText && !(ctx.provider === 'gemini' && image)) {
    return { title: '', points: [], ai: false, method: 'rules', reason: 'empty' };
  }
  if (ctx.provider === 'rules') return rules('disabled');
  if (ctx.provider !== 'gemini') return summarizeText({ raw: spoken, ocr: screenText }, ctx.ollama);
  const blocked = geminiBlocked(ctx);
  if (blocked) return rules(blocked.reason, blocked.detail);
  try {
    const r = await ctx.gemini.analyze({ png: image, ocrText: screenText, spoken });
    return {
      title: r.title, points: r.points, ai: true, method: 'ai', provider: 'Gemini', model: r.model, reason: null, detail: '',
    };
  } catch (err) {
    return rules('failed', `Gemini: ${err.message}`);
  }
}

module.exports = {
  createOllamaProvider, summarizeScreen, summarizeText, summarizeCapture, summarizeTextWith, localAiStatus, screenPrompt, typeLabel,
};
