'use strict';

// Single source of truth for the capture → save workflow shown in the UI.
// The chips, status line and completion states all read from this list.
(function (root) {
  const WORKFLOW = [
    { id: 'capture', n: 1, label: '1. Capture' },
    { id: 'ocr', n: 2, label: '2. Read text' },
    { id: 'clean', n: 3, label: '3. Clean & summarize' },
    { id: 'review', n: 4, label: '4. Review & edit' },
    { id: 'saved', n: 5, label: '5. Save' },
  ];

  const STEP_TOTAL = WORKFLOW.length;

  function stageToStep(stage) {
    if (stage === 'summarize') return 'clean';
    return WORKFLOW.some((s) => s.id === stage) ? stage : null;
  }

  function stepCaption(stage, detail) {
    const id = stageToStep(stage);
    const step = WORKFLOW.find((s) => s.id === id);
    if (!step) return detail;
    return `Step ${step.n} of ${STEP_TOTAL}: ${detail}`;
  }

  // One class per chip: done, active, failed, or empty (upcoming / idle).
  function chipClasses(stage, failed) {
    const id = stageToStep(stage);
    const idx = WORKFLOW.findIndex((s) => s.id === id);
    return WORKFLOW.map((s, i) => {
      if (idx < 0) return '';
      if (i < idx || (stage === 'saved' && i === idx)) return 'done';
      if (i === idx) return failed ? 'failed' : 'active';
      return '';
    });
  }

  const api = {
    WORKFLOW, STEP_TOTAL, stageToStep, stepCaption, chipClasses,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  root.NotelyWorkflow = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
