'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const storage = require('../storage');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notely-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const at = (iso) => new Date(iso);

function save(root, payload, now) {
  const res = storage.saveNote(root, payload, now);
  return { ...res, folder: path.join(root, res.id) };
}

test('create: files are written and the note lists and loads back', (t) => {
  const root = tmpRoot(t);
  const res = save(root, {
    title: 'Python Lists', points: ['Lists are ordered'], raw: 'Details', ocrText: 'RAW OCR', ocrClean: 'clean', shot: PNG,
  }, at('2026-10-09T10:00:00Z'));
  assert.equal(res.created, true);
  assert.deepEqual(fs.readdirSync(res.folder).sort(), ['note.json', 'screenshot.png']);
  const { notes } = storage.listNotes(root);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, 'Python Lists');
  assert.equal(notes[0].pointCount, 1);
  const note = storage.loadNote(root, res.id);
  assert.deepEqual(note.points, ['Lists are ordered']);
  assert.equal(note.ocrText, 'RAW OCR');
  assert.equal(note.createdAt, Date.parse('2026-10-09T10:00:00Z'));
  assert.match(note.shot, /^data:image\/png;base64,/);
  assert.equal(fs.readdirSync(res.folder).some((f) => f.includes('.tmp-')), false);
});

test('persists across a process restart', (t) => {
  const root = tmpRoot(t);
  const { id } = save(root, { title: 'Restart check', points: ['Survives restart'] });
  const script = `const s=require(${JSON.stringify(path.join(__dirname, '..', 'storage.js'))});` +
    `process.stdout.write(JSON.stringify(s.loadNote(${JSON.stringify(root)}, ${JSON.stringify(id)}).points))`;
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), ['Survives restart']);
});

test('edit: changes persist, createdAt is kept, updatedAt advances, screenshot kept', (t) => {
  const root = tmpRoot(t);
  const first = save(root, { title: 'Draft', points: ['One'], shot: PNG }, at('2026-10-09T10:00:00Z'));
  const second = save(root, {
    id: first.id, baseUpdatedAt: first.updatedAt, title: 'Edited title', points: ['One', 'Two'], raw: 'more', shot: null,
  }, at('2026-10-09T11:00:00Z'));
  assert.equal(second.id, first.id);
  assert.equal(second.created, false);
  const note = storage.loadNote(root, first.id);
  assert.equal(note.title, 'Edited title');
  assert.deepEqual(note.points, ['One', 'Two']);
  assert.equal(note.createdAt, first.createdAt);
  assert.ok(note.updatedAt > first.updatedAt);
  assert.ok(note.shot, 'existing screenshot is not removed by an edit');
  assert.equal(storage.listNotes(root).notes.length, 1);
});

test('same title in the same minute never overwrites an existing note', (t) => {
  const root = tmpRoot(t);
  const now = at('2026-10-09T10:00:00Z');
  const a = save(root, { title: 'Same', points: ['A'] }, now);
  const b = save(root, { title: 'Same', points: ['B'] }, now);
  const c = save(root, { title: 'Same', points: ['C'] }, now);
  assert.notEqual(a.id, b.id);
  assert.equal(b.id, `${a.id}-2`);
  assert.equal(c.id, `${a.id}-3`);
  assert.deepEqual(storage.loadNote(root, a.id).points, ['A']);
  assert.deepEqual(storage.loadNote(root, b.id).points, ['B']);
});

test('delete removes only the chosen note and keeps unrelated files', (t) => {
  const root = tmpRoot(t);
  const keep = save(root, { title: 'Keep me', points: ['k'] });
  const gone = save(root, { title: 'Delete me', points: ['d'], shot: PNG });
  const shared = save(root, { title: 'Has extra file', points: ['x'] });
  fs.writeFileSync(path.join(shared.folder, 'my-own-file.txt'), 'user data');

  assert.deepEqual(storage.deleteNote(root, gone.id), { id: gone.id, keptFolder: false });
  assert.equal(fs.existsSync(gone.folder), false);
  assert.equal(storage.loadNote(root, keep.id).title, 'Keep me');

  const res = storage.deleteNote(root, shared.id);
  assert.equal(res.keptFolder, true);
  assert.equal(fs.readFileSync(path.join(shared.folder, 'my-own-file.txt'), 'utf8'), 'user data');
  assert.deepEqual(storage.listNotes(root).notes.map((n) => n.id), [keep.id]);
});

test('invalid folder: a file path or relative path is rejected with an error', (t) => {
  const root = tmpRoot(t);
  const file = path.join(root, 'not-a-folder.txt');
  fs.writeFileSync(file, 'x');
  assert.throws(() => storage.probeDir(file), (err) => err instanceof storage.StorageError && /not a folder/.test(err.message));
  assert.throws(() => storage.probeDir('relative/notes'), { code: 'EINVAL' });
  assert.throws(() => save(file, { title: 'x', points: ['y'] }), (err) => err instanceof storage.StorageError);
  assert.equal(fs.readFileSync(file, 'utf8'), 'x');
});

test('a failed write reports an error and leaves no partial new note', (t) => {
  const root = tmpRoot(t);
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to.endsWith('note.json')) throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
    return realRename(from, to);
  };
  t.after(() => { fs.renameSync = realRename; });
  assert.throws(
    () => save(root, { title: 'Will fail', points: ['p'], shot: PNG }),
    (err) => err instanceof storage.StorageError && /disk is full/i.test(err.message),
  );
  fs.renameSync = realRename;
  assert.deepEqual(fs.readdirSync(root), []);
});

test('a failed edit reports an error and keeps the previous saved version', (t) => {
  const root = tmpRoot(t);
  const first = save(root, { title: 'Original', points: ['old'] });
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to.endsWith('note.json')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return realRename(from, to);
  };
  t.after(() => { fs.renameSync = realRename; });
  assert.throws(
    () => save(root, { id: first.id, baseUpdatedAt: first.updatedAt, title: 'Changed', points: ['new'] }),
    (err) => err instanceof storage.StorageError && /permission/i.test(err.message),
  );
  fs.renameSync = realRename;
  const note = storage.loadNote(root, first.id);
  assert.equal(note.title, 'Original');
  assert.deepEqual(note.points, ['old']);
  assert.equal(fs.readdirSync(first.folder).some((f) => f.includes('.tmp-')), false);
});

test('stale edit is refused instead of overwriting newer changes', (t) => {
  const root = tmpRoot(t);
  const first = save(root, { title: 'T', points: ['1'] }, at('2026-10-09T10:00:00Z'));
  save(root, { id: first.id, baseUpdatedAt: first.updatedAt, title: 'T', points: ['2'] }, at('2026-10-09T10:05:00Z'));
  assert.throws(
    () => save(root, { id: first.id, baseUpdatedAt: first.updatedAt, title: 'T', points: ['3'] }, at('2026-10-09T10:06:00Z')),
    { code: 'ECONFLICT' },
  );
  assert.deepEqual(storage.loadNote(root, first.id).points, ['2']);
});

test('saving a note whose folder was removed reports EMISSING', (t) => {
  const root = tmpRoot(t);
  const first = save(root, { title: 'Moved', points: ['p'] });
  fs.rmSync(first.folder, { recursive: true });
  assert.throws(() => save(root, { id: first.id, title: 'Moved', points: ['p'] }), { code: 'EMISSING' });
});

test('empty notes and unsafe ids are rejected', (t) => {
  const root = tmpRoot(t);
  assert.throws(() => save(root, { title: 'Empty', points: [] }), { code: 'EEMPTY' });
  assert.throws(() => storage.loadNote(root, '../secret'), { code: 'EINVAL' });
  assert.throws(() => storage.deleteNote(root, '..\\x'), { code: 'EINVAL' });
});

test('legacy notes (only `at`) still list, load and can be edited', (t) => {
  const root = tmpRoot(t);
  const id = '2026-10-09-18-08-legacy-note';
  const dir = path.join(root, id);
  fs.mkdirSync(dir);
  const legacyAt = Date.parse('2026-10-09T18:08:00Z');
  fs.writeFileSync(path.join(dir, 'note.json'), JSON.stringify({ title: 'Old', points: ['a'], raw: 'r', at: legacyAt }));
  fs.writeFileSync(path.join(dir, 'screenshot.png'), Buffer.from(PNG.split(',')[1], 'base64'));

  const listed = storage.listNotes(root).notes[0];
  assert.equal(listed.createdAt, legacyAt);
  assert.equal(listed.updatedAt, legacyAt);
  const note = storage.loadNote(root, id);
  assert.equal(note.raw, 'r');
  assert.ok(note.shot);

  save(root, { id, baseUpdatedAt: note.updatedAt, title: 'Old', points: ['a', 'b'], raw: 'r' });
  const after = storage.loadNote(root, id);
  assert.deepEqual(after.points, ['a', 'b']);
  assert.equal(after.createdAt, legacyAt);
  assert.ok(after.shot, 'legacy screenshot preserved');
});

test('note.json records id, title, timestamps, star and screenshot; no Markdown copy', (t) => {
  const root = tmpRoot(t);
  const res = save(root, { title: 'Cells', points: ['p'], shot: PNG, capturedAt: 1791570430308 });
  assert.equal(res.title, 'Cells');
  const json = JSON.parse(fs.readFileSync(path.join(res.folder, 'note.json'), 'utf8'));
  assert.equal(json.id, res.id);
  assert.equal(json.screenshot, 'screenshot.png');
  assert.equal(json.capturedAt, 1791570430308);
  assert.equal(json.starred, false);
  assert.equal(typeof json.createdAt, 'number');
  assert.equal(fs.existsSync(path.join(res.folder, 'note.md')), false);
});

test('star/unstar persists and changes nothing else; edits keep the star', (t) => {
  const root = tmpRoot(t);
  const res = save(root, { title: 'Star me', points: ['p'], raw: 'body' }, at('2026-10-09T10:00:00Z'));
  const before = fs.readFileSync(path.join(res.folder, 'note.json'), 'utf8');
  assert.deepEqual(storage.setStarred(root, res.id, true), { id: res.id, starred: true });
  const after = JSON.parse(fs.readFileSync(path.join(res.folder, 'note.json'), 'utf8'));
  assert.deepEqual({ ...after, starred: false }, JSON.parse(before));
  assert.equal(storage.listNotes(root).notes[0].starred, true);
  assert.equal(storage.loadNote(root, res.id).starred, true);

  const edited = save(root, { id: res.id, baseUpdatedAt: res.updatedAt, title: 'Star me', points: ['p', 'q'] }, at('2026-10-09T11:00:00Z'));
  assert.equal(edited.starred, true);
  storage.setStarred(root, res.id, false);
  assert.equal(storage.loadNote(root, res.id).starred, false);
  assert.throws(() => storage.setStarred(root, res.id, 'yes'), { code: 'EINVAL' });
  assert.throws(() => storage.setStarred(root, '../x', true), { code: 'EINVAL' });
});

test('list includes lowercase search text from title, key points and notes', (t) => {
  const root = tmpRoot(t);
  save(root, { title: 'Photosynthesis', points: ['Chlorophyll absorbs LIGHT'], raw: 'Happens in the Leaves' });
  const [n] = storage.listNotes(root).notes;
  for (const term of ['photosynthesis', 'chlorophyll', 'light', 'leaves']) assert.ok(n.search.includes(term), term);
});

test('import copies old notes once, keeps originals, and never duplicates', (t) => {
  const root = tmpRoot(t);
  const old = path.join(root, 'old-folder');
  const store = path.join(root, 'store');
  fs.mkdirSync(store);
  const a = path.join(old, '2026-10-09-18-08-old-a');
  const b = path.join(old, '2026-10-09-18-28-old-b');
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(a, 'note.json'), JSON.stringify({ title: 'Old A', points: ['x'], raw: 'r', at: 1000 }));
  fs.writeFileSync(path.join(a, 'note.md'), '# Old A');
  fs.writeFileSync(path.join(a, 'screenshot.png'), Buffer.from(PNG.split(',')[1], 'base64'));
  fs.writeFileSync(path.join(b, 'note.json'), JSON.stringify({ version: 2, title: 'Old B', points: ['y'], createdAt: 5, updatedAt: 6 }));
  fs.mkdirSync(path.join(old, 'not-a-note'));
  fs.writeFileSync(path.join(old, 'random.txt'), 'keep');
  const snapshot = () => fs.readdirSync(old, { recursive: true }).sort().map((f) => {
    const p = path.join(old, f);
    return fs.statSync(p).isFile() ? `${f}:${fs.readFileSync(p).toString('base64')}` : f;
  });
  const original = snapshot();

  const first = storage.importNotes(old, store);
  assert.equal(first.imported.length, 2);
  const listed = storage.listNotes(store).notes;
  assert.deepEqual(listed.map((n) => n.title).sort(), ['Old A', 'Old B']);
  const noteA = storage.loadNote(store, '2026-10-09-18-08-old-a');
  assert.equal(noteA.createdAt, 1000);
  assert.ok(noteA.shot);
  assert.deepEqual(snapshot(), original, 'source files untouched');

  assert.equal(storage.importNotes(old, store).imported.length, 0, 'second run imports nothing');
  storage.deleteNote(store, '2026-10-09-18-28-old-b');
  const again = storage.importNotes(old, store, new Set(first.imported.map((i) => i.from)));
  assert.equal(again.imported.length, 0, 'deleted imported note is not resurrected');
  assert.equal(storage.listNotes(store).notes.length, 1);
});

test('import gives a new id when the internal store already has that id', (t) => {
  const root = tmpRoot(t);
  const old = path.join(root, 'old');
  const store = path.join(root, 'store');
  fs.mkdirSync(path.join(old, 'same-id'), { recursive: true });
  fs.mkdirSync(path.join(store, 'same-id'), { recursive: true });
  fs.writeFileSync(path.join(old, 'same-id', 'note.json'), JSON.stringify({ title: 'From old', points: ['o'] }));
  fs.writeFileSync(path.join(store, 'same-id', 'note.json'), JSON.stringify({ title: 'Already here', points: ['h'] }));
  const res = storage.importNotes(old, store);
  assert.deepEqual(res.imported.map((i) => i.id), ['same-id-2']);
  assert.equal(storage.loadNote(store, 'same-id').title, 'Already here');
  assert.equal(storage.loadNote(store, 'same-id-2').title, 'From old');
});

test('empty title gets a dated fallback; an edit with a cleared title keeps the saved title', (t) => {
  const root = tmpRoot(t);
  const screen = save(root, { title: '   ', points: ['p'], capturedAt: Date.now() });
  assert.match(screen.title, /^Screen Notes - /);
  const spoken = save(root, { title: '', points: ['p'] });
  assert.match(spoken.title, /^Notes - /);
  const edited = save(root, { id: screen.id, baseUpdatedAt: screen.updatedAt, title: '', points: ['p', 'q'] });
  assert.equal(edited.title, screen.title);
  assert.equal(edited.id, screen.id);
});

test('titles with unsafe characters produce safe folder names inside the notes folder', (t) => {
  const root = tmpRoot(t);
  for (const title of ['../../evil', 'C:\\Windows\\x', 'a/b:c*d?"e<f>g|h', 'CON', '   ']) {
    const res = save(root, { title, points: ['p'] });
    assert.equal(path.dirname(res.folder), path.resolve(root), title);
    assert.match(res.id, /^[a-z0-9][a-z0-9._-]*$/i, title);
  }
  assert.equal(storage.listNotes(root).notes.length, 5);
  assert.equal(fs.existsSync(path.join(root, '..', 'evil')), false);
});

test('similar titles saved together never overwrite each other', (t) => {
  const root = tmpRoot(t);
  const now = at('2026-10-09T10:00:00Z');
  const a = save(root, { title: 'Python Lists!', points: ['a'] }, now);
  const b = save(root, { title: 'Python lists', points: ['b'] }, now);
  assert.notEqual(a.id, b.id);
  assert.deepEqual(storage.loadNote(root, a.id).points, ['a']);
  assert.deepEqual(storage.loadNote(root, b.id).points, ['b']);
});

test('unreadable note folders are reported, not silently hidden', (t) => {
  const root = tmpRoot(t);
  save(root, { title: 'Good', points: ['g'] });
  fs.mkdirSync(path.join(root, 'broken-note'));
  fs.writeFileSync(path.join(root, 'broken-note', 'note.json'), '{not json');
  const res = storage.listNotes(root);
  assert.equal(res.notes.length, 1);
  assert.deepEqual(res.unreadable, ['broken-note']);
});
