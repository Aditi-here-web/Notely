'use strict';

// Optional AI summarization behind a small provider interface:
//   provider.status()            -> { available, name, model } or { available: false, reason }
//   provider.generate(prompt, o) -> parsed JSON object, throws on failure
// The local provider is an Ollama server, so screen text never leaves the computer.
// Google Gemini (gemini.js) is used only when chosen in Settings with consent.
// Without an AI result, callers get the rule-based notes and a reason why.

const { parseJsonObject, normalizePolish, fallbackPolish } = require('./logic');
const {
  isGrounded, pickTitle, dedupePoints, CONTENT_TYPES, canFactCheckText, hasUnsupportedConcreteFacts,
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
  education: 'This is a lesson or tutorial. Cover the topic, the key concepts, and the steps that are actually shown.',
  video: 'This is a video page. Cover what the video is about and any concrete details shown.',
  code: 'This is code or terminal output. Cover the purpose and the important code, errors, or commands. Keep code, commands, file names, errors and URLs exactly as written.',
  docs: 'This is technical documentation. Cover the purpose, important APIs or concepts, and implementation details. Keep names, commands and URLs exactly as written.',
  document: 'This is a document. Start with what it is asking or stating, then the concrete facts.',
  article: 'This is an article or web page. Start with the main point, then the supporting facts that are written on screen.',
  general: 'Summarize the useful information on the screen. Do not turn it into a lesson.',
  other: 'This screen is mixed or does not fit one category. Extract the useful facts: requests, deadlines, dates, times, names, numbers, and any clear subject. Keep the note short if there is little content.',
};

function screenPrompt(cleanText, type) {
  return `You turn text captured from a screen into accurate notes about what is actually shown.
${TYPE_GUIDANCE[type] || TYPE_GUIDANCE.general}
Rules: use only facts that appear in the text. Do not add outside knowledge. Do not invent or complete URLs, counts, dates or descriptions that are not in the text. Do not repeat the same idea twice.
Each point is one clear sentence. Ignore menus, buttons, ads and recommendations.
If the text has little useful content, return a short title and at most 2 faithful points. Do not invent points to fill a quota.
Screen text:
"""
${cleanText.slice(0, 4000)}
"""
Return JSON only: {"title":"short title taken from the content","points":["key point", ...]} with at most 7 points.`;
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
    parsed = await provider.generate(`You make accurate notes from the text below. Use only facts that appear in it. Do not invent names, dates, numbers, URLs, or a topic. Do not repeat the same idea twice.
Keep code, commands, dates, names and URLs exactly as written. If the user speech is unrelated to the screen text, ignore the speech.
If there is little useful content, return at most 2 points.
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

// Drop Gemini lines that introduce numbers, names, emails, or URLs missing from the source.
// When OCR is too thin and an image was sent, the image is the evidence, so the check is skipped.
function filterFaithfulLines(text, source) {
  if (!text) return '';
  return String(text).split('\n').filter((line) => {
    const body = line.replace(/^[-*•]\s+/, '').replace(/^#+\s+/, '').trim();
    if (!body || body.length < 8) return true;
    return !hasUnsupportedConcreteFacts(body, source);
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function applyGeminiFaithfulness(result, source, hasImage) {
  const check = canFactCheckText(source) || !hasImage;
  if (!check) return result;
  const points = (result.points || []).filter((p) => !hasUnsupportedConcreteFacts(p, source));
  if (!points.length) return null;
  let title = result.title || '';
  if (title && hasUnsupportedConcreteFacts(title, source)) title = '';
  return { ...result, title, points, details: filterFaithfulLines(result.details, source) };
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
    const faithful = applyGeminiFaithfulness(r, cleanText, !!(image && image.length));
    if (!faithful) {
      return {
        ...rulesResult(notes, 'ungrounded', 'Gemini added names, dates, or numbers that are not in the screen text, so it was not used.'),
        provider: 'Gemini',
      };
    }
    return {
      method: 'ai',
      provider: 'Gemini',
      model: r.model,
      title: faithful.title || notes.title,
      points: faithful.points,
      details: faithful.details,
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
    const faithful = applyGeminiFaithfulness(r, `${screenText}\n${spoken}`, !!(image && image.length));
    if (!faithful) return rules('ungrounded', 'Gemini added names, dates, or numbers that are not in the source text, so it was not used.');
    return {
      title: faithful.title, points: faithful.points, ai: true, method: 'ai', provider: 'Gemini', model: r.model, reason: null, detail: '',
    };
  } catch (err) {
    return rules('failed', `Gemini: ${err.message}`);
  }
}

module.exports = {
  createOllamaProvider, summarizeScreen, summarizeText, summarizeCapture, summarizeTextWith, localAiStatus, screenPrompt, typeLabel,
};
