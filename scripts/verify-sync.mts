/*
 * verify-sync.mts — the drift-correction decision.
 *
 * The rest of the sync is DOM and timing and needs a real, VISIBLE browser:
 * requestAnimationFrame is throttled to zero on a hidden document, so an
 * automated check of the whole loop reports a stall no user would ever see.
 * This pins the part that carries the judgement.
 *
 * The correction is proportional: a slip is closed at a rate that grows with
 * the slip and is capped where motion would start to look fast or slow. A
 * a frame of sampling jitter is left alone; anything past an eighth of a second is
 * a seek, because nothing gradual closes a loop wrap or a stall.
 */

import { correctionFor } from '../src/components/CompareSlider';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  cond ? pass++ : fail++;
};

console.log('\nvideo sync\n');

const inSync = correctionFor(0.003);
ok('a quarter of a frame apart is left alone', !inSync.seek && inSync.rate === 1,
  'correcting what nobody can see is what makes it visible');

/*
 * REGRESSION. `video.currentTime` steps once per frame, and the two elements do
 * not step together, so the drift measured between two perfectly synchronised
 * clips still swings by up to a full frame. A deadband under that turns every
 * sample into a correction: the rate is nudged either side of 1 at 60Hz and the
 * comparison visibly stutters. This is not a hypothetical — a deadband of a
 * quarter of a frame shipped, and the judder was reported from the page.
 */
const samplingJitter = correctionFor(0.016);
ok('a single frame of sampling jitter is not treated as drift',
  !samplingJitter.seek && samplingJitter.rate === 1,
  'a deadband below one frame corrects every frame, which IS the judder');

const slightlyAhead = correctionFor(0.05);
ok('slightly ahead slows down, without seeking',
  !slightlyAhead.seek && slightlyAhead.rate < 1 && slightlyAhead.rate >= 0.96,
  String(slightlyAhead.rate));

const slightlyBehind = correctionFor(-0.05);
ok('slightly behind speeds up, without seeking',
  !slightlyBehind.seek && slightlyBehind.rate > 1 && slightlyBehind.rate <= 1.04,
  String(slightlyBehind.rate));

const bigger = correctionFor(0.09);
ok('a bigger slip is closed faster', bigger.rate < slightlyAhead.rate && !bigger.seek,
  `${bigger.rate} < ${slightlyAhead.rate}`);

/*
 * Continuity at the deadband. Scaling the nudge from zero drift rather than
 * from the deadband makes the rate jump straight to ~0.95 the moment a
 * measurement wobbles over the line — a visible hitch, and a second cause of
 * the judder the correction is there to remove.
 */
const justInside = correctionFor(0.0331);
const justOutside = correctionFor(0.0335);
ok('the correction starts from nothing at the deadband, with no step',
  justInside.rate === 1 && Math.abs(justOutside.rate - 1) < 0.005,
  `${justInside.rate} -> ${justOutside.rate}`);

const wrapped = correctionFor(-3.9);
ok('a loop wrap seeks', wrapped.seek && wrapped.rate === 1,
  'nothing gradual closes four seconds');

const stalled = correctionFor(1.5);
ok('a long stall seeks', stalled.seek);

ok('past an eighth of a second it seeks', correctionFor(0.13).seek && !correctionFor(0.11).seek);

/* The rate never strays far enough to be perceptible as fast or slow motion. */
const rates = [0.004, 0.05, 0.09, 0.1, -0.05, -0.1].map((d) => correctionFor(d).rate);
ok('every nudge stays within 8%', rates.every((r) => Math.abs(r - 1) <= 0.08 + 1e-9),
  rates.join(', '));

/* Symmetry: the response to being ahead must mirror being behind, or the
 * correction biases in one direction and drift accumulates over many loops. */
ok('correction is symmetric',
  Math.abs((correctionFor(0.09).rate - 1) + (correctionFor(-0.09).rate - 1)) < 1e-9);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
