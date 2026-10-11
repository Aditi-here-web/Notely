'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  WORKFLOW, STEP_TOTAL, stageToStep, stepCaption, chipClasses,
} = require('../workflow');

test('the workflow is five steps and includes Save', () => {
  assert.equal(STEP_TOTAL, 5);
  assert.deepEqual(WORKFLOW.map((s) => s.id), ['capture', 'ocr', 'clean', 'review', 'saved']);
  assert.deepEqual(WORKFLOW.map((s) => s.n), [1, 2, 3, 4, 5]);
  assert.ok(WORKFLOW.every((s) => s.label.startsWith(`${s.n}. `)));
});

test('status captions use the same count as the chips', () => {
  assert.equal(stepCaption('capture', 'capturing the screen...'), 'Step 1 of 5: capturing the screen...');
  assert.equal(stepCaption('ocr', 'reading text from the screenshot...'), 'Step 2 of 5: reading text from the screenshot...');
  assert.equal(stepCaption('clean', 'removing extra interface text...'), 'Step 3 of 5: removing extra interface text...');
  assert.equal(stepCaption('summarize', 'building notes from the main content...'), 'Step 3 of 5: building notes from the main content...');
  assert.equal(stepCaption('review', 'review and edit the draft, then click Save note.'), 'Step 4 of 5: review and edit the draft, then click Save note.');
  assert.equal(stepCaption('saved', 'saved in Notely.'), 'Step 5 of 5: saved in Notely.');
  assert.equal(stepCaption('idle', 'ready'), 'ready');
});

test('clean and summarize share one chip so the bar stays at five steps', () => {
  assert.equal(stageToStep('summarize'), 'clean');
  assert.deepEqual(chipClasses('summarize'), ['done', 'done', 'active', '', '']);
  assert.deepEqual(chipClasses('clean'), chipClasses('summarize'));
});

test('chip completion follows the active stage and marks Save done only after save', () => {
  assert.deepEqual(chipClasses('idle'), ['', '', '', '', '']);
  assert.deepEqual(chipClasses('capture'), ['active', '', '', '', '']);
  assert.deepEqual(chipClasses('capture', true), ['failed', '', '', '', '']);
  assert.deepEqual(chipClasses('ocr'), ['done', 'active', '', '', '']);
  assert.deepEqual(chipClasses('review'), ['done', 'done', 'done', 'active', '']);
  assert.deepEqual(chipClasses('saved'), ['done', 'done', 'done', 'done', 'done']);
});
