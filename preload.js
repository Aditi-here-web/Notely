'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = new Set(['capture', 'cancel', 'polish', 'transcribe', 'save', 'list', 'note', 'delete', 'star', 'export', 'copy-text', 'caps', 'settings-get', 'settings-save', 'settings-test']);
const listen = new Set(['shot', 'ocr', 'asr', 'progress', 'hotkey', 'notice', 'app-error']);

contextBridge.exposeInMainWorld('n', {
  open: () => ipcRenderer.send('open'),
  on: (channel, fn) => {
    if (!listen.has(channel) || typeof fn !== 'function') return () => {};
    ipcRenderer.removeAllListeners(channel);
    const wrapped = (_event, data) => fn(data);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  // Resolves with { ok: true, data } or { ok: false, error, code }.
  call: (channel, data) => {
    if (!invoke.has(channel)) return Promise.resolve({ ok: false, error: 'Unknown action', code: 'EINVAL' });
    return ipcRenderer.invoke(channel, data);
  },
});
