'use strict';

// Turns Tesseract output into cleaned screen text and structured notes.
// Pure functions only: no Electron, no filesystem, so it can be unit tested.

const STOPWORDS = new Set(('a an the and or but if then else of to in on at by for with from as is are was were be been '
  + 'this that these those it its into over under about your you we they he she them our their his her my me i '
  + 'not no yes can will just also than so such very more most less much many some any all each other').split(' '));

const CONTROL_WORDS = new Set([
  'subscribe', 'subscribed', 'share', 'save', 'saved', 'download', 'clip', 'thanks', 'like', 'dislike', 'reply',
  'more', 'show more', 'show less', 'read more', 'join', 'create', 'search', 'sign in', 'log in', 'skip', 'skip ad',
  'skip ads', 'visit site', 'install', 'all', 'playlists', 'related', 'for you', 'recently uploaded', 'watched',
  'live', 'shorts', 'home', 'menu', 'settings', 'next', 'previous', 'autoplay', 'mute', 'unmute', 'fullscreen',
  'captions', 'cc', 'hd', 'report', 'comments', 'sort by', 'add a comment', 'new', 'cancel', 'ok', 'close',
]);

const METADATA_RE = [
  /\b\d[\d.,]*\s*[kmb]?\s*(views?|subscribers?|watching|likes?|comments?|followers?)\b/i,
  /\b\d+\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|d[ao]ys?|weeks?|wks?|months?|mo|years?|yrs?)\s*ag[oa]\b/i,
  /\b\d+(mo|d|w|y|h)\s*ag[oa]\b/i,
  /\bsponsored\b/i,
  /\bpromoted\b/i,
  /^ad\s*[·•-]/i,
];

const TIMECODE_RE = /^\d{1,2}:\d{2}(:\d{2})?(\s*\/\s*\d{1,2}:\d{2}(:\d{2})?)?$/;
const CLOCK_RE = /\b\d{1,2}[:.]\d{2}\s*(am|pm)?\b/i;
const DATE_RE = /\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/;
const URL_RE = /(?:h[it]{1,2}ps?:?\/\/|www\.)[^\s<>"'`]+/gi;
const TRACKING_PARAM_RE = /^(utm_[a-z_]+|fbclid|gclid|dclid|msclkid|igshid|mc_cid|mc_eid|si|feature|ref|ref_src|ref_url|spm|_hsenc|_hsmi|yclid|pp)$/i;

const CODE_START_RE = /^\s*(def |class |function\b|async function\b|const |let |var |import |from \S+ import\b|export |return\b|if\s*\(|for\s*\(|while\s*\(|elif |print\s*\(|console\.\w+\(|public |private |protected |#include|SELECT |INSERT |UPDATE |DELETE FROM|CREATE TABLE|<\/?[a-z][\w-]*[\s>]|\$ |> |npm |npx |pip |git |cd |python3? \S+\.py|node \S+\.js|sudo |docker )/;
const COMMAND_RE = /^(npm|npx|yarn|pnpm|pip3?|python3?|py|node|git|cd|docker|kubectl|curl|wget|sudo|apt(-get)?|brew|cargo|go|dotnet|mvn|gradle|make|mkdir|ls|dir|code|ollama|electron)\s+\S/;
const PRONOUNS = new Set(['it', 'this', 'that', 'there', 'he', 'she', 'they', 'we', 'you', 'i', 'which', 'what', 'who', 'here', 'these', 'those']);

function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function normalizeSpaces(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function tokensOf(s) {
  return String(s || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

function contentTokens(s) {
  return tokensOf(s).filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function isRealWord(token) {
  const t = token.replace(/^[("'“‘[]+|[)"'”’\],.:;!?…]+$/g, '');
  if (!t) return false;
  if (/^[A-Za-z][a-z]+(['’][a-z]+)?$/.test(t)) return true;
  if (/^[A-Z]{2,6}s?$/.test(t)) return true;
  if (/^[A-Z][a-z]*[A-Z][a-z]+$/.test(t)) return true;
  if (/^\d[\d.,:%]*$/.test(t)) return true;
  if (/^[aAI]$/.test(t)) return true;
  if (/^[A-Za-z]+-[A-Za-z]+$/.test(t)) return true;
  if (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(t)) return true;
  return false;
}

function isCodeLike(text) {
  const t = String(text || '');
  if (!/[A-Za-z]/.test(t)) return false;
  if (CODE_START_RE.test(t)) return true;
  const sym = (t.match(/[{}();=<>[\]]/g) || []).length;
  if (sym < 2) return false;
  return /(;|\{|\}|=>)\s*$|\w\([^()]*\)\s*[:;{]?\s*$|\w\s*=\s*[\w"'[{(]|==|!=|\+=|->/.test(t);
}

function looksLikeUrl(text) {
  return /(?:h[it]{1,2}ps?:?\/\/|www\.)\S+|\b[\w-]+\.(com|org|net|io|dev|edu|gov|co)\/\S*/i.test(text);
}

function cleanUrl(raw) {
  let s = String(raw || '').trim().replace(/[),.;:!?'"\]]+$/, '');
  s = s.replace(/^h[it]{1,2}ps?:?\/\//i, (m) => (/^h[it]{1,2}ps/i.test(m) ? 'https://' : 'http://'));
  if (/^www\./i.test(s)) s = 'https://' + s;
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || !/\.[a-z]{2,}$/i.test(url.hostname)) return null;
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM_RE.test(key)) url.searchParams.delete(key);
  }
  url.hash = url.hash && /^#[\w-]+$/.test(url.hash) ? url.hash : '';
  let out = url.toString();
  if (out.endsWith('?')) out = out.slice(0, -1);
  return out;
}

function isMetadata(text) {
  if (METADATA_RE.some((re) => re.test(text))) return true;
  const toks = text.split(/\s+/).filter(Boolean);
  const tags = toks.filter((t) => /^#[A-Za-z]\w+/.test(t)).length;
  return tags >= 2 && tags / toks.length >= 0.4;
}

function isControl(text) {
  const t = text.toLowerCase().replace(/[^a-z0-9.:/ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return true;
  if (CONTROL_WORDS.has(t)) return true;
  if (TIMECODE_RE.test(t)) return true;
  if (/^\d[\d.,]*\s*[kmb]?$/.test(t)) return true;
  const words = t.split(' ');
  return words.length <= 6 && words.every((w) => CONTROL_WORDS.has(w) || /^\d[\d.,]*[kmb]?$/.test(w));
}

function looksLikeTabStrip(text) {
  const tabSeparators = (text.match(/\b[Xx×]\s*\|/g) || []).length;
  return tabSeparators >= 2 || /\bnew tab\b/i.test(text);
}

// --- Segment extraction -----------------------------------------------------

function wordBox(w) {
  const b = w.bbox || {};
  return { x0: b.x0 || 0, y0: b.y0 || 0, x1: b.x1 || 0, y1: b.y1 || 0 };
}

function makeSegment(words, meta) {
  const boxes = words.map(wordBox);
  const text = normalizeSpaces(words.map((w) => w.text).join(' '));
  return {
    text,
    words,
    conf: words.reduce((s, w) => s + (Number(w.confidence) || 0), 0) / Math.max(1, words.length),
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
    h: median(boxes.map((b) => b.y1 - b.y0)),
    ...meta,
  };
}

// Tesseract often merges words from different screen columns into one line.
// Split each line wherever the horizontal gap between words is too large.
function extractSegments(data, width) {
  const segments = [];
  const blocks = (data && Array.isArray(data.blocks)) ? data.blocks : [];
  let lineIndex = 0;
  blocks.forEach((block, bi) => {
    (block.paragraphs || []).forEach((para, pi) => {
      (para.lines || []).forEach((line) => {
        const words = (line.words || []).filter((w) => w && normalizeSpaces(w.text));
        if (!words.length) return;
        const lineH = median(words.map((w) => wordBox(w).y1 - wordBox(w).y0)) || 10;
        const gapLimit = Math.max(lineH * 2.2, width * 0.025);
        let run = [words[0]];
        for (let i = 1; i < words.length; i++) {
          const gap = wordBox(words[i]).x0 - wordBox(words[i - 1]).x1;
          if (gap > gapLimit) {
            segments.push(makeSegment(run, { block: bi, para: pi, line: lineIndex }));
            run = [];
          }
          run.push(words[i]);
        }
        segments.push(makeSegment(run, { block: bi, para: pi, line: lineIndex }));
        lineIndex += 1;
      });
    });
  });
  return segments;
}

function trimSegmentWords(seg) {
  const code = isCodeLike(seg.text);
  let words = seg.words.filter((w) => (Number(w.confidence) || 0) >= (code ? 10 : 35));
  const edgeNoise = (w, atEnd) => {
    const t = String(w.text || '');
    const conf = Number(w.confidence) || 0;
    if (code) return conf < 10;
    if (!/[A-Za-z0-9]/.test(t)) return true;
    if (/^([a-z])\1{1,2}$/i.test(t)) return true;
    if (atEnd && words.length > 1 && /^(\.{0,3}more|…more)$/i.test(t)) return true;
    return conf < 60 && t.replace(/[^A-Za-z0-9]/g, '').length <= 3 && !/^\d+[.)]?$/.test(t);
  };
  let changed = true;
  while (changed && words.length) {
    changed = false;
    if (edgeNoise(words[0], false)) {
      words = words.slice(1);
      changed = true;
    }
    if (words.length && edgeNoise(words[words.length - 1], true)) {
      words = words.slice(0, -1);
      changed = true;
    }
  }
  if (!words.length) return null;
  return makeSegment(words, { block: seg.block, para: seg.para, line: seg.line, code });
}

// --- Noise classification ---------------------------------------------------

function realWordStats(text) {
  const toks = text.split(/\s+/).filter(Boolean);
  const real = toks.filter(isRealWord).length;
  return { total: toks.length, real, ratio: toks.length ? real / toks.length : 0 };
}

function detectChromeBottom(raw, H) {
  let bottom = -1;
  for (const s of raw) {
    if (s.y1 > H * 0.16) continue;
    if (looksLikeTabStrip(s.text) || looksLikeUrl(s.text)) bottom = Math.max(bottom, s.y1);
  }
  return bottom;
}

// A recommendations/ads column is recognised by metadata markers ("views",
// "3 days ago", "Sponsored") on the right. Its left edge is the leftmost empty
// vertical gutter between the main column and those markers.
function findSidebarX(entries, W, H) {
  const markers = entries.map((e) => e.seg).filter((s) => {
    const cx = (s.x0 + s.x1) / 2;
    return cx > W * 0.55 && (isMetadata(s.text) || TIMECODE_RE.test(s.text.trim()) || /\bvisit site\b/i.test(s.text));
  });
  if (markers.length < 2) return null;
  const minMarkerX = Math.min(...markers.map((s) => s.x0));
  const bins = 200;
  const binW = W / bins;
  const covered = new Array(bins).fill(0);
  for (const e of entries) {
    const s = e.seg;
    if (['low-confidence', 'garbled', 'fragment'].includes(e.reason)) continue;
    if (s.y1 < H * 0.12 || s.y0 > H * 0.94) continue;
    if (s.x1 - s.x0 > W * 0.6) continue;
    const a = Math.max(0, Math.floor(s.x0 / binW));
    const b = Math.min(bins - 1, Math.floor(s.x1 / binW));
    for (let i = a; i <= b; i++) covered[i] += 1;
  }
  const start = Math.floor(bins * 0.55);
  const end = Math.min(bins - 1, Math.floor(minMarkerX / binW));
  for (let i = start; i <= end; i++) {
    if (covered[i] !== 0) continue;
    let j = i;
    while (j + 1 <= end && covered[j + 1] === 0) j += 1;
    if (j - i + 1 >= 3) return i * binW;
    i = j;
  }
  return Math.max(W * 0.55, minMarkerX - W * 0.02);
}

function classifyNoise(segments, W, H, chromeBottom) {
  const out = [];
  const body = segments.filter((s) => s.text.split(/\s+/).length >= 5);
  const bodyH = median((body.length ? body : segments).map((s) => s.h)) || 1;
  for (const seg of segments) {
    const text = seg.text;
    const stats = realWordStats(text);
    const largeText = seg.h >= bodyH * 1.8 && stats.real >= 2;
    let reason = null;
    if (chromeBottom >= 0 && seg.y1 <= chromeBottom + 2) reason = 'browser-ui';
    else if (chromeBottom >= 0 && seg.y0 <= chromeBottom + H * 0.07 && stats.total <= 6 && !largeText) reason = 'navigation';
    else if (seg.y0 >= H * 0.94 && (stats.total <= 4 || CLOCK_RE.test(text) || DATE_RE.test(text) || stats.ratio < 0.7)) reason = 'taskbar';
    else if (seg.code) reason = seg.conf < 15 ? 'low-confidence' : null;
    else if (seg.conf < 45) reason = 'low-confidence';
    else if (isMetadata(text)) reason = 'recommendations';
    else if (isControl(text)) reason = 'player-controls';
    else if (looksLikeUrl(text) && stats.total <= 2) reason = null;
    else if (stats.real === 0 || stats.ratio < 0.5) reason = 'garbled';
    else if (stats.real === 1 && stats.total <= 2 && !(text.replace(/[^A-Za-z]/g, '').length >= 4 && seg.conf >= 75)) reason = 'fragment';
    out.push({ seg, reason });
  }
  return out;
}

// A column of short labels along the left edge is a site menu, even when OCR
// already dropped some of its items as low confidence.
function markLeftNav(entries, W) {
  const left = entries.filter((e) => e.seg.x1 <= W * 0.2 && !['browser-ui', 'taskbar'].includes(e.reason));
  if (left.length < 4) return;
  const short = left.filter((e) => realWordStats(e.seg.text).total <= 3);
  if (short.length / left.length < 0.8) return;
  for (const e of short) {
    if (!e.reason) e.reason = 'navigation';
  }
}

function stripHashtags(text) {
  return normalizeSpaces(text.split(/\s+/).filter((t) => !/^#[A-Za-z]\w+[.,]?$/.test(t)).join(' '));
}

function containment(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return { inter, aSize: A.size, bSize: B.size };
}

function dedupe(entries) {
  const kept = [];
  for (const e of entries) {
    if (e.reason) continue;
    const toks = tokensOf(e.seg.text);
    if (!toks.length) {
      e.reason = 'garbled';
      continue;
    }
    const key = toks.join(' ');
    let dup = false;
    for (const k of kept) {
      if (k.reason) continue;
      const kToks = tokensOf(k.seg.text);
      if (kToks.join(' ') === key) {
        dup = true;
        break;
      }
      const { inter, aSize, bSize } = containment(toks, kToks);
      const minSize = Math.min(aSize, bSize);
      if (minSize >= 4 && inter / minSize >= 0.8) {
        if (aSize > bSize && inter / bSize >= 0.95 && !k.seg.heading) {
          k.reason = 'duplicate';
        } else {
          dup = true;
        }
        break;
      }
    }
    if (dup) e.reason = 'duplicate';
    else kept.push(e);
  }
}

// --- Structure and ranking --------------------------------------------------

function sortReadingOrder(segs) {
  const h = median(segs.map((s) => s.h)) || 10;
  return segs.slice().sort((a, b) => {
    if (Math.abs(a.y0 - b.y0) > h * 0.6) return a.y0 - b.y0;
    return a.x0 - b.x0;
  });
}

function isListStart(text) {
  return /^(\d{1,2}[.)]|step\s*\d+[:.)]?|[•▪◦*-])\s+/i.test(text);
}

function isTitleCase(text) {
  const words = text.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
  const significant = words.filter((w) => !STOPWORDS.has(w.toLowerCase().replace(/[^a-z]/g, '')));
  if (words.length < 2 || !significant.length) return false;
  const upper = significant.filter((w) => /^["“(]?[A-Z]/.test(w)).length;
  return upper / significant.length >= 0.75 && /^["“(]?[A-Z0-9]/.test(words[0]);
}

function markHeadings(segs, textOnly) {
  const body = segs.filter((s) => !s.code && s.text.split(/\s+/).length >= 6);
  const bodyH = median((body.length ? body : segs.filter((s) => !s.code)).map((s) => s.h)) || 1;
  segs.forEach((s, i) => {
    const words = s.text.split(/\s+/).length;
    const endsSentence = /[.;,!?]$/.test(s.text);
    if (s.code || isListStart(s.text) || looksLikeUrl(s.text)) {
      s.heading = false;
    } else if (!textOnly && s.h >= bodyH * 1.3 && words <= 14 && !endsSentence) {
      s.heading = true;
    } else if (!textOnly && words >= 2 && words <= 12 && !endsSentence && s.conf >= 70 && isTitleCase(s.text)) {
      s.heading = true;
    } else if (words <= 8 && /:$/.test(s.text) && /^[A-Z]/.test(s.text)) {
      s.heading = true;
    } else if (words <= 6 && /^[A-Z0-9 &'-]{4,}$/.test(s.text) && /[A-Z]{3}/.test(s.text)) {
      s.heading = true;
    } else if (textOnly && words <= 8 && !endsSentence && /^[A-Z]/.test(s.text)) {
      const next = segs[i + 1];
      s.heading = !!next && next.text.split(/\s+/).length > words;
    } else {
      s.heading = false;
    }
  });
}

function buildParagraphs(segs, W) {
  const paras = [];
  let cur = null;
  for (const s of segs) {
    const kind = s.heading ? 'heading' : s.code ? 'code' : 'text';
    const startsList = kind === 'text' && isListStart(s.text);
    const newPara = !cur
      || kind === 'heading'
      || cur.kind === 'heading'
      || kind !== cur.kind
      || startsList
      || (s.y0 - cur.last.y1) > Math.max(cur.last.h, s.h) * 1.6
      || Math.abs(s.x0 - cur.first.x0) > W * 0.08 && kind !== 'code';
    if (newPara) {
      cur = { kind, lines: [s.text], first: s, last: s, h: s.h, conf: [s.conf] };
      paras.push(cur);
    } else {
      cur.lines.push(s.text);
      cur.last = s;
      cur.conf.push(s.conf);
    }
  }
  return paras.map((p) => {
    if (p.kind === 'code') return { kind: 'code', text: p.lines.join('\n'), h: p.h, conf: median(p.conf) };
    let text = '';
    for (const line of p.lines) {
      if (text.endsWith('-') && /^[a-z]/.test(line)) text = text.slice(0, -1) + line;
      else text = text ? `${text} ${line}` : line;
    }
    return { kind: p.kind, text: normalizeSpaces(text), h: p.h, conf: median(p.conf) };
  });
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+(?=["“(]?[A-Z0-9])/)
    .map((s) => normalizeSpaces(s))
    .filter(Boolean);
}

const LABEL_TERMS = /^(important|note|notes|tip|tips|warning|caution|remember|example|examples|read|see|source|update|edit|summary|answer|question|step \d+)$/i;

function parseDefinition(sentence) {
  let m = sentence.match(/^([A-Z][\w'’()/ -]{1,40}?)\s*(?::\s|\s[—–-]\s)\s*(.{8,})$/);
  if (m) {
    const term = m[1].trim();
    if (term.split(/\s+/).length <= 4 && !looksLikeUrl(term) && !LABEL_TERMS.test(term)) {
      return { term, meaning: m[2].trim(), text: sentence };
    }
  }
  m = sentence.match(/^(?:(?:an?|the)\s+)?([A-Za-z][\w'’()/ -]{1,40}?)\s+(is an?|is the|are an?|are the|refers to|means|is defined as|is called|are called|stands for)\s+(.{6,})$/i);
  if (m) {
    const term = m[1].trim();
    const words = term.split(/\s+/);
    if (words.length <= 4 && !PRONOUNS.has(words[0].toLowerCase()) && !LABEL_TERMS.test(term)) {
      return { term, meaning: `${m[2]} ${m[3]}`.trim(), text: sentence };
    }
  }
  return null;
}

const CUE_RE = /\b(important|key|note|remember|must|should|always|never|because|therefore|used to|allows?|enables?|consists? of|includes?|requires?|means|defined|called|known as|example|advantage|disadvantage|difference|result|causes?|first|finally)\b/i;

function scoreItem(item) {
  const words = item.text.split(/\s+/).length;
  let score = 1;
  if (item.kind === 'definition') score += 3;
  if (item.kind === 'step') score += 2.5;
  if (item.kind === 'example') score += 1;
  if (CUE_RE.test(item.text)) score += 1.5;
  if (/\d/.test(item.text)) score += 0.5;
  if (words >= 6 && words <= 35) score += 1;
  else if (words > 35) score += 0.5;
  else if (words < 4) score -= 1.5;
  score += ((item.conf || 80) - 70) / 40;
  return score;
}

function truncateWords(text, max) {
  const t = normalizeSpaces(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return (at > max * 0.5 ? cut.slice(0, at) : cut).replace(/[,:;-]+$/, '') + '…';
}

// --- Titles -------------------------------------------------------------------

const GENERIC_TITLE_RE = /^(notes?|my notes|screen ?shots?|screen|screen notes|capture|new note|new tab|untitled( note| document)?|home|page|document|video|videos|playlist|watch|youtube|google|search|menu|settings|dashboard|welcome|overview|introduction|summary|details|more|loading)$/i;
const SITE_SUFFIX_RE = /\s+[-|–—·•]\s+(youtube|google( \w+)?|wikipedia|medium|github|stack overflow|reddit|w3schools|geeksforgeeks|mdn web docs|coursera|udemy|khan academy|notion|microsoft edge|chrome)\s*$/i;
const INFLECTION_RE = /^(s|es|ed|d|ing|er|ers|ly)$/;
const TITLE_MAX = 70;
// Social/video framing that is not part of the subject ("POV: ...", "(Official Video)").
const TITLE_PREFIX_RE = /^(pov|watch|video|live|breaking|new|shorts?|reel|full video|lyrics?)\s*[:|\-–—]\s+/i;
const TITLE_TAG_RE = /\s*[([](official( music| lyric)? video|official audio|lyrics?|lyric video|audio|hd|4k|full video|visuali[sz]er|slowed( \+ reverb)?|reverb|sped up)[)\]]/gi;

function cleanTitleCandidate(text) {
  return normalizeSpaces(String(text || '')
    .replace(URL_RE, ' ')
    .replace(/(^|\s)#[A-Za-z]\w*/g, ' ')
    .replace(TITLE_TAG_RE, ' '))
    .replace(SITE_SUFFIX_RE, '')
    .replace(/^[^A-Za-z0-9"“(]+/, '')
    .replace(TITLE_PREFIX_RE, '')
    .replace(/[\s,;:|·•\-–—]+$/, '')
    .trim();
}

function wordTokens(text) {
  const out = [];
  const re = /[A-Za-z0-9]+/g;
  let m;
  while ((m = re.exec(text))) out.push({ t: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  return out;
}

// Screens often cut a heading off (e.g. "POV: Your Heart Bel" over a video)
// while showing it in full elsewhere. Finish the cut-off text from that line.
function completeTitle(candidate, contexts) {
  const ellipsis = /(\.\.\.|…)$/.test(candidate);
  const base = candidate.replace(/\s*(\.\.\.|…)$/, '');
  const ct = wordTokens(base);
  if (ct.length < 2) return null;
  const last = ct[ct.length - 1];
  for (const other of contexts) {
    if (!other || other === candidate) continue;
    const ot = wordTokens(other);
    for (let k = Math.min(ct.length, 6); k >= 2; k--) {
      const tail = ct.slice(ct.length - k);
      for (let j = 0; j + k <= ot.length; j++) {
        let ok = true;
        for (let x = 0; x < k - 1 && ok; x++) ok = tail[x].t === ot[j + x].t;
        if (!ok) continue;
        const end = ot[j + k - 1];
        if (!end.t.startsWith(last.t)) continue;
        const extra = end.t.slice(last.t.length);
        const cutWord = extra.length >= 2 && !INFLECTION_RE.test(extra);
        if (!cutWord && !(ellipsis && ot.length > j + k)) continue;
        let rest = other.slice(end.start);
        rest = rest.split(/(?<=[.!?])\s|\s[|•·]\s|\s[-–—]\s|\.\.\.|…/)[0];
        return normalizeSpaces(base.slice(0, last.start) + rest).replace(/[\s,;:.]+$/, '');
      }
    }
  }
  return null;
}

function shortenTitle(text, max = TITLE_MAX) {
  let t = normalizeSpaces(text).replace(/[.。]+$/, '');
  if (t.length <= max) return t;
  for (const sep of [' | ', ' — ', ' – ', ' - ', ': ']) {
    const head = t.split(sep)[0];
    if (head !== t && head.length >= 12 && head.length <= max) return head.trim();
  }
  t = t.slice(0, max + 1);
  t = t.slice(0, t.lastIndexOf(' ') > max * 0.5 ? t.lastIndexOf(' ') : max);
  const words = t.split(' ');
  while (words.length > 2 && STOPWORDS.has(words[words.length - 1].toLowerCase().replace(/[^a-z]/g, ''))) words.pop();
  return words.join(' ').replace(/[\s,;:(\-–—]+$/, '');
}

function isGoodTitle(t) {
  if (!t || t.length < 3 || !/[A-Za-z]/.test(t)) return false;
  if (GENERIC_TITLE_RE.test(t.replace(/[^\w ]+/g, '').trim())) return false;
  if (looksLikeTabStrip(t) || isMetadata(t) || isControl(t) || looksLikeUrl(t) || isCodeLike(t)) return false;
  const words = t.split(/\s+/);
  if (words.length === 1 && (t.length < 4 || !/^[A-Z0-9]/.test(t))) return false;
  if (!contentTokens(t).length && words.length < 3) return false;
  return realWordStats(t).ratio >= 0.6;
}

// Picks the first usable candidate (ordered best-first). Returns '' if none is good.
function pickTitle(candidates, contexts = []) {
  const ctx = contexts.map(normalizeSpaces).filter(Boolean);
  for (const raw of candidates) {
    let t = cleanTitleCandidate(raw);
    if (!t) continue;
    const completed = completeTitle(t, ctx);
    if (completed) t = completed;
    else if (/(\.\.\.|…)$/.test(t)) continue;
    t = shortenTitle(t);
    if (isGoodTitle(t)) return t.charAt(0).toUpperCase() + t.slice(1);
  }
  return '';
}

// Short leading clause of a sentence, usable as a title ("Plants convert light...").
function clauseTitle(text) {
  const t = normalizeSpaces(text).replace(/[.!?]+$/, '');
  if (t.split(' ').length <= 10) return t;
  const clause = t.split(/,\s|;\s|:\s|\s[-–—]\s/)[0];
  const n = clause.split(' ').length;
  return n >= 3 && n <= 10 ? clause : '';
}

function fallbackTitle(when = new Date(), kind = 'Screen Notes') {
  const d = when instanceof Date ? when : new Date(when);
  const date = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${kind} - ${date} ${time}`;
}

// Drops points that repeat an earlier point (same sentence, or one contained in the other).
function dedupePoints(points) {
  const kept = [];
  for (const raw of points) {
    const p = normalizeSpaces(raw);
    if (!p) continue;
    const toks = contentTokens(p);
    const dupAt = kept.findIndex((k) => {
      if (k.text.toLowerCase() === p.toLowerCase()) return true;
      if (!toks.length || !k.toks.length) return false;
      const c = containment(toks, k.toks);
      return c.inter / c.aSize >= 0.85 || c.inter / c.bSize >= 0.85;
    });
    if (dupAt === -1) kept.push({ text: p, toks });
    else if (toks.length > kept[dupAt].toks.length) kept[dupAt] = { text: p, toks };
  }
  return kept.map((k) => k.text);
}

function coveredByTitle(text, title) {
  const tt = tokensOf(title);
  const toks = tokensOf(cleanTitleCandidate(text) || text);
  return toks.length > 0 && toks.every((w) => tt.some((t) => t.startsWith(w)));
}

function buildNotes(paras) {
  const headings = [];
  const items = [];
  const code = [];
  const links = [];
  const seenLinks = new Set();
  let order = 0;

  const addLinks = (text) => {
    for (const m of text.match(URL_RE) || []) {
      const url = cleanUrl(m);
      if (url && !seenLinks.has(url)) {
        seenLinks.add(url);
        links.push(url);
      }
    }
  };

  for (const p of paras) {
    if (p.kind === 'heading') {
      headings.push({ text: p.text.replace(/:$/, ''), h: p.h, order: order++ });
      continue;
    }
    if (p.kind === 'code') {
      code.push(p.text);
      addLinks(p.text);
      order++;
      continue;
    }
    addLinks(p.text);
    const pieces = isListStart(p.text) ? [p.text] : splitSentences(p.text);
    for (const raw of pieces) {
      const text = raw.replace(URL_RE, (m) => cleanUrl(m) || m);
      if (looksLikeUrl(text) && text.split(/\s+/).length <= 2) continue;
      const stepMatch = text.match(/^(\d{1,2}[.)]|step\s*\d+[:.)]?)\s+(.+)$/i);
      const bulletMatch = text.match(/^[•▪◦*-]\s+(.+)$/);
      const def = parseDefinition(text);
      let kind = 'sentence';
      let body = text;
      if (stepMatch) {
        kind = 'step';
        body = stepMatch[2];
      } else if (def) {
        kind = 'definition';
      } else if (/\b(e\.g\.|for example|for instance|example:)/i.test(text)) {
        kind = 'example';
      }
      if (bulletMatch) body = bulletMatch[1];
      if (kind === 'sentence' && body.split(/\s+/).length < 3) continue;
      items.push({ kind, text: body, def, conf: p.conf, order: order++ });
    }
  }

  const steps = items.filter((i) => i.kind === 'step');
  const pool = items.filter((i) => i.kind !== 'step');
  const ranked = pool.map((i) => ({ ...i, score: scoreItem(i) })).sort((a, b) => b.score - a.score);
  const want = Math.min(7, Math.max(3, Math.ceil(pool.length * 0.5)));
  let chosen = ranked.filter((i) => i.score > 0.5).slice(0, want);
  if (!chosen.length && !pool.length && steps.length) chosen = steps.slice(0, 7);
  const chosenSet = new Set(chosen.map((i) => i.order));
  const top = chosen[0];
  chosen.sort((a, b) => a.order - b.order);

  const keyPoints = dedupePoints(chosen.map((i) => truncateWords(i.text, 320)));
  const commands = [];
  for (const block of code) {
    for (const line of block.split('\n')) {
      const cmd = line.trim().replace(/^(\$|>|PS [A-Z]:\\[^>]*>)\s*/, '');
      if (COMMAND_RE.test(cmd) && !commands.includes(cmd)) commands.push(cmd);
    }
  }
  const details = pool
    .filter((i) => !chosenSet.has(i.order))
    .sort((a, b) => a.order - b.order)
    .slice(0, 15)
    .map((i) => truncateWords(i.text, 400));
  const definitions = items.filter((i) => i.kind === 'definition').map((i) => ({
    term: i.def.term,
    meaning: truncateWords(i.def.meaning, 300),
    text: truncateWords(i.def.text, 340),
  }));
  const examples = items.filter((i) => i.kind === 'example').map((i) => truncateWords(i.text, 300));

  // Multi-word headings first (single big words are often video frames or logos),
  // then larger text first; ties keep screen order.
  const multi = (h) => (h.text.trim().split(/\s+/).length >= 2 ? 1 : 0);
  const bySize = headings.slice().sort((a, b) => (multi(b) - multi(a))
    || (b.h > a.h * 1.08 ? 1 : a.h > b.h * 1.08 ? -1 : a.order - b.order));
  const contexts = [...headings.map((h) => h.text), ...items.map((i) => i.text)];
  const title = pickTitle([
    ...bySize.map((h) => h.text),
    ...definitions.map((d) => d.term.charAt(0).toUpperCase() + d.term.slice(1)),
    ...keyPoints.map(clauseTitle),
  ], contexts);

  const wordCount = items.reduce((n, i) => n + i.text.split(/\s+/).length, 0)
    + code.reduce((n, c) => n + c.split(/\s+/).length, 0)
    + headings.reduce((n, h) => n + h.text.split(/\s+/).length, 0);

  return {
    title,
    headings: headings.map((h) => h.text).filter((h) => !title || !coveredByTitle(h, title)),
    keyPoints: keyPoints.filter((p) => !title || !coveredByTitle(p, title)),
    mainIdea: top ? truncateWords(top.text, 320) : '',
    definitions,
    steps: steps.map((s) => truncateWords(s.text, 320)),
    examples,
    code,
    commands: commands.slice(0, 10),
    links,
    details,
    lowContent: wordCount < 8 || (!keyPoints.length && !steps.length && !code.length),
  };
}

function cleanTextFromParas(paras) {
  return paras.map((p) => p.text).join('\n\n').trim();
}

function countReasons(entries) {
  const removed = {};
  for (const e of entries) {
    if (e.reason) removed[e.reason] = (removed[e.reason] || 0) + 1;
  }
  return removed;
}

// Main entry point for Tesseract `recognize` output with blocks enabled.
function processOcr(data, size = {}) {
  const rawText = String((data && data.text) || '').trim();
  const hasBlocks = data && Array.isArray(data.blocks) && data.blocks.length;
  if (!hasBlocks) {
    const result = processText(rawText);
    return { ...result, rawText };
  }

  let rawSegs = extractSegments(data, size.width || 0);
  const W = size.width || Math.max(1, ...rawSegs.map((s) => s.x1));
  const H = size.height || Math.max(1, ...rawSegs.map((s) => s.y1));
  if (!size.width) rawSegs = extractSegments(data, W);

  const chromeBottom = detectChromeBottom(rawSegs, H);
  const entries = [];
  for (const seg of rawSegs) {
    const trimmed = trimSegmentWords(seg);
    if (!trimmed) {
      entries.push({ seg, reason: 'low-confidence' });
      continue;
    }
    trimmed.text = trimmed.code ? trimmed.text : stripHashtags(trimmed.text);
    if (!trimmed.text) {
      entries.push({ seg, reason: 'recommendations' });
      continue;
    }
    entries.push({ seg: trimmed, reason: null });
  }
  const pending = entries.filter((e) => !e.reason);
  const classified = classifyNoise(pending.map((e) => e.seg), W, H, chromeBottom);
  classified.forEach((c, i) => { pending[i].reason = c.reason; });
  // Recommendation markers were just removed as noise, but they still reveal where a sidebar column starts.
  const pageEntries = entries.filter((e) => !['browser-ui', 'navigation', 'taskbar'].includes(e.reason));
  const sidebarX = findSidebarX(pageEntries, W, H);
  if (sidebarX != null) {
    for (const e of entries) {
      if (!e.reason && e.seg.x0 >= sidebarX - 1) e.reason = 'sidebar';
    }
  }
  markLeftNav(entries, W);

  const keptSegs = sortReadingOrder(entries.filter((e) => !e.reason).map((e) => e.seg));
  markHeadings(keptSegs, false);
  const ordered = keptSegs.map((seg) => entries.find((e) => e.seg === seg));
  dedupe(ordered);
  const finalSegs = ordered.filter((e) => !e.reason).map((e) => e.seg);

  if (typeof size.debug === 'function') size.debug(entries);
  const paras = buildParagraphs(finalSegs, W);
  const notes = shapeNotes(buildNotes(paras), rawText);
  return {
    rawText,
    cleanText: cleanTextFromParas(paras),
    notes,
    stats: {
      lines: rawSegs.length,
      kept: finalSegs.length,
      removed: countReasons(entries),
      sidebar: sidebarX != null,
      browserChrome: chromeBottom >= 0,
    },
  };
}

// Plain-text mode for typed text or OCR without layout information.
function processText(text) {
  const lines = String(text || '').split(/\r?\n/).map(normalizeSpaces);
  const entries = [];
  lines.forEach((line, i) => {
    if (!line) return;
    const seg = {
      text: line, conf: 90, x0: 0, y0: i * 10, x1: 100, y1: i * 10 + 8, h: 8, code: isCodeLike(line),
    };
    let reason = null;
    if (!seg.code) {
      const stripped = stripHashtags(line);
      if (!stripped) reason = 'recommendations';
      else seg.text = stripped;
      if (!reason && isMetadata(seg.text)) reason = 'recommendations';
      else if (!reason && isControl(seg.text)) reason = 'player-controls';
      else if (!reason && !looksLikeUrl(seg.text) && realWordStats(seg.text).ratio < 0.5) reason = 'garbled';
    }
    entries.push({ seg, reason });
  });
  const kept = entries.filter((e) => !e.reason).map((e) => e.seg);
  markHeadings(kept, true);
  dedupe(entries.filter((e) => !e.reason));
  const finalSegs = entries.filter((e) => !e.reason).map((e) => e.seg);
  // Blank lines in the source separate paragraphs; keep them by using gaps.
  let y = 0;
  let prevIndex = -1;
  for (const seg of finalSegs) {
    const idx = seg.y0 / 10;
    y += prevIndex >= 0 && idx - prevIndex > 1 ? 30 : 10;
    seg.y0 = y;
    seg.y1 = y + 8;
    prevIndex = idx;
  }
  const paras = buildParagraphs(finalSegs, 100);
  return {
    rawText: String(text || '').trim(),
    cleanText: cleanTextFromParas(paras),
    notes: shapeNotes(buildNotes(paras), text),
    stats: { lines: entries.length, kept: finalSegs.length, removed: countReasons(entries), sidebar: false, browserChrome: false },
  };
}

// --- Content type -----------------------------------------------------------

const CONTENT_TYPES = {
  education: 'tutorial or lesson',
  video: 'video',
  code: 'code or terminal',
  docs: 'documentation',
  document: 'document or PDF',
  article: 'article or web page',
  general: 'general screen',
};
const EDU_CUE_RE = /\b(tutorial|lesson|lecture|course|chapter|module \d+|explained|how to|introduction to|beginners?|crash course|exam|syllabus|class \d+)\b/i;
const VIDEO_CUE_RE = /(youtube|youtu\.be|vimeo|\bsubscribe\b|\b\d[\d.,]*\s?[KMB]? views\b|\b\d{1,2}:\d{2}\s*\/\s*\d{1,2}:\d{2}\b)/i;
const ERROR_CUE_RE = /(\bPS [A-Z]:\\|Traceback \(most recent call last\)|npm ERR!|\b(Syntax|Type|Reference)Error\b|\bat \S+ \(\S+:\d+:\d+\)|exit code \d+)/;
const DOCS_CUE_RE = /\b(documentation|docs|api reference|parameters?|arguments?|returns?|syntax|usage|installation|getting started|deprecated|methods?|properties)\b/gi;

// `rawText` includes browser chrome and sidebars, which reveal the kind of page;
// the notes themselves only come from the cleaned main content.
function detectContentType(rawText, notes) {
  const raw = String(rawText || '');
  const codeChars = notes.code.join('\n').length;
  const proseChars = [...notes.keyPoints, ...notes.details, ...notes.steps].join(' ').length;
  if (notes.commands.length >= 2 || ERROR_CUE_RE.test(raw) || (codeChars > 40 && codeChars >= proseChars * 0.6)) return 'code';
  if (VIDEO_CUE_RE.test(raw)) return EDU_CUE_RE.test(raw) || notes.definitions.length ? 'education' : 'video';
  if (/\.pdf\b|\bpage \d+ (of|\/) \d+\b|adobe acrobat/i.test(raw)) return 'document';
  const docsHits = (raw.match(DOCS_CUE_RE) || []).length;
  if (docsHits >= 3 || (docsHits >= 1 && notes.code.length)) return 'docs';
  if (EDU_CUE_RE.test(raw) || notes.definitions.length >= 2 || notes.steps.length >= 3) return 'education';
  if (notes.keyPoints.length + notes.details.length >= 4) return 'article';
  return 'general';
}

// Adds `type` and orders the key points the way that kind of content is usually studied.
function shapeNotes(notes, rawText) {
  const type = detectContentType(rawText, notes);
  let keyPoints = notes.keyPoints.slice();
  if (['article', 'document', 'general', 'video'].includes(type) && notes.mainIdea && keyPoints.includes(notes.mainIdea)) {
    keyPoints = [notes.mainIdea, ...keyPoints.filter((p) => p !== notes.mainIdea)];
  }
  if ((type === 'code' || type === 'docs') && keyPoints.length < 3) {
    for (const cmd of notes.commands) {
      if (keyPoints.length >= 5) break;
      keyPoints.push(`Command: ${cmd}`);
    }
  }
  return { ...notes, type, keyPoints: dedupePoints(keyPoints) };
}

// Editable "details" text for the note preview. With a content type the
// sections are named and ordered for that kind of content.
function composeDetails(notes, type) {
  if (type && CONTENT_TYPES[type]) return composeTypedDetails(notes, type);
  const parts = [];
  if (notes.definitions && notes.definitions.length) {
    parts.push('Definitions\n' + notes.definitions.map((d) => `- ${d.text || `${d.term}: ${d.meaning}`}`).join('\n'));
  }
  if (notes.steps && notes.steps.length) {
    parts.push('Steps\n' + notes.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'));
  }
  if (notes.examples && notes.examples.length) {
    parts.push('Examples\n' + notes.examples.map((e) => `- ${e}`).join('\n'));
  }
  if (notes.code && notes.code.length) {
    parts.push('Code\n' + notes.code.map((c) => '```\n' + c + '\n```').join('\n'));
  }
  if (notes.details && notes.details.length) {
    parts.push('More details\n' + notes.details.map((d) => `- ${d}`).join('\n'));
  }
  if (notes.headings && notes.headings.length) {
    parts.push('Sections on screen\n' + notes.headings.map((h) => `- ${h}`).join('\n'));
  }
  if (notes.links && notes.links.length) {
    parts.push('Links\n' + notes.links.map((l) => `- ${l}`).join('\n'));
  }
  return parts.join('\n\n');
}

function composeTypedDetails(notes, type) {
  const list = (items) => items.map((x) => `- ${x}`).join('\n');
  const section = (heading, body) => (body ? `${heading}\n${body}` : '');
  const defs = (notes.definitions || []).map((d) => d.text || `${d.term}: ${d.meaning}`);
  const steps = (notes.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n');
  const code = (notes.code || []).map((c) => '```\n' + c + '\n```').join('\n');
  const examples = list(notes.examples || []);
  const details = list(notes.details || []);
  const sections = list(notes.headings || []);
  const links = list(notes.links || []);
  let parts;
  if (type === 'code' || type === 'docs') {
    parts = [
      section('Commands', list(notes.commands || [])),
      section('Code', code),
      section('Key concepts', list(defs)),
      section('Steps', steps),
      section('Implementation details', details),
      section('Examples', examples),
      section('Sections on screen', sections),
      section('Links', links),
    ];
  } else if (type === 'education') {
    parts = [
      section('Key concepts', list(defs)),
      section('Steps', steps),
      section('Examples', examples),
      section('Important details', details),
      section('Code', code),
      section('Sections on screen', sections),
      section('Links', links),
    ];
  } else {
    parts = [
      section('Supporting details', details),
      section('Key terms', list(defs)),
      section('Examples', examples),
      section('Steps', steps),
      section('Code', code),
      section('Sections on screen', sections),
      section('Links', links),
    ];
  }
  return parts.filter(Boolean).join('\n\n');
}

// Rejects AI output that is not supported by the source text.
function isGrounded(text, source) {
  const vocab = new Set(contentTokens(source).map((t) => t.slice(0, 5)));
  const toks = contentTokens(text);
  if (!toks.length) return false;
  const hits = toks.filter((t) => vocab.has(t.slice(0, 5))).length;
  return hits / toks.length >= 0.6;
}

module.exports = {
  processOcr,
  processText,
  composeDetails,
  detectContentType,
  shapeNotes,
  dedupePoints,
  CONTENT_TYPES,
  isGrounded,
  pickTitle,
  clauseTitle,
  fallbackTitle,
  coveredByTitle,
  cleanUrl,
  isCodeLike,
  extractSegments,
  splitSentences,
  parseDefinition,
};
