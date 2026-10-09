'use strict';

// App settings (provider choice, model, cloud consent) and the Gemini API key.
// Lives only in the main process. The key is encrypted with Electron's
// safeStorage (Windows DPAPI / macOS Keychain / Linux Secret Service) and is
// never written in plain text or returned to the renderer.

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./storage');

const PROVIDERS = ['rules', 'ollama', 'gemini'];
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const CONSENT_VERSION = 1;
const MODEL_RE = /^[a-z0-9][a-z0-9.-]{1,63}$/;

class SettingsError extends Error {
  constructor(message, code = 'ESETTINGS') {
    super(message);
    this.code = code;
  }
}

function defaults() {
  // 'ollama' keeps the earlier behavior: local AI when available, otherwise rules.
  return { provider: 'ollama', geminiModel: DEFAULT_GEMINI_MODEL, consent: { granted: false, at: 0, version: CONSENT_VERSION } };
}

function createSettingsStore({ dir, safeStorage }) {
  const settingsFile = path.join(dir, 'settings.json');
  const keyFile = path.join(dir, 'gemini-key.bin');

  function load() {
    const out = defaults();
    try {
      const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (PROVIDERS.includes(raw.provider)) out.provider = raw.provider;
      if (typeof raw.geminiModel === 'string' && MODEL_RE.test(raw.geminiModel)) out.geminiModel = raw.geminiModel;
      if (raw.consent && raw.consent.granted === true && raw.consent.version === CONSENT_VERSION) {
        out.consent = { granted: true, at: Number(raw.consent.at) || 0, version: CONSENT_VERSION };
      }
    } catch { /* first run or unreadable: defaults */ }
    // Cloud processing is never active without recorded consent.
    if (out.provider === 'gemini' && !out.consent.granted) out.provider = 'ollama';
    return out;
  }

  function write(s) {
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(settingsFile, JSON.stringify({ provider: s.provider, geminiModel: s.geminiModel, consent: s.consent }, null, 2));
  }

  const backend = () => {
    try {
      return safeStorage && typeof safeStorage.getSelectedStorageBackend === 'function' ? safeStorage.getSelectedStorageBackend() : '';
    } catch {
      return ''; // only implemented on Linux
    }
  };

  // Linux 'basic_text' "encrypts" with a hard-coded password, which is no better than plain text.
  const secureAvailable = () => {
    try {
      return !!(safeStorage && safeStorage.isEncryptionAvailable()) && backend() !== 'basic_text';
    } catch {
      return false;
    }
  };

  function readKey() {
    if (!fs.existsSync(keyFile)) return { state: 'none', key: '' };
    if (!secureAvailable()) return { state: 'unreadable', key: '' };
    try {
      const key = safeStorage.decryptString(fs.readFileSync(keyFile));
      return key ? { state: 'ok', key } : { state: 'unreadable', key: '' };
    } catch {
      // e.g. the profile was copied to another Windows account, or Chromium's "Local State" key was lost
      return { state: 'unreadable', key: '' };
    }
  }

  // 'none' | 'ok' | 'unreadable'
  const keyState = () => readKey().state;
  const hasGeminiKey = () => keyState() === 'ok';
  const getGeminiKey = () => readKey().key;

  function validateKey(key) {
    const k = String(key || '').trim();
    if (!k) throw new SettingsError('Enter your Gemini API key.', 'ENOKEY');
    if (k.length < 20 || k.length > 200 || /\s/.test(k)) throw new SettingsError('That does not look like a Gemini API key. Copy it again from Google AI Studio.', 'EKEYFORMAT');
    return k;
  }

  function setGeminiKey(key) {
    const k = validateKey(key);
    if (!secureAvailable()) {
      throw new SettingsError('Secure storage is not available on this system, so Notely will not save the API key.', 'ENOSECURE');
    }
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(keyFile, safeStorage.encryptString(k));
  }

  function clearGeminiKey() {
    fs.rmSync(keyFile, { force: true });
  }

  // What the renderer may see: never the key itself.
  function getPublic() {
    const s = load();
    const state = keyState();
    return {
      provider: s.provider,
      geminiModel: s.geminiModel,
      defaultGeminiModel: DEFAULT_GEMINI_MODEL,
      consent: { granted: s.consent.granted, at: s.consent.at },
      hasGeminiKey: state === 'ok',
      keyUnreadable: state === 'unreadable',
      secureStorage: secureAvailable(),
      storageBackend: backend(),
    };
  }

  // patch: { provider, geminiModel, consent (bool), apiKey, removeKey }
  function save(patch = {}, now = Date.now()) {
    const s = load();
    const provider = patch.provider == null ? s.provider : patch.provider;
    if (!PROVIDERS.includes(provider)) throw new SettingsError('Unknown note generation option.', 'EINVAL');
    if (patch.geminiModel != null) {
      const m = String(patch.geminiModel).trim() || DEFAULT_GEMINI_MODEL;
      if (!MODEL_RE.test(m)) throw new SettingsError('Model names use lowercase letters, numbers, dots and dashes, like gemini-3.8-flash.', 'EMODEL');
      s.geminiModel = m;
    }
    if (patch.consent === true && !s.consent.granted) s.consent = { granted: true, at: now, version: CONSENT_VERSION };
    if (patch.consent === false) s.consent = { granted: false, at: 0, version: CONSENT_VERSION };

    const newKey = typeof patch.apiKey === 'string' && patch.apiKey.trim() ? validateKey(patch.apiKey) : '';
    if (provider === 'gemini') {
      if (!s.consent.granted) throw new SettingsError('To use Gemini, agree to sending screenshots to Google first.', 'ECONSENT');
      if (!newKey && (patch.removeKey || !hasGeminiKey())) throw new SettingsError('Enter your Gemini API key to use Gemini.', 'ENOKEY');
    }
    if (newKey) setGeminiKey(newKey);
    else if (patch.removeKey) clearGeminiKey();
    s.provider = provider;
    write(s);
    return getPublic();
  }

  return {
    load, save, getPublic, getGeminiKey, hasGeminiKey, keyState, clearGeminiKey, secureAvailable,
  };
}

module.exports = {
  createSettingsStore, SettingsError, PROVIDERS, DEFAULT_GEMINI_MODEL, MODEL_RE,
};
