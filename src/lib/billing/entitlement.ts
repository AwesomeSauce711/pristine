import 'server-only';

import type Stripe from 'stripe';
import { PLANS, type Plan, type PlanId } from '@/lib/plans';

/*
 * entitlement.ts — turning a Stripe subscription into an access window.
 *
 * This is the single most consequential mapping in the product: get it wrong in
 * one direction and paying customers are locked out, get it wrong in the other
 * and the product is free. It lives in one pure function so it can be reasoned
 * about and tested without a database or a network.
 *
 * The output is written into `entitlements` by the webhook handler, in the same
 * transaction as the subscription row. The patch endpoint then reads that one
 * row and does no status logic at all.
 */

export type EntitlementState = 'none' | 'trialing' | 'active' | 'grace' | 'expired' | 'revoked';

export interface ComputedEntitlement {
  state: EntitlementState;
  accessUntil: Date;
  inTrial: boolean;
  cancelAtPeriodEnd: boolean;
  tier: PlanId | null;
  dailyPatchCap: number;
  periodPatchCap: number;
  periodStartedAt: Date | null;
}

/** The instant we treat as "no access at all". */
export const EPOCH = new Date(0);

export const NO_ACCESS: ComputedEntitlement = {
  state: 'none',
  accessUntil: EPOCH,
  inTrial: false,
  cancelAtPeriodEnd: false,
  tier: null,
  dailyPatchCap: 0,
  periodPatchCap: 0,
  periodStartedAt: null,
};

export interface SubscriptionFacts {
  status: Stripe.Subscription.Status;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  trialEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  endedAt: Date | null;
  /** Null means they have never successfully paid. */
  firstPaidAt: Date | null;
  tier: PlanId | null;
}

const addHours = (d: Date, h: number) => new Date(d.getTime() + h * 3600_000);

/**
 * Map one subscription to an access window.
 *
 * The awkward cases, and why they are handled the way they are:
 *
 * - **`cancel_at_period_end` does not shorten access.** Stripe keeps the status
 *   `active` until the period actually ends, and the customer has paid for that
 *   period. Cutting them off at the moment they click cancel is both wrong and
 *   a reliable way to convert a quiet cancellation into a chargeback.
 *
 * - **`past_due` keeps access, for a while.** Stripe does not advance
 *   `current_period_end` when a renewal fails, so `periodEnd + grace` is
 *   naturally "the period they paid for, plus a tail while retries run". Cutting
 *   a paying customer off over a transient decline generates support load and
 *   disputes.
 *
 * - **Grace requires having paid at least once.** Without this, a trial whose
 *   very first charge fails would collect 24–72 free hours on top of the trial,
 *   which is a farming route rather than a courtesy.
 *
 * - **`unpaid` gets nothing.** That status means dunning is exhausted, which is
 *   a different thing from a payment that might still succeed.
 *
 * - **`incomplete` gets nothing.** The first payment has not completed; treating
 *   it as access would hand out the product for an abandoned checkout.
 */
export function computeEntitlement(sub: SubscriptionFacts | null): ComputedEntitlement {
  if (!sub || !sub.tier) return NO_ACCESS;

  const plan: Plan | undefined = PLANS[sub.tier];
  if (!plan) return NO_ACCESS;

  const caps = {
    tier: sub.tier,
    dailyPatchCap: plan.dailyPatchCap,
    periodPatchCap: plan.periodPatchCap,
    periodStartedAt: sub.currentPeriodStart,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
  };

  // Grace is only extended to someone who has actually paid us.
  const grace = sub.firstPaidAt ? plan.graceHours : 0;
  const periodEnd = sub.currentPeriodEnd;

  switch (sub.status) {
    case 'trialing': {
      const until = sub.trialEnd ?? periodEnd;
      if (!until) return NO_ACCESS;
      /*
       * A trial gets the TRIAL caps, not the paid ones. Without this branch a
       * farmed 7-day monthly trial is worth 280 patched 4K files — more product
       * than most paying customers consume in a month, for nothing.
       *
       * The caps are a material term of the offer, so they are disclosed next to
       * the card field before payment details are taken; see disclosure() in
       * plans.ts. Enforcing a limit that was never disclosed is the problem this
       * is meant to avoid, not a smaller version of it.
       */
      return {
        ...caps,
        dailyPatchCap: plan.trialDailyPatchCap,
        periodPatchCap: plan.trialPeriodPatchCap,
        state: 'trialing',
        inTrial: true,
        accessUntil: until,
      };
    }

    case 'active': {
      if (!periodEnd) return NO_ACCESS;
      return {
        ...caps,
        state: 'active',
        inTrial: false,
        // No retry is coming for a subscription already set to end, so no tail.
        accessUntil: sub.cancelAtPeriodEnd ? periodEnd : addHours(periodEnd, grace),
      };
    }

    case 'past_due': {
      if (!periodEnd) return NO_ACCESS;
      return { ...caps, state: 'grace', inTrial: false, accessUntil: addHours(periodEnd, grace) };
    }

    case 'canceled':
    case 'unpaid':
    case 'incomplete':
    case 'incomplete_expired':
    case 'paused':
    default:
      return {
        ...caps,
        state: sub.status === 'canceled' || sub.status === 'unpaid' ? 'expired' : 'none',
        inTrial: false,
        accessUntil: EPOCH,
      };
  }
}

/**
 * Choose which subscription governs, when a user somehow has more than one.
 *
 * Prefer anything live, latest period end first; otherwise the most recently
 * ended. Duplicates should be prevented at checkout, but the schema
 * deliberately permits them rather than risking a webhook that can never
 * succeed — so this has to make a decision rather than assume.
 */
export function governingSubscription<T extends SubscriptionFacts>(subs: T[]): T | null {
  if (!subs.length) return null;
  const live = subs.filter((s) => ['trialing', 'active', 'past_due'].includes(s.status));
  const pool = live.length ? live : subs;
  return [...pool].sort((a, b) => {
    const at = a.currentPeriodEnd?.getTime() ?? a.endedAt?.getTime() ?? 0;
    const bt = b.currentPeriodEnd?.getTime() ?? b.endedAt?.getTime() ?? 0;
    return bt - at;
  })[0] ?? null;
}

/** Is this computed entitlement currently valid? */
export const hasAccess = (e: ComputedEntitlement, now = new Date()): boolean =>
  e.accessUntil.getTime() > now.getTime();
