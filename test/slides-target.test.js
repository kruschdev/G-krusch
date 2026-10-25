import test from 'node:test';
import assert from 'node:assert/strict';
import { isSlidesTarget, GOOGLE_SLIDES_MIME, PPTX_MIME } from '../src/lib/slides.js';

test('isSlidesTarget detects Google Slides and PPTX MIME types', () => {
  assert.equal(isSlidesTarget('deck', GOOGLE_SLIDES_MIME), true);
  assert.equal(isSlidesTarget('deck', PPTX_MIME), true);
  assert.equal(isSlidesTarget('deck', 'slides'), true);
  assert.equal(isSlidesTarget('deck', 'google-slides'), true);
  assert.equal(isSlidesTarget('deck', '  GOOGLE-SLIDES  '), true);
});

test('isSlidesTarget detects .slides, .gslides, and .pptx file suffixes', () => {
  assert.equal(isSlidesTarget('presentations/q4-review.slides'), true);
  assert.equal(isSlidesTarget('presentations/q4-review.gslides'), true);
  assert.equal(isSlidesTarget('presentations/q4-review.PPTX'), true);
});

test('isSlidesTarget returns false for non-slides paths and MIME types', () => {
  assert.equal(isSlidesTarget('notes/summary.md', 'text/markdown'), false);
  assert.equal(isSlidesTarget('docs/report.gdoc', 'application/vnd.google-apps.document'), false);
  assert.equal(isSlidesTarget('', ''), false);
});
