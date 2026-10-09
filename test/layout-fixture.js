'use strict';

// Builds Tesseract-shaped `recognize` output (blocks → paragraphs → lines → words)
// from simple text rows, so the notes pipeline can be tested without running OCR.

function wordsFor(text, x, y, h, conf) {
  const charW = h * 0.55;
  const words = [];
  let cx = x;
  for (const t of text.split(' ')) {
    const w = Math.max(charW, t.length * charW);
    words.push({ text: t, confidence: conf, bbox: { x0: cx, y0: y, x1: cx + w, y1: y + h } });
    cx += w + charW;
  }
  return words;
}

// rows: [{ text, x, y, h = 16, conf = 92 }, ...]; each row becomes its own block.
function layout(rows) {
  const blocks = rows.map((r) => ({
    paragraphs: [{ lines: [{ words: wordsFor(r.text, r.x, r.y, r.h || 16, r.conf == null ? 92 : r.conf) }] }],
  }));
  return { text: rows.map((r) => r.text).join('\n'), blocks };
}

const TUTORIAL_ROWS = [
  { text: 'Python Lists Tutorial x', x: 10, y: 8, h: 14 },
  { text: 'New Tab x', x: 300, y: 8, h: 14 },
  { text: 'Inbox (3) x', x: 480, y: 8, h: 14 },
  { text: 'https://www.example.com/python/lists?utm_source=newsletter&utm_medium=email', x: 120, y: 44, h: 14 },
  { text: 'Python Lists', x: 380, y: 150, h: 36 },
  { text: 'A list is an ordered collection of items that can hold values of different types.', x: 380, y: 210 },
  { text: 'Lists are created with square brackets and items are separated by commas.', x: 380, y: 240 },
  { text: 'Important: lists are mutable so you can change items after creating them.', x: 380, y: 270 },
  { text: 'Important: lists are mutable so you can change items after creating them.', x: 380, y: 300 },
  { text: "fruits = ['apple', 'banana', 'cherry']", x: 380, y: 340 },
  { text: 'Read more at https://docs.python.org/3/tutorial/datastructures.html for details.', x: 380, y: 380 },
  { text: 'Learn Python in 10 minutes', x: 1220, y: 150 },
  { text: '1.2M views 3 days ago', x: 1220, y: 172, h: 12 },
  { text: 'Top 10 list tricks you should know', x: 1220, y: 220 },
  { text: '540K views 1 week ago', x: 1220, y: 242, h: 12 },
  { text: 'Sponsored', x: 1220, y: 290, h: 12 },
  { text: '10:42 AM', x: 1500, y: 968, h: 12 },
];

module.exports = { layout, TUTORIAL_ROWS, WIDTH: 1600, HEIGHT: 1000 };
