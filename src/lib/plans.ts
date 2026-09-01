/*
 * plans.ts — the pricing ladder.
 *
 * Amounts live here for RENDERING only. Stripe Prices are the source of truth
 * for what is actually charged; these figures exist so the marketing pages can
 * render without an API round-trip. The seed script asserts they match, because
 * a page advertising $19.99 while Stripe charges $24.99 is not a display bug,
 * it is a deceptive-pricing problem.
 *
 * WHY THERE IS NO LIFETIME TIER
 * A one-off "unlimited forever" price below a couple of months of the recurring
 * plan cannibalises the entire subscription business — everyone takes it and
 * recurring revenue never starts. It is also a promise this product cannot
 * honestly make: the method depends on a quirk of TikTok's ingest, and TikTok
 * can change that whenever they like.
 *
 * WHY WEEKLY HAS NO TRIAL
 * A 7-day trial on a 7-day billing period is one free period, repeatable
 * forever — the cleanest farming target you can construct. It is also the exact
 * shape (cheap recurring charge, free trial, impulse signup) that produces the
 * highest chargeback rates, and Stripe acts on accounts above roughly 0.75%
 * disputes. Monthly and annual keep the trial; weekly does not.
 */

export type PlanId = 'week' | 'month' | 'year';

export interface Plan {
  id: PlanId;
  name: string;
  /** Cents, to avoid float money. */
  amount: number;
  interval: 'week' | 'month' | 'year';
  trialDays: number;
  /** Rolling 24h cap. */
  dailyPatchCap: number;
  /** Cap across one billing period. */
  periodPatchCap: number;
  /*
   * TRIAL CAPS — the actual anti-farming control.
   *
   * Identity checks (card fingerprint, IP) reduce the NUMBER of farmed trials,
   * probabilistically and with false positives. A cap reduces the VALUE of each
   * one, deterministically and with none. Only the second is a guarantee.
   *
   * It also degrades gracefully in the case that cannot be solved: a Link or
   * wallet payment exposes no card fingerprint at all, so every fingerprint rule
   * silently passes it. The cap still applies.
   *
   * This is containment, not prevention. It does not stop farming; it makes
   * farming unprofitable, which is the only outcome that can be guaranteed.
   * Tune against observed trial-to-paid conversion — set too low it suppresses
   * genuine evaluation, and a creator who cannot patch their real backlog during
   * the trial does not convert.
   */
  trialDailyPatchCap: number;
  trialPeriodPatchCap: number;
  /** Hours of access retained after a failed renewal, while Stripe retries. */
  graceHours: number;
  badge?: string;
  blurb: string;
  /** Env var holding the Stripe Price id. */
  priceEnv: string;
}

export const PLANS: Record<PlanId, Plan> = {
  week: {
    id: 'week',
    name: 'Weekly',
    amount: 799,
    interval: 'week',
    trialDays: 0,
    dailyPatchCap: 25,
    periodPatchCap: 100,
    // No trial on weekly, so these are never read. Present so the shape is
    // uniform and a future trial cannot silently inherit the paid caps.
    trialDailyPatchCap: 10,
    trialPeriodPatchCap: 25,
    graceHours: 24,
    blurb: 'For one launch, one campaign, one week of posting.',
    priceEnv: 'STRIPE_PRICE_WEEK',
  },
  month: {
    id: 'month',
    name: 'Monthly',
    amount: 1999,
    interval: 'month',
    trialDays: 7,
    dailyPatchCap: 40,
    periodPatchCap: 400,
    trialDailyPatchCap: 10,
    trialPeriodPatchCap: 25,
    graceHours: 72,
    badge: 'Most popular',
    blurb: 'For anyone posting regularly. Cheaper than three weeks.',
    priceEnv: 'STRIPE_PRICE_MONTH',
  },
  year: {
    id: 'year',
    name: 'Annual',
    amount: 7999,
    interval: 'year',
    trialDays: 7,
    dailyPatchCap: 40,
    periodPatchCap: 3000,
    trialDailyPatchCap: 10,
    trialPeriodPatchCap: 25,
    graceHours: 72,
    badge: 'Best value',
    blurb: 'Four months free against monthly.',
    priceEnv: 'STRIPE_PRICE_YEAR',
  },
};

export const PLAN_ORDER: PlanId[] = ['week', 'month', 'year'];

export const money = (cents: number): string =>
  cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;

/** What the annual plan saves against paying monthly for a year. */
export const annualSavingPct = Math.round(
  (1 - PLANS.year.amount / (PLANS.month.amount * 12)) * 100,
);

/**
 * The negative-option disclosure, rendered next to the submit control.
 *
 * This text is a legal requirement, not marketing copy. US ROSCA and state
 * automatic-renewal laws require the price, the frequency, the date of the
 * first charge and how to cancel to be disclosed clearly and conspicuously
 * BEFORE billing information is taken. It is stored verbatim against each
 * consent record, because that stored copy is the evidence in a chargeback or
 * an FTC inquiry.
 */
export function disclosure(plan: Plan, firstChargeAt: Date): string {
  /*
   * UTC, explicitly and labelled.
   *
   * Without `timeZone` this renders in whatever zone the server process happens
   * to run in, so the same instant prints a different DATE depending on where it
   * is deployed — and the date of the first charge is exactly the fact ROSCA and
   * the state automatic-renewal laws require to be stated accurately. A local
   * build in America/Chicago was rendering 7 September for a charge Stripe had
   * scheduled at 2026-09-08T02:15Z.
   *
   * Naming the zone is slightly less friendly than a bare date and considerably
   * more defensible. Stripe's trial_end is a UTC instant; this now matches it.
   */
  const when = firstChargeAt.toLocaleDateString('en-US', {
    timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric',
  });
  const every = plan.interval === 'year' ? 'year' : plan.interval;
  return plan.trialDays > 0
    ? `Your ${plan.trialDays}-day free trial starts today. On ${when} (UTC) your card will be ` +
      `charged ${money(plan.amount)}, and every ${every} after that, until you cancel. ` +
      `Cancel any time from Account → Billing; cancelling takes effect at the end of the ` +
      `period you have paid for. During the trial you can patch up to ` +
      `${plan.trialDailyPatchCap} files per day and ${plan.trialPeriodPatchCap} in total; ` +
      `paid plans have higher limits. Free trials are limited to one per person, and we may ` +
      `offer this plan without a trial where we identify that one has already been used.`
    : `Your card will be charged ${money(plan.amount)} today and every ${every} after that, ` +
      `until you cancel. Cancel any time from Account → Billing; cancelling takes effect at ` +
      `the end of the period you have paid for.`;
}
