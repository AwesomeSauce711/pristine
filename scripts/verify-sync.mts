/*
 * verify-sync.mts — the comparison's two halves are the same frame.
 *
 * WHAT THIS USED TO TEST, AND WHY IT NO LONGER DOES
 * The slider was two <video> elements corrected against each other, and this
 * file tested the correction: deadbands, rate nudges, when to seek. Every
 * version of that was wrong in one direction or the other — too eager and it
 * juddered, too loose and the halves sat visibly apart — because two elements
 * are two clocks and `currentTime` is only accurate to a frame, so even the
 * measurement of the error had a frame of noise in it. Both failures were
 * reported from the live page.
 *
 * There is one element now. Both halves are read from a single file that holds
 * the two renditions side by side, in one pair of draw calls on one tick. They
 * are the same frame BY CONSTRUCTION, so there is no timing left to test — and
 * a test suite that went on measuring a mechanism that no longer exists would
 * be worse than none.
 *
 * What is worth pinning is the geometry, because getting it wrong is silent:
 * the halves would still be in sync and you would be looking at the wrong part
 * of the picture, or comparing a half against itself.
 */

import { splitDraw } from '../src/components/CompareSlider';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  cond ? pass++ : fail++;
};

console.log('\ncomparison geometry\n');

/* The real shape: two 540x960 renditions welded side by side. */
const VW = 1080, VH = 960, CW = 900, CH = 1600;

const mid = splitDraw(VW, VH, CW, CH, 50);

ok('the two halves are read from different parts of the source',
  mid.crushed.sx !== mid.pristine.sx,
  `crushed at x=${mid.crushed.sx}, pristine at x=${mid.pristine.sx}`);

ok('the crushed half is the left one', mid.crushed.sx === 0);
ok('the pristine half is the right one', mid.pristine.sx === VW / 2);

ok('neither half reads past its own edge',
  mid.crushed.sx + mid.crushed.sw === VW / 2 && mid.pristine.sx + mid.pristine.sw === VW,
  'a half that overran would show a sliver of the other rendition');

ok('both halves fill the canvas, so the split is a reveal and not a squeeze',
  mid.crushed.dw === CW && mid.pristine.dw === CW && mid.crushed.dh === CH,
  'each side is drawn full-size; the clip is what hides one');

/* Both rectangles carry the whole height: a half-height read would silently
 * letterbox one side against the other. */
ok('both halves take the full height of the source',
  mid.crushed.sh === VH && mid.pristine.sh === VH);

/* The travel. At either end one rendition must be showing WHOLE, with no
 * remnant of the other — that is the whole point of dragging it to the end. */
const left = splitDraw(VW, VH, CW, CH, 0);
ok('dragged fully left, the pristine side covers everything',
  left.clip === 0 && left.pristineVisible, `clip=${left.clip}`);

const right = splitDraw(VW, VH, CW, CH, 100);
ok('dragged fully right, the pristine side is not drawn at all',
  right.clip === CW && !right.pristineVisible,
  'drawing a zero-width sliver is where a seam of the wrong half appears');

/* The divider's position and the clip must be the same number, or the picture
 * and the line the reader is dragging disagree. */
ok('the clip follows the split exactly',
  splitDraw(VW, VH, CW, CH, 25).clip === CW * 0.25
  && splitDraw(VW, VH, CW, CH, 75).clip === CW * 0.75);

/* Out-of-range input comes from motion drive and from a fast drag past the
 * edge; it must clamp rather than read outside the canvas. */
ok('a split past either end clamps',
  splitDraw(VW, VH, CW, CH, -20).clip === 0
  && splitDraw(VW, VH, CW, CH, 140).clip === CW);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
