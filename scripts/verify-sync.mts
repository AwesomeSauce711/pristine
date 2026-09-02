/*
 * verify-sync.mts — the drift-correction decision.
 *
 * The rest of the sync is DOM and timing and needs a real, VISIBLE browser:
 * requestAnimationFrame is throttled to zero on a hidden document, so an
 * automated check of the whole loop reports a stall no user would ever see.
 * This pins the part that carries the judgement.
 */

import { correctionFor } from '../src/components/CompareSlider';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  cond ? pass++ : fail++;
};

console.log('\nvideo sync\n');

const inSync = correctionFor(0.005);
ok('half a frame apart is left alone', !inSync.seek && inSync.rate === 1,
  'correcting what nobody can see is what makes it visible');

const slightlyAhead = correctionFor(0.05);
ok('slightly ahead slows down, without seeking',
  !slightlyAhead.seek && slightlyAhead.rate === 0.98);

const slightlyBehind = correctionFor(-0.05);
ok('slightly behind speeds up, without seeking',
  !slightlyBehind.seek && slightlyBehind.rate === 1.02);

const wrapped = correctionFor(-3.9);
ok('a loop wrap seeks', wrapped.seek && wrapped.rate === 1,
  'nothing gradual closes four seconds');

const stalled = correctionFor(1.5);
ok('a long stall seeks', stalled.seek);

/* The rate never strays far enough to be perceptible as fast or slow motion. */
const rates = [0.004, 0.02, 0.05, 0.2, -0.02, -0.2].map((d) => correctionFor(d).rate);
// 0.98 - 1 is -0.020000000000000018 in binary floating point, so compare with an
// epsilon rather than asserting an exact bound the arithmetic cannot honour.
ok('every nudge stays within 2%', rates.every((r) => Math.abs(r - 1) <= 0.02 + 1e-9),
  rates.join(', '));

/* Symmetry: the response to being ahead must mirror being behind, or the
 * correction biases in one direction and drift accumulates over many loops. */
ok('correction is symmetric',
  correctionFor(0.05).rate - 1 === -(correctionFor(-0.05).rate - 1));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
