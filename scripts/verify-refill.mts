/*
 * verify-refill.mts -- what a refill adds, exactly.
 *
 * The allowance arithmetic is the whole feature: a refill must add exactly the
 * cap it was bought against, never take anything away, and never go negative.
 * Off by one here is a customer charged 99 cents for nothing.
 */
import { remainingWithRefills } from '../src/lib/entitlement';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
  cond ? pass++ : fail++;
};

console.log('\nrefill allowance\n');

ok('a fresh day on the weekly plan has its one', remainingWithRefills(1, 0, 0) === 1);
ok('the one used, nothing left', remainingWithRefills(1, 1, 0) === 0);
ok('one refill on weekly gives one more', remainingWithRefills(1, 1, 1) === 1);
ok('two refills on weekly, one used since: two left', remainingWithRefills(1, 1, 2) === 2);
ok('monthly: three used, one refill of three, three left', remainingWithRefills(3, 3, 3) === 3);
ok('yearly: ten used, refilled, then four more used: six left', remainingWithRefills(10, 14, 10) === 6);
ok('never negative', remainingWithRefills(1, 5, 0) === 0 && remainingWithRefills(3, 9, 3) === 0);
ok('a refill never subtracts', [0, 1, 3, 10].every((c) => remainingWithRefills(c, 0, 4) >= c));
ok('garbage counts are treated as none', remainingWithRefills(3, 0, -7) === 3 && remainingWithRefills(3, -2, 0) === 3);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
