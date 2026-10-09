'use strict';

// Builds a single self-contained HTML file for a note (screenshot embedded),
// so an export never leaves broken image links or a pile of files.
// Pure functions; the main process does the writing.

const RESERVED_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// A Windows/macOS/Linux-safe file name (without extension) from a note title.
function safeFileName(title) {
  let name = String(title || '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (name.length > 80) {
    name = name.slice(0, 81);
    const cut = name.lastIndexOf(' ');
    name = (cut > 40 ? name.slice(0, cut) : name.slice(0, 80)).replace(/[.\s]+$/, '');
  }
  if (!name) name = 'Notely note';
  if (RESERVED_NAMES.test(name)) name = `${name} note`;
  return name;
}

function formatWhen(ms) {
  return ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

// Renders the plain-text notes: ``` fences as code, "- " lines as lists,
// a short label line followed by a list or code as a sub-heading, the rest as paragraphs.
function paragraphs(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(escapeHtml).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list.length) out.push(`<ul>\n${list.map((l) => `  <li>${escapeHtml(l)}</li>`).join('\n')}\n</ul>`);
    list = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      flushPara();
      flushList();
      const code = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith('```'); i++) code.push(lines[i]);
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (!trimmed) {
      flushPara();
      flushList();
      continue;
    }
    const bullet = trimmed.match(/^[-•*]\s+(.*)$/);
    if (bullet) {
      flushPara();
      list.push(bullet[1]);
      continue;
    }
    flushList();
    const next = (lines[i + 1] || '').trim();
    if (!para.length && trimmed.length <= 40 && !/[.!?]$/.test(trimmed) && /^([-•*]\s|```|\d{1,2}[.)]\s)/.test(next)) {
      out.push(`<h3>${escapeHtml(trimmed)}</h3>`);
      continue;
    }
    para.push(trimmed);
  }
  flushPara();
  flushList();
  return out.join('\n');
}

// `note.shot` must be a PNG data URL or null.
function renderExportHtml(note) {
  const shot = typeof note.shot === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(note.shot) ? note.shot : null;
  const meta = [`Created ${escapeHtml(formatWhen(note.createdAt))}`];
  if (note.updatedAt && note.updatedAt !== note.createdAt) meta.push(`Updated ${escapeHtml(formatWhen(note.updatedAt))}`);
  if (note.capturedAt) meta.push(`Screen captured ${escapeHtml(formatWhen(note.capturedAt))}`);
  const points = (note.points || []).length
    ? `<h2>Key points</h2>\n<ul>\n${note.points.map((p) => `  <li>${escapeHtml(p)}</li>`).join('\n')}\n</ul>`
    : '';
  const details = String(note.raw || '').trim() ? `<h2>Notes</h2>\n${paragraphs(note.raw)}` : '';
  const spoken = String(note.transcript || '').trim()
    ? `<h2>What you said</h2>\n<blockquote>${escapeHtml(note.transcript).replace(/\n/g, '<br>')}</blockquote>`
    : '';
  const image = shot ? `<h2>Screenshot</h2>\n<img src="${shot}" alt="Captured screen">` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(note.title)}</title>
<style>
  body { font-family: 'Segoe UI', system-ui, sans-serif; color: #2E2A3B; background: #F7F4FB; margin: 0; }
  main { max-width: 820px; margin: 0 auto; padding: 32px 24px 48px; line-height: 1.55; overflow-wrap: anywhere; }
  h1 { font-size: 30px; margin: 0 0 6px; }
  h2 { font-size: 19px; margin: 28px 0 8px; }
  h3 { font-size: 15px; margin: 18px 0 4px; color: #5F5978; }
  .meta { color: #5F5978; font-size: 14px; margin: 0; }
  ul { padding-left: 22px; }
  li { margin: 4px 0; }
  pre { background: #fff; border-radius: 10px; padding: 12px; overflow-x: auto; white-space: pre-wrap; }
  blockquote { margin: 0; padding: 8px 14px; border-left: 4px solid #CFC6F3; background: #fff; border-radius: 6px; }
  img { max-width: 100%; height: auto; border-radius: 12px; display: block; }
  footer { margin-top: 36px; color: #5F5978; font-size: 12px; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(note.title)}</h1>
<p class="meta">${meta.join(' · ')}</p>
${points}
${details}
${spoken}
${image}
<footer>Exported from Notely</footer>
</main>
</body>
</html>
`;
}

module.exports = { escapeHtml, safeFileName, renderExportHtml };
