'use strict';

// Note storage inside Notely's own data folder. One folder per note:
//   <notes root>/<id>/note.json      (source of truth)
//   <notes root>/<id>/screenshot.png (optional)
// Older versions also wrote note.md into a user-chosen folder; those folders
// are only read (imported), never modified.
// No Electron imports so it can be tested with plain Node.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { makeNoteId, isSafeNoteId, pngFromDataUrl } = require('./logic');
const { fallbackTitle } = require('./notes-pipeline');

const NOTE_FILES = ['note.json', 'note.md', 'screenshot.png'];
const LIMITS = { title: 200, point: 2000, points: 100, text: 200000, shotBytes: 25 * 1024 * 1024 };

class StorageError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function friendlyFsError(err, dir) {
  const where = dir ? ` (${dir})` : '';
  switch (err && err.code) {
    case 'ENOENT': return `The folder is not available${where}.`;
    case 'EACCES':
    case 'EPERM': return `Notely does not have permission to write there${where}.`;
    case 'ENOSPC': return 'The disk is full. Free some space, then try again.';
    case 'EROFS': return `The location is read-only${where}.`;
    case 'EEXIST':
    case 'ENOTDIR': return `The location is a file, not a folder${where}.`;
    case 'EBUSY': return 'A note file is locked by another program. Try saving again.';
    default: return (err && err.message) || 'A file operation failed.';
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Write to a temporary file, flush it, then rename over the target so a crash
// or failed write never leaves a half-written note behind.
function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        break;
      } catch (err) {
        // Windows: antivirus or sync tools can briefly lock the target file.
        if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
        sleepSync(40 * (attempt + 1));
      }
    }
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
}

// Confirms the folder exists (creating it if needed) and is really writable.
function probeDir(dir) {
  if (typeof dir !== 'string' || !dir || !path.isAbsolute(dir)) {
    throw new StorageError('The notes folder must be an absolute path.', 'EINVAL');
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.statSync(dir).isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
    const probe = path.join(dir, `.notely-write-test-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (err) {
    throw new StorageError(friendlyFsError(err, dir), err.code);
  }
  return path.resolve(dir);
}

function noteDir(root, id) {
  if (!isSafeNoteId(id)) throw new StorageError('Invalid note id.', 'EINVAL');
  const base = path.resolve(root);
  const dir = path.resolve(base, id);
  if (path.dirname(dir) !== base) throw new StorageError('Invalid note id.', 'EINVAL');
  return dir;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function normalizeStored(id, json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new StorageError('Corrupt note file.', 'ECORRUPT');
  const legacyAt = Number(json.at) || 0;
  const createdAt = Number(json.createdAt) || legacyAt;
  const updatedAt = Number(json.updatedAt) || legacyAt || createdAt;
  return {
    id,
    title: String(json.title || 'Untitled note'),
    points: Array.isArray(json.points) ? json.points.map(String) : [],
    raw: String(json.raw || ''),
    transcript: String(json.transcript || ''),
    ocrText: String(json.ocrText || ''),
    ocrClean: String(json.ocrClean || ''),
    capturedAt: Number(json.capturedAt) || 0,
    createdAt,
    updatedAt,
    starred: json.starred === true,
    importedFrom: typeof json.importedFrom === 'string' ? json.importedFrom : '',
  };
}

const SEARCH_CHARS = 20000;

function searchText(n) {
  const fields = [n.title, ...(n.points || []), n.raw, n.transcript, n.ocrClean]
    .map((s) => String(s == null ? '' : s).toLowerCase());
  const joined = fields.join('\n');
  if (joined.length <= SEARCH_CHARS) return joined;
  // Fair share so a long notes field cannot drop cleaned OCR (or the reverse).
  const share = Math.max(1, Math.floor(SEARCH_CHARS / Math.max(1, fields.length)));
  const clipped = fields.map((s) => s.slice(0, share));
  let spare = SEARCH_CHARS - clipped.reduce((sum, s) => sum + s.length, 0);
  for (let i = 0; i < fields.length && spare > 0; i++) {
    const extra = fields[i].slice(clipped[i].length, clipped[i].length + spare);
    clipped[i] += extra;
    spare -= extra.length;
  }
  return clipped.join('\n').slice(0, SEARCH_CHARS);
}

function listNotes(root) {
  let names;
  try {
    names = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    throw new StorageError(friendlyFsError(err, root), err.code);
  }
  const notes = [];
  const unreadable = [];
  for (const entry of names) {
    if (!entry.isDirectory() || !isSafeNoteId(entry.name)) continue;
    const file = path.join(root, entry.name, 'note.json');
    if (!fs.existsSync(file)) continue;
    try {
      const n = normalizeStored(entry.name, readJson(file));
      notes.push({
        id: n.id,
        title: n.title,
        pointCount: n.points.length,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
        starred: n.starred,
        search: searchText(n),
      });
    } catch {
      unreadable.push(entry.name);
    }
  }
  notes.sort((a, b) => b.updatedAt - a.updatedAt);
  return { notes, unreadable };
}

function loadNote(root, id) {
  const dir = noteDir(root, id);
  const file = path.join(dir, 'note.json');
  if (!fs.existsSync(file)) throw new StorageError('This note no longer exists. It may have been deleted.', 'ENOENT');
  let note;
  try {
    note = normalizeStored(id, readJson(file));
  } catch (err) {
    if (err instanceof StorageError) throw err;
    throw new StorageError(`This note could not be read (${err.message}).`, 'ECORRUPT');
  }
  const png = path.join(dir, 'screenshot.png');
  note.shot = fs.existsSync(png) ? 'data:image/png;base64,' + fs.readFileSync(png).toString('base64') : null;
  note.folder = dir;
  return note;
}

function cleanPayload(payload) {
  if (!payload || typeof payload !== 'object') throw new StorageError('Invalid note.', 'EINVAL');
  const text = (v) => String(v == null ? '' : v).slice(0, LIMITS.text);
  const title = String(payload.title || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMITS.title);
  const points = Array.isArray(payload.points)
    ? payload.points.map((p) => String(p).trim().slice(0, LIMITS.point)).filter(Boolean).slice(0, LIMITS.points)
    : [];
  let png = null;
  if (payload.shot != null) {
    png = pngFromDataUrl(payload.shot);
    if (!png) throw new StorageError('The screenshot data is not a valid PNG image.', 'EINVAL');
    if (png.length > LIMITS.shotBytes) throw new StorageError('The screenshot is too large to save.', 'EINVAL');
  }
  return {
    id: payload.id == null ? null : payload.id,
    baseUpdatedAt: Number(payload.baseUpdatedAt) || 0,
    title,
    points,
    raw: text(payload.raw).trim(),
    transcript: text(payload.transcript).trim(),
    ocrText: text(payload.ocrText),
    ocrClean: text(payload.ocrClean),
    capturedAt: Number(payload.capturedAt) || 0,
    png,
  };
}

// Claims a brand-new folder; mkdir without `recursive` fails if it exists,
// so two notes can never share (and overwrite) a folder.
function claimNewDir(root, title, now) {
  const base = makeNoteId(title, now);
  for (let i = 1; i <= 500; i++) {
    const id = i === 1 ? base : `${base}-${i}`;
    const dir = noteDir(root, id);
    try {
      fs.mkdirSync(dir);
      return { id, dir };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new StorageError('Could not create a unique folder for this note.', 'EEXIST');
}

function saveNote(root, payload, now = new Date()) {
  const p = cleanPayload(payload);
  if (!p.points.length && !p.raw && !p.transcript && !p.png && !p.ocrClean) {
    throw new StorageError('Nothing to save yet.', 'EEMPTY');
  }
  probeDir(root);

  let id;
  let dir;
  let createdAt = now.getTime();
  let isNew = false;
  let existing = null;
  if (p.id != null) {
    dir = noteDir(root, p.id);
    const file = path.join(dir, 'note.json');
    if (!fs.existsSync(file)) {
      throw new StorageError('This note is no longer in the notes folder (moved or deleted). Save again to store it as a new note.', 'EMISSING');
    }
    existing = normalizeStored(p.id, readJson(file));
    if (p.baseUpdatedAt && existing.updatedAt && existing.updatedAt !== p.baseUpdatedAt) {
      throw new StorageError('This note changed on disk after you opened it. Reopen it before saving so newer changes are not overwritten.', 'ECONFLICT');
    }
    id = p.id;
    createdAt = existing.createdAt || createdAt;
    // A cleared title keeps the saved one instead of renaming the note.
    if (!p.title) p.title = existing.title;
  } else {
    if (!p.title) p.title = fallbackTitle(p.capturedAt ? new Date(p.capturedAt) : now, p.capturedAt ? 'Screen Notes' : 'Notes');
    ({ id, dir } = claimNewDir(root, p.title, now));
    isNew = true;
  }

  const updatedAt = Math.max(now.getTime(), createdAt);
  const record = {
    version: 2,
    id,
    title: p.title,
    points: p.points,
    raw: p.raw,
    transcript: p.transcript,
    ocrText: p.ocrText,
    ocrClean: p.ocrClean,
    capturedAt: p.capturedAt,
    createdAt,
    updatedAt,
    at: updatedAt,
    starred: existing ? existing.starred : false,
  };
  if (existing && existing.importedFrom) record.importedFrom = existing.importedFrom;

  try {
    const pngPath = path.join(dir, 'screenshot.png');
    if (p.png) writeFileAtomic(pngPath, p.png);
    record.screenshot = fs.existsSync(pngPath) ? 'screenshot.png' : null;
    // note.json is written last: a note only "exists" once this succeeds.
    writeFileAtomic(path.join(dir, 'note.json'), JSON.stringify(record, null, 2));
    const check = readJson(path.join(dir, 'note.json'));
    if (check.updatedAt !== updatedAt || check.title !== record.title) {
      throw new StorageError('The note could not be verified after saving.', 'EVERIFY');
    }
  } catch (err) {
    if (isNew) {
      for (const f of NOTE_FILES) {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* not written */ }
      }
      try { fs.rmdirSync(dir); } catch { /* not empty or already gone */ }
    }
    if (err instanceof StorageError) throw err;
    throw new StorageError(friendlyFsError(err, root), err.code);
  }

  return {
    id, title: record.title, createdAt, updatedAt, starred: record.starred, created: isNew,
  };
}

// Changes only the star; content and timestamps stay as they are.
function setStarred(root, id, starred) {
  if (typeof starred !== 'boolean') throw new StorageError('Invalid star value.', 'EINVAL');
  const file = path.join(noteDir(root, id), 'note.json');
  if (!fs.existsSync(file)) throw new StorageError('This note no longer exists.', 'ENOENT');
  let json;
  try {
    json = readJson(file);
  } catch (err) {
    throw new StorageError(`This note could not be read (${err.message}).`, 'ECORRUPT');
  }
  normalizeStored(id, json);
  json.starred = starred;
  try {
    writeFileAtomic(file, JSON.stringify(json, null, 2));
  } catch (err) {
    throw new StorageError(friendlyFsError(err, root), err.code);
  }
  return { id, starred };
}

// Copies notes from an old notes folder (note.json + screenshot.png) into the
// internal store. Source files are only read. A source note is imported once:
// `alreadyImported` holds source paths done earlier, and imported notes record
// `importedFrom`, so restarts never create duplicates.
function importNotes(sourceRoot, root, alreadyImported = new Set()) {
  const result = { imported: [], failed: [] };
  let entries;
  try {
    entries = fs.readdirSync(sourceRoot, { withFileTypes: true });
  } catch {
    return result;
  }
  const key = (p) => path.resolve(p).toLowerCase();
  const done = new Set([...alreadyImported].map(key));
  for (const n of fs.readdirSync(root, { withFileTypes: true })) {
    if (!n.isDirectory()) continue;
    try {
      const j = readJson(path.join(root, n.name, 'note.json'));
      if (typeof j.importedFrom === 'string') done.add(key(j.importedFrom));
    } catch { /* not a note */ }
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeNoteId(entry.name)) continue;
    const srcDir = path.join(sourceRoot, entry.name);
    const srcJson = path.join(srcDir, 'note.json');
    if (!fs.existsSync(srcJson) || done.has(key(srcDir))) continue;
    let note;
    try {
      note = normalizeStored(entry.name, readJson(srcJson));
    } catch {
      result.failed.push(srcDir);
      continue;
    }
    let dir;
    let id;
    for (let i = 1; i <= 500 && !dir; i++) {
      const candidate = i === 1 ? entry.name : `${entry.name}-${i}`;
      if (!isSafeNoteId(candidate)) break;
      try {
        fs.mkdirSync(path.join(root, candidate));
        dir = path.join(root, candidate);
        id = candidate;
      } catch (err) {
        if (err.code !== 'EEXIST') break;
      }
    }
    if (!dir) {
      result.failed.push(srcDir);
      continue;
    }
    try {
      const srcPng = path.join(srcDir, 'screenshot.png');
      const hasShot = fs.existsSync(srcPng);
      if (hasShot) writeFileAtomic(path.join(dir, 'screenshot.png'), fs.readFileSync(srcPng));
      const record = {
        version: 2,
        id,
        title: note.title,
        points: note.points,
        raw: note.raw,
        transcript: note.transcript,
        ocrText: note.ocrText,
        ocrClean: note.ocrClean,
        capturedAt: note.capturedAt,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        at: note.updatedAt,
        starred: note.starred,
        screenshot: hasShot ? 'screenshot.png' : null,
        importedFrom: srcDir,
      };
      writeFileAtomic(path.join(dir, 'note.json'), JSON.stringify(record, null, 2));
      done.add(key(srcDir));
      result.imported.push({ id, from: srcDir });
    } catch {
      for (const f of NOTE_FILES) {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* not written */ }
      }
      try { fs.rmdirSync(dir); } catch { /* leave it */ }
      result.failed.push(srcDir);
    }
  }
  return result;
}

// Removes only Notely's own files so anything else a user put in the folder survives.
function deleteNote(root, id) {
  const dir = noteDir(root, id);
  const file = path.join(dir, 'note.json');
  if (!fs.existsSync(file)) throw new StorageError('That note is no longer in the notes folder.', 'ENOENT');
  try {
    fs.unlinkSync(file);
    for (const f of NOTE_FILES.slice(1)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
    for (const f of fs.readdirSync(dir)) {
      if (/\.tmp-\d+-[0-9a-f]+$/.test(f)) fs.unlinkSync(path.join(dir, f));
    }
  } catch (err) {
    throw new StorageError(friendlyFsError(err, root), err.code);
  }
  let keptFolder = false;
  try {
    fs.rmdirSync(dir);
  } catch {
    keptFolder = true;
  }
  return { id, keptFolder };
}

module.exports = {
  StorageError,
  probeDir,
  listNotes,
  loadNote,
  saveNote,
  deleteNote,
  setStarred,
  importNotes,
  writeFileAtomic,
  friendlyFsError,
};
