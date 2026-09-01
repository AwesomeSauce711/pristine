/*
 * verify-entitlement.mts — the status-to-access mapping.
 *
 * Every one of these cases is a way to lose money or a customer. Getting
 * `past_due` wrong locks out someone whose card blipped; getting `incomplete`
 * wrong gives the product away to an abandoned checkout; getting
 * `cancel_at_period_end` wrong converts a quiet cancellation into a chargeback.
 *
 * The function is pure, so all of it is testable without a database, a network,
 * or Stripe. There is no excuse for not covering it completely.
 *
 * Run: npx tsx --conditions=react-server scripts/verify-entitlement.mts
 */

import {
  computeEntitlement, governingSubscription, hasAccess, EPOCH,
  type SubscriptionFacts,
} from '../src/lib/billing/entitlement';
import { PLANS, disclosure } from '../src/lib/plans';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? ' — ' + extra : ''));
  cond ? pass++ : fail++;
};

const NOW = new Date('2026-06-01T12:00:00Z');
const hours = (n: number) => new Date(NOW.getTime() + n * 3600_000);
const days = (n: number) => hours(n * 24);

const base = (over: Partial<SubscriptionFacts> = {}): SubscriptionFacts => ({
  status: 'active',
  currentPeriodStart: days(-30),
  currentPeriodEnd: days(1),
  trialEnd: null,
  cancelAtPeriodEnd: false,
  endedAt: null,
  firstPaidAt: days(-30),
  tier: 'month',
  ...over,
});

console.log('\nentitlement mapping\n');

/* ---- the states that grant access -------------------------------------- */

{
  const e = computeEntitlement(base({ status: 'active' }));
  ok('active grants access', hasAccess(e, NOW) && e.state === 'active');
  ok('active adds the grace tail after the period ends',
    e.accessUntil.getTime() === days(1).getTime() + PLANS.month.graceHours * 3600_000,
    e.accessUntil.toISOString());
  ok('active is not marked as a trial', e.inTrial === false);
  ok('active carries the plan caps',
    e.dailyPatchCap === PLANS.month.dailyPatchCap && e.periodPatchCap === PLANS.month.periodPatchCap);
}

{
  const e = computeEntitlement(base({ status: 'trialing', trialEnd: days(5), firstPaidAt: null }));
  ok('trialing grants access', hasAccess(e, NOW) && e.state === 'trialing');
  ok('trialing ends exactly at trial_end, with no grace',
    e.accessUntil.getTime() === days(5).getTime(), e.accessUntil.toISOString());
  ok('trialing is marked as a trial', e.inTrial === true);

  /*
   * The trial must NOT inherit the paid caps. This is the anti-farming control:
   * without it a 7-day monthly trial is worth 280 patched 4K files for nothing,
   * which is more product than most paying customers use in a month.
   */
  ok('a trial gets the trial caps, not the paid ones',
    e.dailyPatchCap === PLANS.month.trialDailyPatchCap &&
    e.periodPatchCap === PLANS.month.trialPeriodPatchCap,
    `${e.dailyPatchCap}/day, ${e.periodPatchCap}/period`);
  ok('the trial caps are genuinely lower than the paid caps',
    PLANS.month.trialDailyPatchCap < PLANS.month.dailyPatchCap &&
    PLANS.month.trialPeriodPatchCap < PLANS.month.periodPatchCap,
    `trial ${PLANS.month.trialDailyPatchCap}/${PLANS.month.trialPeriodPatchCap} vs paid ${PLANS.month.dailyPatchCap}/${PLANS.month.periodPatchCap}`);

  const paid = computeEntitlement(base({ status: 'active', currentPeriodEnd: days(20), firstPaidAt: days(-1) }));
  ok('a paying subscriber gets the full caps',
    paid.dailyPatchCap === PLANS.month.dailyPatchCap &&
    paid.periodPatchCap === PLANS.month.periodPatchCap,
    `${paid.dailyPatchCap}/day, ${paid.periodPatchCap}/period`);

  /*
   * The trial cap is a material term of the offer, so it has to appear in the
   * text shown next to the card field — enforcing an undisclosed limit is the
   * problem this exists to avoid, not a smaller version of it.
   */
  const text = disclosure(PLANS.month, new Date('2026-09-08T02:15:15Z'));
  ok('the disclosure states the trial cap',
    text.includes(String(PLANS.month.trialDailyPatchCap)) &&
    text.includes(String(PLANS.month.trialPeriodPatchCap)));
  ok('the disclosure names a timezone, so the charge date cannot drift with the host',
    text.includes('(UTC)'));
  ok('the disclosure renders the same date regardless of process timezone',
    text.includes('September 8, 2026'), text.slice(text.indexOf('On '), text.indexOf('your card')));
  ok('the disclosure no longer promises a per-payment-method limit it cannot keep',
    !text.includes('per payment method'));
}

{
  // The card blipped. Stripe is retrying. They have paid before.
  const e = computeEntitlement(base({ status: 'past_due', currentPeriodEnd: hours(-2) }));
  ok('past_due keeps access while Stripe retries', hasAccess(e, NOW) && e.state === 'grace');
  ok('past_due access ends period_end + grace',
    e.accessUntil.getTime() === hours(-2).getTime() + PLANS.month.graceHours * 3600_000);
}

/* ---- the states that must NOT grant access ------------------------------ */

for (const status of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'] as const) {
  const e = computeEntitlement(base({ status }));
  ok(`${status} grants nothing`, !hasAccess(e, NOW), `until ${e.accessUntil.toISOString()}`);
}

ok('a null subscription grants nothing', !hasAccess(computeEntitlement(null), NOW));
ok('a subscription with no tier grants nothing',
  !hasAccess(computeEntitlement(base({ tier: null })), NOW));

/* ---- the subtle ones ---------------------------------------------------- */

{
  // Cancelling must not cut access short: they paid for this period.
  const e = computeEntitlement(base({ status: 'active', cancelAtPeriodEnd: true }));
  ok('cancel_at_period_end still grants access until the period ends',
    hasAccess(e, NOW) && e.state === 'active');
  ok('cancel_at_period_end gets NO grace tail (no retry is coming)',
    e.accessUntil.getTime() === days(1).getTime(), e.accessUntil.toISOString());
  ok('cancel_at_period_end is surfaced for the UI', e.cancelAtPeriodEnd === true);
}

{
  // A trial whose very first charge failed. Grace here would be free days on
  // top of the trial, which is a farming route rather than a courtesy.
  const e = computeEntitlement(base({ status: 'past_due', firstPaidAt: null, currentPeriodEnd: hours(-1) }));
  ok('past_due with no successful payment ever gets NO grace',
    e.accessUntil.getTime() === hours(-1).getTime() && !hasAccess(e, NOW),
    e.accessUntil.toISOString());
}

{
  const wk = computeEntitlement(base({ status: 'active', tier: 'week' }));
  const yr = computeEntitlement(base({ status: 'active', tier: 'year' }));
  ok('grace length follows the plan',
    wk.accessUntil.getTime() === days(1).getTime() + PLANS.week.graceHours * 3600_000 &&
    yr.accessUntil.getTime() === days(1).getTime() + PLANS.year.graceHours * 3600_000,
    `week ${PLANS.week.graceHours}h vs year ${PLANS.year.graceHours}h`);
}

{
  const e = computeEntitlement(base({ status: 'active', currentPeriodEnd: null }));
  ok('active with no period end grants nothing rather than guessing',
    !hasAccess(e, NOW) && e.accessUntil.getTime() === EPOCH.getTime());
}

{
  const e = computeEntitlement(base({ status: 'trialing', trialEnd: null, currentPeriodEnd: days(3), firstPaidAt: null }));
  ok('trialing falls back to period end when trial_end is missing',
    e.accessUntil.getTime() === days(3).getTime());
}

/* ---- expiry is a function of time, not of status ------------------------ */

{
  const e = computeEntitlement(base({ status: 'active', currentPeriodEnd: days(-10) }));
  ok('an active subscription whose window has passed has no access',
    !hasAccess(e, NOW), `access until ${e.accessUntil.toISOString()}, now ${NOW.toISOString()}`);
}

/* ---- choosing between several subscriptions ----------------------------- */

{
  ok('no subscriptions picks nothing', governingSubscription([]) === null);

  const dead = base({ status: 'canceled', currentPeriodEnd: days(-1), endedAt: days(-1) });
  const live = base({ status: 'active', currentPeriodEnd: days(20) });
  ok('a live subscription beats a dead one regardless of order',
    governingSubscription([dead, live]) === live && governingSubscription([live, dead]) === live);

  const soon = base({ status: 'active', currentPeriodEnd: days(2) });
  const later = base({ status: 'active', currentPeriodEnd: days(40) });
  ok('among live ones, the furthest period end wins',
    governingSubscription([soon, later]) === later);

  const older = base({ status: 'canceled', currentPeriodEnd: days(-90), endedAt: days(-90) });
  const newer = base({ status: 'canceled', currentPeriodEnd: days(-5), endedAt: days(-5) });
  ok('with nothing live, the most recent dead one wins',
    governingSubscription([older, newer]) === newer);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
