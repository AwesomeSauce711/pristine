import 'server-only';

import Stripe from 'stripe';
import { PLANS, PLAN_ORDER, type PlanId } from '@/lib/plans';

/*
 * stripe.ts — the client, and the small amount of shape-knowledge around it.
 *
 * The API version is deliberately NOT pinned to a hand-written string. The SDK
 * ships types generated for exactly one version, and pinning a different one
 * gives you types that quietly disagree with the JSON you actually receive.
 * Upgrading the SDK is therefore the way to change API version.
 */

let cached: Stripe | null = null;

export function stripe(): Stripe {
  if (cached) return cached;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      'STRIPE_SECRET_KEY is not set. Copy .env.example to .env.local and fill it in.',
    );
  }
  cached = new Stripe(key, {
    // Retries make webhook-triggered re-fetches survive a blip without losing
    // the event, since a thrown handler means Stripe redelivers.
    maxNetworkRetries: 2,
    timeout: 10_000,
  });
  return cached;
}

/** Map a Stripe Price id back to one of our plans. */
export function planForPriceId(priceId: string | null | undefined): PlanId | null {
  if (!priceId) return null;
  for (const id of PLAN_ORDER) {
    if (process.env[PLANS[id].priceEnv] === priceId) return id;
  }
  return null;
}

export function priceIdForPlan(id: PlanId): string {
  const envName = PLANS[id].priceEnv;
  const value = process.env[envName];
  if (!value) {
    throw new Error(`${envName} is not set. Run \`npm run stripe:seed\` to create the Prices.`);
  }
  return value;
}

const secs = (v: number | null | undefined): Date | null =>
  typeof v === 'number' ? new Date(v * 1000) : null;

/**
 * The billing period, read from the SUBSCRIPTION ITEM.
 *
 * This is not where it used to be. In current Stripe API versions
 * `current_period_start` / `current_period_end` live on each SubscriptionItem
 * rather than on the Subscription — verified against the installed SDK's own
 * types, not from memory. Reading them off the Subscription yields `undefined`,
 * which would compute an empty access window and lock out every paying
 * customer, so this is isolated here with a comment rather than inlined.
 *
 * We only ever sell single-item subscriptions, so the first item is the period.
 */
export function periodOf(sub: Stripe.Subscription): {
  start: Date | null;
  end: Date | null;
} {
  const item = sub.items?.data?.[0];
  return { start: secs(item?.current_period_start), end: secs(item?.current_period_end) };
}

export const priceIdOf = (sub: Stripe.Subscription): string | null =>
  sub.items?.data?.[0]?.price?.id ?? null;

export const trialEndOf = (sub: Stripe.Subscription): Date | null => secs(sub.trial_end);
export const trialStartOf = (sub: Stripe.Subscription): Date | null => secs(sub.trial_start);
export const canceledAtOf = (sub: Stripe.Subscription): Date | null => secs(sub.canceled_at);
export const endedAtOf = (sub: Stripe.Subscription): Date | null => secs(sub.ended_at);
