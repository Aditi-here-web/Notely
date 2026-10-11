'use strict';

// End-to-end check of the real Notely app: in-app storage, import of older
// notes, titles, save/edit/restart, star, search, export, delete, save failure
// and the unsaved-close prompt.
// Uses a throwaway profile; the user's notes are only read (copied as fixtures).
// The renderer is driven over the DevTools protocol; the main process is
// reached through --inspect only to answer native dialogs and simulate a disk error.
// Run: node test/ui-e2e.js

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const electronBin = require('electron');
const appDir = path.join(__dirname, '..');
const PAGE_PORT = 9333;
const MAIN_PORT = 9334;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notely-e2e-'));
const profile = path.join(tmp, 'profile');
const store = path.join(profile, 'notes');
const oldFolder = path.join(tmp, 'old-notes-folder');
const exportDir = path.join(tmp, 'exports');
fs.mkdirSync(profile, { recursive: true });
fs.mkdirSync(exportDir);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const writeCfg = (dir) => fs.writeFileSync(path.join(profile, 'cfg.json'), JSON.stringify({ dir }));
const noteIds = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => fs.existsSync(path.join(dir, f, 'note.json'))) : []);
const readNote = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, id, 'note.json'), 'utf8'));

function step(msg) { console.log(`ok   ${msg}`); }

async function cdp(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const evaluate = (expression, commandLine = false) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`evaluate timed out: ${String(expression).slice(0, 80)}`));
    }, 15000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      const r = msg.result || {};
      if (msg.error || r.exceptionDetails) reject(new Error(JSON.stringify(msg.error || r.exceptionDetails)));
      else resolve(r.result && r.result.value);
    });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {
      expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: commandLine,
    } }));
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`cdp ${method} timed out`));
    }, 15000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      return msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { evaluate, call, close: () => { try { ws.close(); } catch { /* closed */ } } };
}

async function poll(fn, what, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* not ready */ }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function launch() {
  const child = spawn(electronBin, [
    `--inspect=${MAIN_PORT}`, appDir, `--user-data-dir=${profile}`, `--remote-debugging-port=${PAGE_PORT}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((r) => child.once('exit', r));

  let page;
  let main;
  try {
    const target = await poll(async () => {
      const list = await (await fetch(`http://127.0.0.1:${PAGE_PORT}/json`)).json();
      return list.find((t) => t.type === 'page' && t.url.endsWith('index.html'));
    }, 'Notely window');
    page = await cdp(target.webSocketDebuggerUrl);
    const mainTarget = await poll(async () => (await (await fetch(`http://127.0.0.1:${MAIN_PORT}/json/list`)).json())[0], 'main inspector');
    main = await cdp(mainTarget.webSocketDebuggerUrl);
    // The inspector console API provides `require`; keep it for later evaluations.
    const ok = await main.evaluate("globalThis.__req = require; typeof __req('electron').dialog.showOpenDialog", true);
    assert.equal(ok, 'function');
  } catch (err) {
    child.kill();
    await exited;
    throw new Error(`${err.message}\n${log}`);
  }

  const app = {
    page: page.evaluate,
    input: page.call,
    main: main.evaluate,
    log: () => log,
    exited,
    async close() {
      page.close();
      main.close();
      child.kill();
      await exited;
      await sleep(400);
    },
  };
  await waitFor(app, `!document.getElementById('save').disabled || !document.getElementById('dirError').hidden`, 'storage ready');
  await sleep(300);
  return app;
}

async function waitFor(app, expression, what, timeout) {
  try {
    await poll(() => app.page(expression), what, timeout);
  } catch (err) {
    const msg = await app.page("document.getElementById('msg').textContent").catch(() => '');
    throw new Error(`${err.message}. Status: ${msg}`);
  }
}

const type = (id, value) => `(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`;
const click = (id) => `document.getElementById(${JSON.stringify(id)}).click()`;
const val = (id) => `document.getElementById(${JSON.stringify(id)}).value`;
const text = (id) => `document.getElementById(${JSON.stringify(id)}).textContent`;
const editorBox = (id) => `(() => {
  const el = document.getElementById(${JSON.stringify(id)});
  const cs = getComputedStyle(el);
  return {
    overflowY: cs.overflowY, overscroll: cs.overscrollBehaviorY || cs.overscrollBehavior,
    canScroll: el.scrollHeight > el.clientHeight + 1,
    clientH: Math.round(el.clientHeight), scrollH: el.scrollHeight,
    minH: parseFloat(cs.minHeight), maxH: cs.maxHeight, fontSize: parseFloat(cs.fontSize),
  };
})()`;
const cards = `[...document.querySelectorAll('#list .card')].map((c) => c.firstChild.textContent)`;

async function save(app) {
  await app.page(`document.getElementById('msg').textContent = ''`);
  await app.page(click('save'));
  await waitFor(app, `/^Saved in Notely|Could not|disk|permission|error/i.test(${text('msg')})`, 'save result');
  return app.page(text('msg'));
}

const visibleTitles = `[...document.querySelectorAll('#list .card')].map((c) => c.firstChild.textContent)`;

async function search(app, q) {
  await app.page(type('search', q));
  await waitFor(app, `state.query === ${JSON.stringify(q)}`, `search "${q}" applied`);
  await sleep(50);
  return app.page(visibleTitles);
}

const mainWin = `__req('electron').BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Notely' && x.isResizable() && x.isVisible())`;
const notelyWin = `__req('electron').BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Notely' && x.isResizable())`;

// A fixed "screen" (a rendered YouTube-style page) replaces the desktop, so
// captures are deterministic and never contain the user's real screen.
const FIXTURE_HTML = `<!doctype html><html><body style="margin:0;width:1600px;height:900px;overflow:hidden;font-family:'Segoe UI',Arial,sans-serif;background:#fff;color:#0f0f0f">
<div style="background:#dee1e6;height:40px;display:flex;align-items:center;gap:60px;padding-left:20px;font-size:14px"><span>POV: Your Heart Belongs to Another Era - YouTube &#215;</span><span>New Tab &#215;</span></div>
<div style="height:44px;display:flex;align-items:center;padding-left:120px;font-size:15px;color:#333;border-bottom:1px solid #ccc">youtube.com/watch?v=abc123</div>
<div style="display:flex;padding:24px 40px">
<div style="width:1000px">
<div style="background:#111;height:400px;border-radius:12px;position:relative"><span style="position:absolute;left:40px;bottom:40px;color:#fff;font-size:30px">POV: Your Heart Bel</span></div>
<h1 style="font-size:30px;margin:20px 0 8px">POV: Your Heart Belongs to Another Era</h1>
<div style="font-size:14px;color:#555">2.1M views &#183; 3 weeks ago</div>
<p style="font-size:18px;line-height:1.5;margin:14px 0 6px">A playlist for the ones who still find comfort in old melodies, timeless lyrics, and rare love.</p>
<p style="font-size:18px;line-height:1.5;margin:6px 0">Each song was chosen for its warm vocals, slow tempo and gentle piano arrangements.</p>
</div>
<div style="margin-left:40px;width:440px;font-size:14px;color:#333">
<p>Top 10 retro love songs</p><p>1.2M views 2 days ago</p><p>Lofi evening study mix</p><p>540K views 1 week ago</p>
</div></div></body></html>`;

async function useFixtureScreen(app) {
  return app.main(`(async () => {
    const { BrowserWindow, desktopCapturer, screen } = __req('electron');
    const w = new BrowserWindow({ show: false, width: 1600, height: 900, useContentSize: true, webPreferences: { offscreen: true } });
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(${JSON.stringify(FIXTURE_HTML)}));
    await new Promise((r) => setTimeout(r, 500));
    const img = await w.webContents.capturePage();
    w.destroy();
    globalThis.__fixtureShot = img;
    globalThis.__grabs = 0;
    desktopCapturer.getSources = async () => {
      globalThis.__grabs += 1;
      return [{ display_id: String(screen.getPrimaryDisplay().id), thumbnail: globalThis.__fixtureShot }];
    };
    return img.getSize();
  })()`);
}

// Real keystrokes through the OS, so the global shortcut is tested while another app is in front.
function sendKeys(...keys) {
  const script = keys.map((k) => `$w.SendKeys('${k}'); Start-Sleep -Milliseconds 60`).join('; ');
  spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$w = New-Object -ComObject WScript.Shell; ${script}`], { stdio: 'ignore' });
}

const pngSize = (file) => { const b = fs.readFileSync(file); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

const menuOpen = `!document.getElementById('moreMenu').hidden`;
const menuItemsShown = `[...document.querySelectorAll('#moreMenu [role=menuitem]')].filter((b) => !b.hidden).map((b) => b.textContent.trim())`;

// Secondary actions live in the ⋮ menu: open it, pick the item, and the menu must close.
async function openShareDialog(app) {
  await menuAction(app, 'export');
  await waitFor(app, `!document.getElementById('share').hidden`, 'share dialog');
}

async function selectShareFormat(app, format) {
  await app.page(`document.querySelector('input[name=shareFormat][value=${JSON.stringify(format)}]').click()`);
}

async function shareOptions(app) {
  return app.page(`({
    format: document.querySelector('input[name=shareFormat]:checked').value,
    includeShot: document.getElementById('includeShot').checked,
    includeDisabled: document.getElementById('includeShot').disabled,
    shotBoxHidden: document.getElementById('shareShotBox').hidden,
  })`);
}

async function completeShare(app, { format = 'html', includeShot = false, viaPng = false } = {}) {
  await openShareDialog(app);
  if (viaPng) await selectShareFormat(app, 'png');
  await selectShareFormat(app, format);
  if (format !== 'copy' && format !== 'png') {
    const after = await shareOptions(app);
    if (viaPng) assert.equal(after.includeShot, false, `PNG -> ${format} leaves the screenshot unchecked`);
  }
  if (includeShot) await app.page('document.getElementById("includeShot").checked = true');
  else if (format !== 'png') await app.page('document.getElementById("includeShot").checked = false');
  await app.page(click('shareGo'));
}

async function menuAction(app, id) {
  await app.page(click('more'));
  await waitFor(app, menuOpen, 'menu open');
  const usable = await app.page(`(() => { const b = document.getElementById(${JSON.stringify(id)});
    return !!b.closest('#moreMenu') && !b.hidden && !b.disabled && b.getBoundingClientRect().width > 0; })()`);
  assert.equal(usable, true, `${id} is available in the menu`);
  await app.page(click(id));
  assert.equal(await app.page(menuOpen), false, `menu closes after choosing ${id}`);
}

// Gemini is never contacted: fetch in the main process is replaced for Google's
// API host only, and every request is recorded for inspection.
const FAKE_KEY = 'AIzaSyE2E-fake-key-for-tests-0123456789';
const GEMINI_ANSWER = {
  title: 'Songs From Another Era',
  contentType: 'video',
  mainIdea: 'A playlist video of romantic songs from the past.',
  keyPoints: ['The playlist collects old romantic songs.', 'Songs share warm vocals and gentle piano.'],
  detailedNotes: ['The description says it is for people who love old melodies.'],
  importantTerms: [{ term: 'Playlist', meaning: 'A list of songs played in order.' }],
  warnings: [],
};

async function mockGemini(app) {
  await app.main(`(() => {
    globalThis.__realFetch = globalThis.__realFetch || globalThis.fetch;
    globalThis.__g = { mode: 'ok', calls: [], answer: ${JSON.stringify(GEMINI_ANSWER)} };
    globalThis.fetch = async (url, init = {}) => {
      url = String(url);
      if (!url.startsWith('https://generativelanguage.googleapis.com/')) return globalThis.__realFetch(url, init);
      const g = globalThis.__g;
      g.calls.push({ url, method: init.method || 'GET', key: (init.headers || {})['x-goog-api-key'], body: init.body || '' });
      const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (g.mode === 'invalid') return json(400, { error: { status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } });
      if (g.mode === 'rate') return json(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for requests per minute. Please retry in 20s.' } });
      if ((init.method || 'GET') === 'GET') return json(200, { name: url.split('/').pop(), supportedGenerationMethods: ['generateContent'] });
      return json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(g.answer) }] }, finishReason: 'STOP' }] });
    };
  })()`);
}

const geminiCalls = `globalThis.__g.calls.map((c) => {
  let parts = [];
  let format = null;
  try { const b = JSON.parse(c.body); parts = b.contents[0].parts; format = b.generationConfig.responseFormat.text.mimeType; } catch {}
  const img = parts.find((p) => p.inlineData);
  return { url: c.url, method: c.method, key: c.key, format, image: img ? img.inlineData.mimeType : null,
    imageBytes: img ? Buffer.from(img.inlineData.data, 'base64').length : 0,
    png: img ? Buffer.from(img.inlineData.data, 'base64').subarray(1, 4).toString() : '',
    text: parts.filter((p) => p.text).map((p) => p.text).join('\\n') };
})`;

async function openSettingsDialog(app) {
  await app.page(click('openSettings'));
  await waitFor(app, `!document.getElementById('settings').hidden && document.getElementById('settings').contains(document.activeElement)`, 'settings open');
}
const pickProvider = (v) => `(() => { const r = document.querySelector('input[name=provider][value=${v}]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); })()`;
const check = (id, on) => `document.getElementById(${JSON.stringify(id)}).checked = ${on}`;

async function geminiSession(app) {
  await mockGemini(app);
  await useFixtureScreen(app);
  await app.page('window.confirm = () => true');
  const captureDone = `/Step 4|Rule-based notes|meaningful content|could not be read/i.test(${text('msg')}) && document.getElementById('capture').textContent === 'Capture screen'`;
  const capture = async () => {
    await app.page(`clearDraft(); document.getElementById('msg').textContent = ''`);
    await app.page(click('capture'));
    await waitFor(app, captureDone, 'capture processed', 90000);
  };

  // Settings: default is local, Gemini needs a key and explicit consent.
  await openSettingsDialog(app);
  assert.equal(await app.page(`document.querySelector('input[name=provider]:checked').value`), 'ollama');
  assert.equal(await app.page(`document.getElementById('geminiBox').hidden`), true);
  await app.page(pickProvider('gemini'));
  assert.equal(await app.page(`document.getElementById('geminiBox').hidden`), false);
  assert.match(await app.page(text('geminiBox')), /sends the screenshot[\s\S]*to Google[\s\S]*sensitive information[\s\S]*No screenshot or text is sent until you agree/i, 'the dialog explains what is uploaded');
  await app.page(type('geminiKey', FAKE_KEY));
  assert.equal(await app.page(`document.getElementById('geminiKey').type`), 'password');
  await app.page(click('settingsSave'));
  await waitFor(app, `/agree to sending screenshots/.test(${text('settingsMsg')})`, 'consent required');
  assert.equal(await app.page(`document.getElementById('settings').hidden`), false);

  await app.main(`globalThis.__g.mode = 'invalid'`);
  await app.page(click('testConn'));
  await waitFor(app, `/rejected the API key/.test(${text('settingsMsg')})`, 'invalid key reported');
  await app.main(`globalThis.__g.mode = 'ok'`);
  await app.page(click('testConn'));
  await waitFor(app, `document.getElementById('settingsMsg').className === 'ok'`, 'connection ok');
  const tests = await app.main(geminiCalls);
  assert.equal(tests.length, 2);
  assert.ok(tests.every((c) => c.method === 'GET' && c.image === null && c.key === FAKE_KEY && !c.url.includes(FAKE_KEY)), 'Test connection sends no screenshot');
  step(`Settings: Gemini needs consent; Test connection reports an invalid key and then "${await app.page(text('settingsMsg'))}"`);

  await app.page(check('consent', true));
  await app.page(click('settingsSave'));
  await waitFor(app, `document.getElementById('settings').hidden && /Settings saved/.test(${text('msg')})`, 'settings saved');
  assert.match(await app.page(text('msg')), /Google Gemini \(gemini-3\.8-flash\)/);
  const userData = await app.main(`__req('electron').app.getPath('userData')`);
  const files = fs.readdirSync(userData).filter((f) => fs.statSync(path.join(userData, f)).isFile());
  for (const f of files) assert.ok(!fs.readFileSync(path.join(userData, f)).toString('latin1').includes(FAKE_KEY), `${f} has no plain-text key`);
  assert.ok(files.includes('gemini-key.bin'));
  const seen = await app.page(`Promise.all([api('settings-get'), api('caps')]).then((r) => JSON.stringify(r) + document.documentElement.outerHTML + document.getElementById('geminiKey').value)`);
  assert.ok(!seen.includes(FAKE_KEY), 'the key never reaches the renderer');
  assert.equal((await app.page(`api('settings-get')`)).hasGeminiKey, true);
  step('Gemini enabled with consent; key encrypted on disk (gemini-key.bin), absent from settings.json, IPC replies and the page');

  // Capture: the screenshot itself goes to Gemini, OCR text as context.
  await capture();
  let calls = await app.main(geminiCalls);
  const sent = calls[calls.length - 1];
  assert.equal(sent.method, 'POST');
  assert.match(sent.url, /models\/gemini-3\.8-flash:generateContent$/);
  assert.equal(sent.image, 'image/png');
  assert.equal(sent.format, 'APPLICATION_JSON', 'structured output uses the enum the API accepts');
  assert.equal(sent.png, 'PNG');
  assert.ok(sent.imageBytes > 10000, `real screenshot sent (${sent.imageBytes} bytes)`);
  assert.match(sent.text, /supporting context[\s\S]*Another Era/);
  assert.equal(await app.page(val('title')), 'Songs From Another Era');
  assert.deepEqual((await app.page(val('points'))).split('\n'), GEMINI_ANSWER.keyPoints);
  assert.match(await app.page(val('raw')), /^Main idea\nA playlist video[\s\S]*Important terms\n- Playlist: /);
  const label = await app.page(text('ptsNote'));
  assert.match(label, /^Analyzed by Google Gemini \(gemini-3\.8-flash\) from the screenshot, in the cloud\. Detected: Video\./i);
  step(`capture with Gemini: ${sent.imageBytes}-byte PNG sent as image input; note filled from the structured reply; "${label}"`);

  // Regenerate: only key points change; the user's title and notes stay.
  await app.page(type('title', 'My Gemini title'));
  await app.page(type('raw', 'My own notes.'));
  await app.main(`globalThis.__g.answer = { ...globalThis.__g.answer, title: 'Other', keyPoints: ['A regenerated point about the songs.'] }`);
  await menuAction(app, 'refresh');
  await waitFor(app, `/Key points updated|Could not|Rule-based/.test(${text('msg')})`, 'regenerate', 30000);
  assert.equal(await app.page(val('points')), 'A regenerated point about the songs.');
  assert.equal(await app.page(val('title')), 'My Gemini title');
  assert.equal(await app.page(val('raw')), 'My own notes.');
  calls = await app.main(geminiCalls);
  assert.equal(calls[calls.length - 1].image, 'image/png', 'regenerate sends the screenshot too');
  assert.match(await save(app), /^Saved in Notely/);
  step('Regenerate with Gemini replaced only the key points; manual title and notes kept and saved');

  // Rate limit: clear message, rule-based notes clearly labelled, nothing lost.
  await app.main(`globalThis.__g.mode = 'rate'`);
  await capture();
  assert.match(await app.page(text('msg')), /Too many requests[\s\S]*Rule-based notes are shown instead/);
  assert.match(await app.page(text('ptsNote')), /^Extracted with rules, not AI\..*Too many requests/);
  assert.ok((await app.page(val('points'))).trim().length > 0, 'rule-based points still produced');
  step(`429 from Gemini -> "${await app.page(text('msg'))}"`);

  // Rules only: no request to Google at all.
  await app.main(`globalThis.__g.mode = 'ok'`);
  await openSettingsDialog(app);
  assert.equal(await app.page(`document.getElementById('consent').checked && !document.getElementById('removeKey').hidden`), true);
  await app.page(pickProvider('rules'));
  await app.page(click('settingsSave'));
  await waitFor(app, `document.getElementById('settings').hidden && /rules only/.test(${text('msg')})`, 'rules saved');
  const before = (await app.main(geminiCalls)).length;
  await capture();
  assert.equal((await app.main(geminiCalls)).length, before, 'no Google request with Rules only');
  assert.match(await app.page(text('ptsNote')), /^Extracted with rules, not AI\..*AI is turned off in Settings/);
  assert.equal((await app.page(`api('caps')`)).ai.reason, 'Local AI is not selected in Settings.', 'Ollama is not probed');
  step('Rules only: capture made no Google request, Ollama is not probed, and notes are labelled "Extracted with rules, not AI"');

  // Removing the key keeps Rules only selected (it must not switch to another provider).
  await openSettingsDialog(app);
  await app.page(pickProvider('gemini'));
  assert.match(await app.page(text('keyState')), /A key is saved.*Leave the field empty to keep it, or paste a new key to replace it/);
  assert.match(await app.page(`document.getElementById('geminiKey').placeholder`), /Saved key kept/);
  await app.page(click('removeKey'));
  await waitFor(app, `/^Key removed\\.$/.test(${text('settingsMsg')})`, 'key removed');
  const afterRemove = await app.page(`api('settings-get')`);
  assert.deepEqual([afterRemove.provider, afterRemove.hasGeminiKey], ['rules', false]);
  assert.equal(await app.page(`document.querySelector('input[name=provider]:checked').value`), 'rules');
  assert.equal(fs.existsSync(path.join(userData, 'gemini-key.bin')), false);
  await app.page(click('settingsCancel'));
  step('Remove saved key deleted the encrypted key file and kept Rules only selected');

  // Escape closes the dialog without saving; focus returns to the Settings button.
  await openSettingsDialog(app);
  await app.page(pickProvider('gemini'));
  await app.page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  assert.equal(await app.page(`document.getElementById('settings').hidden && document.activeElement.id === 'openSettings'`), true);
  assert.equal((await app.page(`api('settings-get')`)).provider, 'rules');
  await app.page(`clearDraft()`);
  step('Escape closes Settings without saving and returns focus');
}

function snapshotDir(dir) {
  if (!fs.existsSync(dir)) return 'missing';
  return fs.readdirSync(dir).sort().map((name) => {
    const st = fs.statSync(path.join(dir, name));
    return `${name}:${st.size}:${st.mtimeMs}`;
  }).join('\n');
}

function hashTree(dir) {
  const h = crypto.createHash('sha256');
  if (!fs.existsSync(dir)) return 'missing';
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (!fs.existsSync(path.join(p, 'note.json'))) continue;
      h.update(name);
      for (const f of fs.readdirSync(p).sort()) h.update(f).update(fs.readFileSync(path.join(p, f)));
    }
  }
  return h.digest('hex');
}

async function main() {
  // The user's real data is only read: snapshots before and after must match.
  const realCfgFile = path.join(process.env.APPDATA || '', 'notely', 'cfg.json');
  const realCfg = fs.existsSync(realCfgFile) ? fs.readFileSync(realCfgFile, 'utf8') : null;
  const realOld = realCfg ? JSON.parse(realCfg).dir : null;
  const watched = [realOld, path.join(os.homedir(), 'Downloads')].filter(Boolean);
  const before = watched.map(snapshotDir);
  const realHash = realOld ? hashTree(realOld) : null;

  // Old-style notes to import: copies of the user's notes when present, else fixtures.
  fs.mkdirSync(oldFolder);
  if (realOld && noteIds(realOld).length) {
    for (const id of noteIds(realOld)) fs.cpSync(path.join(realOld, id), path.join(oldFolder, id), { recursive: true });
  } else {
    fs.mkdirSync(path.join(oldFolder, '2026-10-09-18-28-pov-your-heart-bel'));
    fs.writeFileSync(path.join(oldFolder, '2026-10-09-18-28-pov-your-heart-bel', 'note.json'),
      JSON.stringify({ title: 'POV: Your Heart Bel', points: ['Your Heart Belongs to Another Era'], at: Date.now() }));
  }
  const oldIds = noteIds(oldFolder);
  const oldHash = hashTree(oldFolder);
  writeCfg(oldFolder);

  let app = await launch();
  let idA;
  let idB;
  const target = path.join(exportDir, 'capture.html');
  try {
    // 10. Older notes are imported into Notely, originals untouched.
    await waitFor(app, `/Imported ${oldIds.length} earlier note/.test(${text('msg')})`, 'import message');
    assert.equal(await app.page(`document.querySelectorAll('#list .card').length`), oldIds.length);
    assert.deepEqual(noteIds(store).sort(), oldIds.slice().sort());
    assert.equal(hashTree(oldFolder), oldHash);
    step(`imported ${oldIds.length} older note(s) into Notely storage; original files unchanged`);

    // Removed UI: shortcut chip, Discard button, screen-text panel. The shortcut itself still works.
    const removed = await app.page(`({
      discard: !!document.getElementById('discard'),
      ocrBox: !!document.getElementById('ocrBox') || !!document.querySelector('details'),
      chip: document.body.innerText.includes('Ctrl + Shift + S'),
      screenText: /Screen text saved with this note/i.test(document.body.innerText),
      buttons: [...document.querySelectorAll('.actions button')].map((b) => b.textContent.trim()),
    })`);
    assert.deepEqual({ ...removed, buttons: undefined }, { discard: false, ocrBox: false, chip: false, screenText: false, buttons: undefined });
    assert.deepEqual(removed.buttons, ['Capture screen', 'Start speaking', 'Save note']);
    assert.equal(await app.page(menuOpen), false);
    assert.deepEqual(await app.page(menuItemsShown), ['Regenerate key points'], 'an empty draft only offers Regenerate');
    assert.equal(await app.main(`__req('electron').globalShortcut.isRegistered('CommandOrControl+Shift+S')`), true);
    step('shortcut chip, Discard button and screen-text panel are gone; Ctrl+Shift+S is still registered');

    // Long titles wrap inside the header instead of being clipped or scrolling.
    await app.page(`(() => { window.__badges = []; new MutationObserver(() => window.__badges.push(document.getElementById('draftState').textContent))
      .observe(document.getElementById('draftState'), { childList: true, characterData: true, subtree: true }); })()`);
    const longTitle = 'A very long note title about photosynthesis, chlorophyll, light reactions and the Calvin cycle in green plants and algae';
    await app.page(type('title', longTitle));
    const fit = await app.page(`(() => { const t = document.getElementById('title'); const h = document.querySelector('.head');
      return { lines: Math.round(t.clientHeight / parseFloat(getComputedStyle(t).lineHeight)), clipped: t.scrollHeight > t.clientHeight + 1,
        overflow: t.scrollWidth > t.clientWidth + 1 || h.scrollWidth > h.clientWidth + 1 }; })()`);
    assert.ok(fit.lines >= 2, `long title wraps (lines: ${fit.lines})`);
    assert.equal(fit.clipped, false, 'long title not clipped');
    assert.equal(fit.overflow, false, 'long title does not scroll horizontally');
    await app.page(type('title', 'Line one\nline two'));
    assert.equal(await app.page(val('title')), 'Line one line two');
    step(`long title wraps onto ${fit.lines} lines without clipping; newlines are kept out of titles`);

    // 1. Create a note: stored internally, listed, nothing written outside.
    await app.page(type('title', 'Photosynthesis basics'));
    await app.page(type('points', 'Chlorophyll absorbs light\nPlants release oxygen'));
    await app.page(type('raw', 'Happens in the leaves of green plants.'));
    assert.match(await save(app), /^Saved in Notely · /);
    idA = noteIds(store).find((i) => !oldIds.includes(i));
    assert.deepEqual(fs.readdirSync(path.join(store, idA)), ['note.json']);
    assert.equal(readNote(store, idA).title, 'Photosynthesis basics');
    assert.ok((await app.page(visibleTitles)).includes('Photosynthesis basics'));
    const badges = await app.page('window.__badges');
    assert.ok(badges.includes('Unsaved draft') && badges.includes('Saving…'), badges.join(' / '));
    assert.match(await app.page(text('draftState')), /^Saved note · /);
    step(`note saved inside Notely (${path.join(store, idA)}) and listed; status went Unsaved draft → Saving… → Saved note`);

    const fixtureSize = await useFixtureScreen(app);
    const aiStatus = (await app.page(`api('caps')`)).ai;
    const captureDone = `/Step 4|meaningful content|could not be read|kept/i.test(${text('msg')}) && document.getElementById('capture').textContent === 'Capture screen'`;

    const stepChips = await app.page(`[...document.querySelectorAll('#steps li')].map((li) => li.textContent.trim())`);
    assert.deepEqual(stepChips, ['1. Capture', '2. Read text', '3. Clean & summarize', '4. Review & edit', '5. Save']);

    // Cancel: the first read of a session also starts the OCR engine, so there is time to cancel it.
    // Capture must leave the saved note immediately so it is not shown as still open.
    await app.page(click('capture'));
    await waitFor(app, `${val('title')} === '' && !document.querySelector('#list .card.current')`, 'capture started a new draft');
    await waitFor(app, `document.getElementById('capture').textContent === 'Cancel reading'`, 'reading started', 20000);
    await app.page(click('capture'));
    await waitFor(app, `/Reading cancelled/.test(${text('msg')})`, 'reading cancelled', 20000);
    assert.equal(await app.page(`!document.getElementById('zoomShot').hidden && document.getElementById('shot').naturalWidth > 0`), true, 'screenshot kept after cancel');
    assert.equal(await app.page(`document.getElementById('capture').textContent`), 'Capture screen');
    assert.equal(await app.page(text('draftState')), 'Unsaved draft');
    step(`fixture screen ${fixtureSize.width}x${fixtureSize.height}; Cancel reading stopped OCR and kept the screenshot`);

    // Manual Capture button: deterministic screen -> OCR -> structured, honestly labelled notes.
    await app.page('window.confirm = () => true');
    await app.page(click('capture'));
    await waitFor(app, captureDone, 'capture processed', 90000);
    const capMsg = await app.page(text('msg'));
    assert.match(capMsg, /Step 4 of 5/, capMsg);
    const thumbFit = await app.page(`(() => {
      const img = document.getElementById('shot'); const box = document.getElementById('preview').getBoundingClientRect();
      const r = img.getBoundingClientRect();
      return { ratio: r.width / r.height, nat: img.naturalWidth / img.naturalHeight,
        fits: r.width <= box.width + 1 && r.height <= box.height + 1, used: r.height / box.height };
    })()`);
    assert.ok(Math.abs(thumbFit.ratio - thumbFit.nat) < 0.03, `preview keeps aspect ratio (${thumbFit.ratio} vs ${thumbFit.nat})`);
    assert.equal(thumbFit.fits, true, 'preview is not cropped or overflowing its box');
    const capTitle = await app.page(val('title'));
    assert.equal(capTitle, 'Your Heart Belongs to Another Era', 'complete heading without "POV:" or the tab text');
    const capPoints = (await app.page(val('points'))).split('\n').filter(Boolean);
    assert.ok(capPoints.length >= 1, 'key points generated');
    assert.equal(new Set(capPoints.map((p) => p.toLowerCase())).size, capPoints.length, 'no duplicate key points');
    assert.ok(capPoints.some((p) => /old melodies|warm vocals/i.test(p)), capPoints.join(' | '));
    assert.ok(!capPoints.some((p) => /views|New Tab|youtube\.com|retro love songs/i.test(p)), 'no navigation or recommendation text');
    const ptsNote = await app.page(text('ptsNote'));
    if (aiStatus && aiStatus.available) assert.match(ptsNote, /local AI|rules, not AI/);
    else assert.match(ptsNote, /Extracted with rules, not AI\. Detected: video\. AI summary unavailable: no local AI model found\./);
    step(`capture -> "${capTitle}"; ${capPoints.length} key point(s), no duplicates; status: "${ptsNote}"`);

    const rawCss = await app.page(editorBox('raw'));
    const ptsCss = await app.page(editorBox('points'));
    assert.equal(rawCss.overflowY, 'auto');
    assert.notEqual(rawCss.maxH, 'none', 'Notes & details has a maximum height');
    assert.ok(rawCss.minH >= 96, 'Notes & details has a usable minimum height');
    assert.equal(ptsCss.overflowY, 'auto');
    assert.ok(ptsCss.fontSize >= 14.5, `key points stay readable (${ptsCss.fontSize}px)`);
    await app.page(type('raw', 'A short note about this playlist.'));
    await app.page(type('points', 'One short key point.'));
    assert.equal((await app.page(editorBox('raw'))).canScroll, false, 'short notes do not show an inner scrollbar');
    assert.equal((await app.page(editorBox('points'))).canScroll, false, 'short key points do not show an inner scrollbar');

    const longScript = Array.from({ length: 36 }, (_, i) => `Line ${i + 1}: a longer script about chlorophyll, light reactions and the Calvin cycle.`).join('\n');
    await app.page(type('raw', longScript));
    const longRaw = await app.page(editorBox('raw'));
    assert.equal(longRaw.canScroll, true, 'long Notes & details become scrollable');
    assert.ok(longRaw.clientH + 1 < longRaw.scrollH, 'the editor does not grow to the full script');
    await app.page(`document.getElementById('raw').scrollTop = document.getElementById('raw').scrollHeight`);
    assert.ok(await app.page(`document.getElementById('raw').scrollTop > 20`), 'the end of Notes & details is reachable');
    assert.match(await app.page(val('raw')), /Line 36: a longer script/);
    const longPoints = Array.from({ length: 18 }, (_, i) => `Key point ${i + 1} about lists, chlorophyll and light-dependent reactions.`).join('\n');
    await app.page(type('points', longPoints));
    const longPts = await app.page(editorBox('points'));
    assert.equal(longPts.canScroll, true, 'long key points become scrollable');
    await app.page(`document.getElementById('points').scrollTop = document.getElementById('points').scrollHeight`);
    assert.ok(await app.page(`document.getElementById('points').scrollTop > 10`), 'the last key point is reachable');
    assert.equal(await app.page(val('points')), longPoints);
    await app.page(`document.querySelector('main').scrollTop = 9999`);
    assert.equal(await app.page(`(() => { const s = document.getElementById('save').getBoundingClientRect(); const m = document.querySelector('main').getBoundingClientRect();
      return s.width > 0 && s.bottom <= m.bottom + 2 && s.top < m.bottom; })()`), true, 'Save stays reachable by scrolling the main column');
    await app.page(`document.querySelector('main').scrollTop = 0`);
    step('short notes have no inner scrollbar; long Notes and Key points scroll inside a capped editor; Save stays reachable');

    // Regenerate key points: uses the stored screen text, keeps the title and the user's Notes & details.
    await app.page(type('title', 'My own title'));
    await app.page(type('raw', 'My own notes about this playlist.'));
    await menuAction(app, 'refresh');
    await waitFor(app, `/Key points updated|No key points|Could not generate/.test(${text('msg')})`, 'regenerate', 60000);
    assert.match(await app.page(text('msg')), /Key points updated/);
    assert.ok((await app.page(val('points'))).trim().length > 0);
    assert.equal(await app.page(val('title')), 'My own title', 'manual title kept');
    assert.equal(await app.page(val('raw')), 'My own notes about this playlist.', 'Notes & details untouched');
    step('Regenerate key points produced points and kept the manual title and Notes & details');

    await app.page(type('title', capTitle));
    assert.match(await save(app), /^Saved in Notely/);
    const newIds = noteIds(store).filter((i) => !oldIds.includes(i) && i !== idA);
    assert.equal(newIds.length, 1, 'one capture -> one note');
    idB = newIds[0];
    assert.deepEqual(fs.readdirSync(path.join(store, idB)).sort(), ['note.json', 'screenshot.png']);
    assert.equal(await app.main('globalThis.__grabs'), 2, 'one screen grab per capture');
    step(`capture saved once with its screenshot: "${capTitle}"`);

    // Global shortcut from another app: Notely minimized, the OS delivers Ctrl+Shift+S twice in a row.
    assert.equal(await app.main(`__req('electron').globalShortcut.isRegistered('CommandOrControl+Shift+S')`), true);
    await app.main(`${notelyWin}.minimize()`);
    await sleep(600);
    await app.page(`document.getElementById('msg').textContent = ''`);
    sendKeys('^+s', '^+s');
    await waitFor(app, captureDone, 'hotkey capture processed', 90000);
    await sleep(1500);
    assert.equal(await app.main('globalThis.__grabs'), 3, 'two quick presses -> exactly one capture');
    assert.equal(await app.main(`${notelyWin}.isMinimized()`), false, 'Notely is brought back with the capture');
    assert.equal(await app.page(val('title')), 'Your Heart Belongs to Another Era');
    assert.equal(await app.page(text('draftState')), 'Unsaved draft', 'shortcut capture is a new, unsaved draft');
    assert.equal(noteIds(store).length, oldIds.length + 2, 'nothing saved without the user');
    step('Ctrl+Shift+S pressed twice while Notely was minimized -> one capture, window restored, draft ready to review');
    await app.page('window.confirm = () => true');
    await app.page(`clearDraft()`);

    // 4. Star from the sidebar: persists, content and timestamps unchanged.
    const jsonBefore = readNote(store, idA);
    await app.page(`document.querySelector('[data-star=${JSON.stringify(idA)}]').click()`);
    await waitFor(app, `document.querySelector('[data-star=${JSON.stringify(idA)}]').classList.contains('on')`, 'star shown');
    const jsonAfter = readNote(store, idA);
    assert.equal(jsonAfter.starred, true);
    assert.deepEqual({ ...jsonAfter, starred: false }, jsonBefore);
    step('starred from the sidebar; only the star flag changed on disk');
  } finally {
    await app.close();
  }

  app = await launch();
  try {
    // 2 + 10. Restart: everything still there, no duplicate imports.
    await sleep(500);
    assert.doesNotMatch(await app.page(text('msg')), /Imported/);
    assert.equal(noteIds(store).length, oldIds.length + 2);
    assert.equal(await app.page(`document.querySelectorAll('#list .card').length`), oldIds.length + 2);
    assert.equal(await app.page(`document.querySelector('[data-star=${JSON.stringify(idA)}]').classList.contains('on')`), true);
    step('after restart: all notes present, star kept, no duplicate import');

    // 3. Edit and save.
    await app.page(`document.querySelector('[data-id=${JSON.stringify(idA)}]').click()`);
    await waitFor(app, `${val('title')} === 'Photosynthesis basics'`, 'note A open');
    await app.page(type('raw', 'Happens in the leaves of green plants.\nMitochondria are a separate topic.'));
    assert.match(await app.page(text('draftState')), /^Unsaved changes/);
    assert.match(await app.page(text('ptsNote')), /Editing a saved note/);
    assert.match(await save(app), /^Saved in Notely/);
    assert.match(await app.page(text('draftState')), /^Saved note · /);
    assert.equal(noteIds(store).length, oldIds.length + 2);

    // 5. Search by title, key point and detailed notes; case-insensitive.
    // The live capture may contain any of these words (e.g. this file open in an editor), so it is ignored here.
    const titleB = readNote(store, idB).title;
    const find = async (q) => (await search(app, q)).filter((t) => t !== titleB);
    const nothing = `zq${crypto.randomUUID().slice(0, 8)}`;
    assert.deepEqual(await find('photosynthesis'), ['Photosynthesis basics']);
    assert.deepEqual(await find('OXYGEN'), ['Photosynthesis basics']);
    assert.deepEqual(await find('mitochondria'), ['Photosynthesis basics']);
    assert.deepEqual(await find('leaves plants'), ['Photosynthesis basics']);
    const ocrOnly = `calvin${crypto.randomUUID().slice(0, 8)}`;
    const noteAFile = path.join(store, idA, 'note.json');
    const noteAData = JSON.parse(fs.readFileSync(noteAFile, 'utf8'));
    noteAData.ocrClean = `On-screen text about the ${ocrOnly} pathway.`;
    fs.writeFileSync(noteAFile, JSON.stringify(noteAData, null, 2));
    await app.page('loadNotes()');
    await waitFor(app, `state.notes.some((n) => n.id === ${JSON.stringify(idA)} && n.search.includes(${JSON.stringify(ocrOnly)}))`, 'ocr text indexed');
    assert.deepEqual(await find(ocrOnly), ['Photosynthesis basics']);
    assert.deepEqual(await search(app, nothing), []);
    assert.match(await app.page(text('listEmpty')), new RegExp(`No notes match "${nothing}"`));
    assert.equal((await search(app, '')).length, oldIds.length + 2);
    step('search matches title, key points, notes and cleaned OCR (case-insensitive); empty and no-result states shown');

    // 4 + 6. Star from the header; Starred filter alone and with search.
    await app.page(`document.querySelector('[data-id=${JSON.stringify(idB)}]').click()`);
    await waitFor(app, `!document.getElementById('starNote').hidden`, 'note B open');
    await app.page(click('starNote'));
    await waitFor(app, `document.getElementById('starNote').classList.contains('on')`, 'header star on');
    assert.equal(readNote(store, idB).starred, true);
    await app.page(click('showStarred'));
    await sleep(100);
    assert.equal((await app.page(visibleTitles)).length, 2);
    assert.deepEqual(await find('oxygen'), ['Photosynthesis basics']);
    assert.deepEqual(await find('heart'), []);
    await search(app, nothing);
    assert.match(await app.page(text('listEmpty')), /No starred notes match/);
    await search(app, '');
    await app.page(click('showAll'));
    await sleep(100);
    assert.equal((await app.page(visibleTitles)).length, oldIds.length + 2);
    step('Starred filter works alone and combined with search; All view restored');

    const overflowAt = async (label) => {
      await sleep(400);
      const bad = await app.page(`[...document.querySelectorAll('html, body, aside, main, .note-row, .head, .actions, #title')]
        .filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.id || el.className || el.tagName)`);
      assert.deepEqual(bad, [], `no horizontal overflow at ${label}`);
      const editors = await app.page(`(() => {
        const info = (id) => { const el = document.getElementById(id); const cs = getComputedStyle(el);
          return { overflowY: cs.overflowY, maxH: cs.maxHeight, fontSize: parseFloat(cs.fontSize) }; };
        return { raw: info('raw'), points: info('points') };
      })()`);
      assert.equal(editors.raw.overflowY, 'auto', `Notes overflow-y at ${label}`);
      assert.notEqual(editors.raw.maxH, 'none', `Notes max-height at ${label}`);
      assert.equal(editors.points.overflowY, 'auto', `Key points overflow-y at ${label}`);
      assert.ok(editors.points.fontSize >= 14.5, `Key points readable at ${label}`);
      await app.page(`document.querySelector('main').scrollTop = 9999`);
      assert.equal(await app.page(`(() => { const s = document.getElementById('save').getBoundingClientRect(); const m = document.querySelector('main').getBoundingClientRect();
        return s.width > 0 && s.right <= document.documentElement.clientWidth && s.bottom <= m.bottom + 2 && s.top < m.bottom; })()`), true, `Save reachable at ${label}`);
      await app.page(`document.querySelector('main').scrollTop = 0`);
      const wrapped = await app.page(`[...document.querySelectorAll('.actions button')].filter((b) => !b.hidden)
        .every((b) => { const r = b.getBoundingClientRect(); return r.right <= document.documentElement.clientWidth && r.width > 0; })`);
      assert.equal(wrapped, true, `all action buttons visible at ${label}`);
      const shot = async (suffix) => {
        if (!process.env.NOTELY_E2E_SHOT) return;
        const file = process.env.NOTELY_E2E_SHOT.replace(/\.png$/i, `-${label}${suffix}.png`);
        await app.main(`(async () => { __req('fs').writeFileSync(${JSON.stringify(file)}, (await ${mainWin}.webContents.capturePage()).toPNG()); })()`);
      };
      await shot('');

      // The ⋮ button sits in the header without covering the title or panels; its menu opens just below it.
      await app.page(click('more'));
      await waitFor(app, menuOpen, 'menu open');
      const geo = await app.page(`(() => {
        const r = (sel) => document.querySelector(sel).getBoundingClientRect();
        const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
        const menu = r('#moreMenu'); const more = r('#more'); const de = document.documentElement;
        return {
          inside: menu.left >= 0 && menu.top >= 0 && menu.right <= de.clientWidth && menu.bottom <= de.clientHeight,
          below: menu.top >= more.bottom && menu.top - more.bottom <= 10,
          aligned: Math.abs(menu.right - more.right) <= 1,
          buttonClear: ['#title', '#preview', '.pts'].filter((s) => hit(more, r(s))),
          menuOverTitle: hit(menu, r('#title')),
          pageScroll: de.scrollWidth > de.clientWidth || de.scrollHeight > de.clientHeight
            || document.querySelector('main').scrollWidth > document.querySelector('main').clientWidth + 1,
          inHeader: !!document.getElementById('more').closest('.head'),
        }; })()`);
      assert.deepEqual(geo, { inside: true, below: true, aligned: true, buttonClear: [], menuOverTitle: false, pageScroll: false, inHeader: true }, `menu placement at ${label}`);
      await shot('-menu');
      await app.page(`document.getElementById('raw').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
      assert.equal(await app.page(menuOpen), false, 'clicking outside closes the menu');
    };
    const startSize = await app.main(`${mainWin}.getSize()`);
    await overflowAt(`${startSize[0]}x${startSize[1]}`);
    await app.main(`${mainWin}.setSize(900, 620)`);
    const narrow = await app.main(`${mainWin}.getSize()`);
    await overflowAt(`${narrow[0]}x${narrow[1]}`);
    await app.main(`${mainWin}.setSize(${startSize[0]}, ${startSize[1]})`);
    await sleep(500);
    step(`no horizontal overflow at ${startSize.join('x')} or ${narrow.join('x')}; ⋮ menu opens below its button inside the window and closes on outside click`);

    // Menu contents and keyboard use.
    await app.page(click('more'));
    assert.deepEqual(await app.page(menuItemsShown), ['Regenerate key points', 'Copy text', 'Share or export', 'Delete note']);
    const menuInfo = await app.page(`(() => { const sep = document.getElementById('menuSep'); const del = document.getElementById('remove');
      return { focus: document.activeElement.id, sepBeforeDelete: !sep.hidden && sep.nextElementSibling === del,
        danger: del.classList.contains('danger') && getComputedStyle(del).color !== getComputedStyle(document.getElementById('export')).color,
        expanded: document.getElementById('more').getAttribute('aria-expanded'), label: document.getElementById('more').getAttribute('aria-label') }; })()`);
    assert.deepEqual(menuInfo, { focus: 'refresh', sepBeforeDelete: true, danger: true, expanded: 'true', label: 'More actions' });
    const key = (k) => app.page(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }))`);
    const focused = () => app.page('document.activeElement.id');
    await key('ArrowDown');
    assert.equal(await focused(), 'copyText');
    await key('ArrowDown');
    assert.equal(await focused(), 'export');
    await key('ArrowDown');
    assert.equal(await focused(), 'remove');
    await key('ArrowDown');
    assert.equal(await focused(), 'refresh', 'ArrowDown wraps around');
    await key('End');
    assert.equal(await focused(), 'remove');
    await key('Escape');
    assert.equal(await app.page(menuOpen), false, 'Escape closes the menu');
    assert.equal(await focused(), 'more', 'focus returns to the ⋮ button');
    assert.equal(await app.page(`document.getElementById('more').getAttribute('aria-expanded')`), 'false');
    await key('ArrowUp');
    assert.equal(await app.page(menuOpen), true);
    assert.equal(await focused(), 'remove', 'ArrowUp on the button opens at the last item');
    await key('Escape');
    step('menu lists Regenerate, Copy text, Share or export and a separated red Delete; arrow keys, Home/End and Escape work');

    // Screenshot viewer: real mouse input through DevTools, note untouched.
    step('opening the screenshot viewer');
    const noteBJson = fs.readFileSync(path.join(store, idB, 'note.json'), 'utf8');
    const badgeB = await app.page(text('draftState'));
    const [natW, natH] = pngSize(path.join(store, idB, 'screenshot.png'));
    const rect = (sel) => app.page(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    const mouse = async (type, x, y, extra = {}) => app.input('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
    const clickAt = async (x, y) => { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); };
    const zoomPct = () => app.page(`parseInt(document.getElementById('vZoom').textContent, 10)`);
    const viewerOpen = `!document.getElementById('viewer').hidden`;
    const hint = await app.page(`(() => { const b = document.getElementById('zoomShot'); return { label: b.getAttribute('aria-label'), cursor: getComputedStyle(b).cursor, hint: !!b.querySelector('.zoom-hint') }; })()`);
    assert.deepEqual(hint, { label: 'Enlarge screenshot', cursor: 'zoom-in', hint: true });

    await app.page(`(() => { const b = document.getElementById('zoomShot'); b.focus(); b.click(); })()`);
    await waitFor(app, `${viewerOpen} && !document.getElementById('viewerImg').hidden && document.getElementById('viewerImg').naturalWidth > 0`, 'viewer open');
    await sleep(250);
    const view = await app.page(`(() => { const img = document.getElementById('viewerImg'); const r = img.getBoundingClientRect(); const s = document.getElementById('viewerStage').getBoundingClientRect();
      return { nat: [img.naturalWidth, img.naturalHeight], ratio: r.width / r.height, inside: r.left >= s.left - 1 && r.right <= s.right + 1 && r.top >= s.top - 1 && r.bottom <= s.bottom + 1,
        sameSrc: img.src === document.getElementById('shot').src, focus: document.activeElement.id,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`);
    assert.deepEqual(view.nat, [natW, natH], 'the stored full-size screenshot is shown');
    assert.ok(Math.abs(view.ratio - natW / natH) < 0.01, `aspect ratio kept (${view.ratio} vs ${natW / natH})`);
    assert.deepEqual({ inside: view.inside, sameSrc: view.sameSrc, focus: view.focus, overflow: view.overflow },
      { inside: true, sameSrc: true, focus: 'vClose', overflow: false });
    const fitPct = await zoomPct();
    assert.ok(fitPct > 0 && fitPct <= 100, `fits the window (${fitPct}%)`);
    if (process.env.NOTELY_E2E_SHOT) {
      const file = process.env.NOTELY_E2E_SHOT.replace(/\.png$/i, '-viewer.png');
      await app.main(`(async () => { __req('fs').writeFileSync(${JSON.stringify(file)}, (await ${mainWin}.webContents.capturePage()).toPNG()); })()`);
    }

    await app.page(click('vZoomIn'));
    assert.ok(await zoomPct() > fitPct, 'zoom in');
    await app.page(click('vZoomOut'));
    await app.page(click('vZoomOut'));
    assert.ok(await zoomPct() < fitPct, 'zoom out');
    await app.page(click('vReset'));
    assert.equal(await zoomPct(), 100, 'reset zoom = actual size');
    const stage = await rect('#viewerStage');
    const before = await app.page(`document.getElementById('viewerImg').style.transform`);
    assert.equal(await app.page(`document.getElementById('viewerStage').classList.contains('pannable')`), true);
    const cx = stage.x + stage.w / 2;
    const cy = stage.y + stage.h / 2;
    await mouse('mousePressed', cx, cy);
    await mouse('mouseMoved', cx - 120, cy - 80, { buttons: 1 });
    await mouse('mouseMoved', cx - 240, cy - 160, { buttons: 1 });
    await mouse('mouseReleased', cx - 240, cy - 160);
    const after = await app.page(`document.getElementById('viewerImg').style.transform`);
    assert.notEqual(after, before, 'dragging pans the zoomed image');
    assert.equal(await app.page(viewerOpen), true, 'dragging the image does not close the viewer');
    await clickAt(cx, cy);
    assert.equal(await app.page(viewerOpen), true, 'clicking the image does not close the viewer');
    const mainScroll = await app.page(`document.querySelector('main').scrollTop`);
    await app.input('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: -400 });
    await sleep(150);
    assert.ok(await zoomPct() > 100, 'mouse wheel zooms in');
    assert.equal(await app.page(`document.querySelector('main').scrollTop`), mainScroll, 'wheel does not scroll the page');
    await app.page(click('vFit'));
    assert.equal(await zoomPct(), fitPct, 'fit to window');
    await key('Escape');
    assert.equal(await app.page(viewerOpen), false, 'Escape closes the viewer');
    assert.equal(await focused(), 'zoomShot', 'focus returns to the screenshot');
    assert.equal(await app.page(`document.getElementById('viewerImg').hasAttribute('src')`), false, 'image released on close');

    await app.page(click('zoomShot'));
    await waitFor(app, `${viewerOpen} && document.getElementById('viewerImg').naturalWidth > 0`, 'viewer reopened');
    await sleep(200);
    const bar = await rect('.viewer-bar');
    await clickAt(stage.x + 5, stage.y + stage.h - 5);
    assert.equal(await app.page(viewerOpen), false, 'clicking the backdrop closes the viewer');
    assert.ok(bar.h > 0);
    assert.equal(fs.readFileSync(path.join(store, idB, 'note.json'), 'utf8'), noteBJson, 'viewing does not change the note');
    assert.equal(await app.page(text('draftState')), badgeB, 'save status unchanged');
    assert.equal(fs.readdirSync(path.join(store, idB)).sort().join(','), 'note.json,screenshot.png', 'no extra files');
    step(`viewer: ${natW}x${natH} screenshot at ${fitPct}% fit, zoom in/out, 100%, wheel, drag-pan, fit, Escape and backdrop close; note unchanged`);

    // 7. Share: copy text (no screenshot), then HTML with an opted-in screenshot.
    const jsonB = fs.readFileSync(path.join(store, idB, 'note.json'), 'utf8');
    await menuAction(app, 'copyText');
    await waitFor(app, `/Copied the note text/.test(${text('msg')})`, 'copied');
    const copied = await app.main(`__req('electron').clipboard.readText()`);
    assert.match(copied, new RegExp(readNote(store, idB).title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(copied, /^[\s\S]*Key points\n- /);
    assert.ok(!copied.includes('data:image'), 'copy never includes the screenshot');
    await app.main(`__req('electron').dialog.showSaveDialog = async (w, o) => { globalThis.__suggested = o.defaultPath; return { canceled: false, filePath: ${JSON.stringify(target)} }; }`);
    await completeShare(app, { format: 'html', includeShot: true });
    await waitFor(app, `/^Exported to /.test(${text('msg')})`, 'export done');
    assert.equal(await app.page(text('msg')), `Exported to ${target}`);
    const suggested = await app.main('globalThis.__suggested');
    assert.match(path.basename(suggested), /^[^<>:"/\\|?*]+\.html$/);
    const html = fs.readFileSync(target, 'utf8');
    const noteB = readNote(store, idB);
    const shotB64 = fs.readFileSync(path.join(store, idB, 'screenshot.png')).toString('base64');
    assert.ok(html.includes(`data:image/png;base64,${shotB64}`), 'screenshot embedded');
    for (const p of noteB.points) assert.ok(html.includes(p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')), p);
    const opened = await app.main(`(async () => { const { BrowserWindow } = __req('electron');
      const w = new BrowserWindow({ show: false, webPreferences: { javascript: true } });
      await w.loadFile(${JSON.stringify(target)});
      const r = await w.webContents.executeJavaScript('({ title: document.title, h1: document.querySelector("h1").textContent, img: document.images[0] ? document.images[0].naturalWidth : 0 })');
      w.destroy(); return r; })()`);
    assert.equal(opened.title, noteB.title);
    assert.ok(opened.img > 0, 'image renders');
    assert.equal(fs.readFileSync(path.join(store, idB, 'note.json'), 'utf8'), jsonB, 'export does not change the note');
    step(`exported ${target}; opens in a browser window with title and ${opened.img}px-wide screenshot`);

    await openShareDialog(app);
    for (const format of ['markdown', 'html', 'pdf']) {
      await selectShareFormat(app, 'png');
      assert.deepEqual(await shareOptions(app), {
        format: 'png', includeShot: true, includeDisabled: true, shotBoxHidden: true,
      });
      await selectShareFormat(app, format);
      const after = await shareOptions(app);
      assert.equal(after.format, format);
      assert.equal(after.includeShot, false, `PNG -> ${format} resets include screenshot`);
      assert.equal(after.includeDisabled, false);
      assert.equal(after.shotBoxHidden, false);
    }
    await app.page(click('shareCancel'));
    await waitFor(app, `document.getElementById('share').hidden`, 'share dialog closed after PNG switch');

    const htmlNoShot = path.join(exportDir, 'no-shot.html');
    await app.main(`__req('electron').dialog.showSaveDialog = async () => ({ canceled: false, filePath: ${JSON.stringify(htmlNoShot)} })`);
    await completeShare(app, { format: 'html', viaPng: true });
    await waitFor(app, `/^Exported to /.test(${text('msg')})`, 'html without screenshot');
    const htmlPlain = fs.readFileSync(htmlNoShot, 'utf8');
    assert.ok(htmlPlain.includes(noteB.title));
    assert.ok(!htmlPlain.includes('data:image'), 'HTML omits the screenshot unless opted in');

    const mdTarget = path.join(exportDir, 'note.md');
    await app.main(`__req('electron').dialog.showSaveDialog = async () => ({ canceled: false, filePath: ${JSON.stringify(mdTarget)} })`);
    await completeShare(app, { format: 'markdown', viaPng: true });
    await waitFor(app, `/^Exported to /.test(${text('msg')})`, 'markdown export');
    const md = fs.readFileSync(mdTarget, 'utf8');
    assert.ok(md.includes(`# ${noteB.title}`));
    assert.match(md, /## Key points/);
    assert.ok(!md.includes('data:image'), 'Markdown omits the screenshot unless opted in');

    const pdfTarget = path.join(exportDir, 'note.pdf');
    await app.main(`__req('electron').dialog.showSaveDialog = async () => ({ canceled: false, filePath: ${JSON.stringify(pdfTarget)} })`);
    await completeShare(app, { format: 'pdf', viaPng: true });
    await waitFor(app, `/^Exported to /.test(${text('msg')})`, 'pdf export', 40000);
    const pdfNoShot = fs.readFileSync(pdfTarget);
    assert.equal(pdfNoShot.subarray(0, 4).toString(), '%PDF');
    assert.ok(!pdfNoShot.includes(fs.readFileSync(path.join(store, idB, 'screenshot.png'))), 'PDF without opt-in does not embed the PNG bytes');

    const pdfShotTarget = path.join(exportDir, 'note-shot.pdf');
    await app.main(`__req('electron').dialog.showSaveDialog = async () => ({ canceled: false, filePath: ${JSON.stringify(pdfShotTarget)} })`);
    await completeShare(app, { format: 'pdf', includeShot: true });
    await waitFor(app, `/^Exported to /.test(${text('msg')})`, 'pdf with screenshot', 40000);
    const pdfShot = fs.readFileSync(pdfShotTarget);
    assert.equal(pdfShot.subarray(0, 4).toString(), '%PDF');
    assert.match(pdfShot.toString('latin1'), /\/Subtype\s*\/Image/, 'opted-in PDF contains an image XObject');
    assert.ok(pdfShot.length > pdfNoShot.length, 'PDF with screenshot is larger than the text-only PDF');

    const pngTarget = path.join(exportDir, 'shot.png');
    await app.main(`__req('electron').dialog.showSaveDialog = async () => ({ canceled: false, filePath: ${JSON.stringify(pngTarget)} })`);
    await completeShare(app, { format: 'png' });
    await waitFor(app, `/^Exported to /.test(${text('msg')})`, 'png export');
    assert.ok(fs.readFileSync(pngTarget).equals(fs.readFileSync(path.join(store, idB, 'screenshot.png'))));
    step('share also writes HTML without screenshot, Markdown, PDF (with and without screenshot) and the original PNG');

    await openShareDialog(app);
    await app.page(click('shareCancel'));
    await waitFor(app, `document.getElementById('share').hidden`, 'share dialog cancelled');

    // 8. Cancel export, and refuse to silently overwrite.
    await app.main(`__req('electron').dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' })`);
    await completeShare(app, { format: 'html' });
    await waitFor(app, `/Export cancelled/.test(${text('msg')})`, 'export cancelled');
    const exported = fs.readFileSync(target);
    await app.main(`(() => { const { dialog } = __req('electron');
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: ${JSON.stringify(target)} });
      dialog.showMessageBox = async () => { globalThis.__replaceAsked = true; return { response: 1 }; }; })()`);
    await completeShare(app, { format: 'html' });
    await waitFor(app, `/Export cancelled/.test(${text('msg')})`, 'overwrite declined');
    assert.equal(await app.main('globalThis.__replaceAsked'), true);
    assert.ok(fs.readFileSync(target).equals(exported));
    assert.equal(fs.readFileSync(path.join(store, idB, 'note.json'), 'utf8'), jsonB);
    assert.equal(await app.page(text('draftState')).then((s) => s.startsWith('Saved')), true);
    step('cancelled export and declined overwrite leave the note and existing file unchanged');

    // Save failure: error shown, edits kept, nothing claimed.
    await app.page(type('points', 'Unsaved extra point'));
    await app.main(`(() => { const fs = __req('fs'); globalThis.__rename = fs.renameSync;
      fs.renameSync = (a, b) => { if (String(b).endsWith('note.json')) { const e = new Error('no space'); e.code = 'ENOSPC'; throw e; } return globalThis.__rename(a, b); }; })()`);
    const failMsg = await save(app);
    await app.main(`__req('fs').renameSync = globalThis.__rename`);
    assert.match(failMsg, /disk is full/i);
    assert.equal(await app.page(val('points')), 'Unsaved extra point');
    assert.equal(await app.page(text('draftState')), 'Not saved');
    assert.equal(await app.page(`document.getElementById('draftState').classList.contains('error')`), true);
    assert.equal(fs.readFileSync(path.join(store, idB, 'note.json'), 'utf8'), jsonB);
    step(`save failure reported ("${failMsg}"); edits kept; stored note unchanged`);

    // Switching notes with unsaved changes asks first.
    await app.page('window.confirm = () => false');
    await app.page(`document.querySelector('[data-id=${JSON.stringify(idA)}]').click()`);
    await sleep(300);
    assert.equal(await app.page(val('points')), 'Unsaved extra point');
    step('switching notes with unsaved changes asks first; "Cancel" keeps the edits');

    // Closing with unsaved changes asks first.
    await app.main(`(() => { const { dialog, BrowserWindow } = __req('electron'); globalThis.__asked = 0;
      dialog.showMessageBoxSync = () => { globalThis.__asked++; return 1; };
      BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Notely' && w.isResizable() && w.isVisible()).close(); })()`);
    await sleep(800);
    assert.equal(await app.main('globalThis.__asked'), 1);
    assert.equal(await app.page(val('points')), 'Unsaved extra point');
    step('closing with unsaved changes asks first; "Keep editing" keeps the window');
  } finally {
    await app.close();
  }

  // A note whose screenshot file is unreadable (test profile only).
  const brokenId = '2026-10-09-20-00-broken-screenshot-note';
  fs.mkdirSync(path.join(store, brokenId));
  fs.writeFileSync(path.join(store, brokenId, 'note.json'), JSON.stringify({
    ...readNote(store, idA), title: 'Broken screenshot note', starred: false, screenshot: 'screenshot.png',
  }));
  fs.writeFileSync(path.join(store, brokenId, 'screenshot.png'), 'not a png');

  app = await launch();
  try {
    // 3. Edit persisted; 4. header star persisted.
    await app.page(`document.querySelector('[data-id=${JSON.stringify(idA)}]').click()`);
    await waitFor(app, `${val('title')} === 'Photosynthesis basics'`, 'note A reopened');
    assert.match(await app.page(val('raw')), /Mitochondria are a separate topic\./);
    assert.equal(await app.page(`document.querySelector('[data-star=${JSON.stringify(idB)}]').classList.contains('on')`), true);
    step('after second restart: edit and both stars persisted');

    // Missing and unreadable screenshots are handled without errors.
    assert.equal(await app.page(`document.getElementById('zoomShot').hidden && !document.getElementById('shotEmpty').hidden`), true, 'note without a screenshot shows the placeholder');
    await app.page(`document.querySelector('[data-id=${JSON.stringify(brokenId)}]').click()`);
    await waitFor(app, `${val('title')} === 'Broken screenshot note'`, 'broken note open');
    await waitFor(app, `document.getElementById('zoomShot').hidden && /could not be displayed/.test(${text('shotEmpty')})`, 'unreadable screenshot message');
    await app.page('openViewer()');
    await waitFor(app, `!document.getElementById('viewerError').hidden`, 'viewer error');
    await app.page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    assert.equal(await app.page(`document.getElementById('viewer').hidden`), true);
    assert.equal(await app.page(text('draftState')).then((s) => s.startsWith('Saved')), true);
    assert.deepEqual(fs.readFileSync(path.join(store, brokenId, 'screenshot.png')), Buffer.from('not a png'), 'broken file left as is');
    await app.page(`document.querySelector('[data-id=${JSON.stringify(idA)}]').click()`);
    await waitFor(app, `${val('title')} === 'Photosynthesis basics'`, 'note A reopened for delete');
    step('missing screenshot shows a placeholder; an unreadable one shows a message in the card and the viewer');

    // 9. Delete only the chosen note and its internal data.
    const others = noteIds(store).filter((i) => i !== idA);
    await app.page(`window.confirm = () => false`);
    await menuAction(app, 'remove');
    await sleep(300);
    assert.ok(fs.existsSync(path.join(store, idA, 'note.json')), 'declining the confirmation keeps the note');
    await app.page(`window.confirm = (m) => { window.__msg = m; return true; }`);
    await menuAction(app, 'remove');
    await waitFor(app, `/^Note deleted/.test(${text('msg')})`, 'delete');
    assert.match(await app.page('window.__msg'), /Permanently delete "Photosynthesis basics" from Notely\? This removes the note and its screenshot\. This cannot be undone\. Files you already exported are not deleted\./);
    assert.equal(fs.existsSync(path.join(store, idA)), false);
    assert.deepEqual(noteIds(store).sort(), others.sort());
    assert.ok(fs.existsSync(path.join(store, idB, 'screenshot.png')));
    assert.ok(fs.existsSync(target), 'exported file is not deleted');
    assert.equal(hashTree(oldFolder), oldHash);
    step('delete removed only that note\'s internal folder; other notes, export and originals kept');
  } finally {
    await app.close();
  }
  const earlierLog = app.log();

  app = await launch();
  try {
    await geminiSession(app);
  } finally {
    await app.close();
  }

  const errors = `${earlierLog}\n${app.log()}`.split('\n').filter((l) => l.startsWith('Renderer:'));
  assert.deepEqual(errors, [], 'no renderer errors');

  // 1 + 14. Nothing written to Downloads; the user's real notes and settings untouched.
  assert.deepEqual(watched.map(snapshotDir), before, 'no new files in Downloads folders');
  if (realCfg !== null) {
    assert.equal(fs.readFileSync(realCfgFile, 'utf8'), realCfg);
    assert.equal(hashTree(realOld), realHash);
  }
  step(`no files created in ${watched.join(' or ')}; real notes and settings unchanged`);
  console.log('ui e2e: ok');
}

main()
  .catch((err) => {
    console.error('ui e2e FAILED:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
