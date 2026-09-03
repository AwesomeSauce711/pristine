/*
 * verify-sync.mts -- the comparison draws the crushed side at the right size.
 *
 * WHAT THIS USED TO TEST
 * First the correction that kept two <video> elements together; then the
 * geometry of reading two halves out of one welded file. Both mechanisms are
 * gone: the landing page now shows the same preview the tool page does -- one
 * visible video, and a small crushed copy of it drawn beside it -- which is the
 * only version that ever worked on a phone. There is no sync left to test,
 * because there is one clock.
 *
 * WHAT IS WORTH PINNING NOW
 * How much smaller the crushed copy is drawn. Getting it wrong is silent and
 * it is the whole argument: too small and the text is unreadable and the
 * comparison looks rigged; too large and there is no visible difference. It is
 * relative to the screen, not the source (nobody watches 4K at 4K on a phone),
 * and it never punishes a source that is already at or below the rung.
 */

import { crushReduction } from '../src/components/PreviewCompare';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
  cond ? pass++ : fail++;
};
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

console.log('\ncrush reduction\n');

ok('a 4K source is drawn at 720 over 1080 -- the delivered rung on the screen it lands on',
  near(crushReduction(2160, 720), 720 / 1080), String(crushReduction(2160, 720)));

ok('a 1080p source gets the identical reduction, so the landing clip need not be 4K',
  near(crushReduction(1080, 720), crushReduction(2160, 720)));

ok('a 1440p source too: past the screen, more pixels change nothing',
  near(crushReduction(1440, 720), 720 / 1080));

ok('a 720p source is not made worse by a 720p rung', crushReduction(720, 720) === 1,
  'a source delivered at its own size loses nothing');

ok('a source below the rung is left alone', crushReduction(540, 720) === 1,
  'pretending otherwise would be a lie in our own favour');

ok('the reduction is never above 1', [480, 720, 1080, 2160].every((e) => crushReduction(e, 720) <= 1));

ok('a screen wider than the rung crushes harder than a narrow one -- the screen is the reference',
  crushReduction(2160, 720, 1440) < crushReduction(2160, 720, 1080));

ok('a bigger rung crushes less', crushReduction(2160, 1080) > crushReduction(2160, 720)
  && crushReduction(2160, 1080) === 1);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
