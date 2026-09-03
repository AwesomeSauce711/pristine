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

/*
 * The price Stripe will actually charge has to be the price the site, the
 * Terms and the consent record all state. They are set in different places —
 * the amount in src/lib/plans.ts, the Price object in Stripe's dashboard, the
 * id in an env var — and nothing else ties them together. A mismatch means
 * a customer is charged an amount they were never shown, which is a refund,
 * a dispute and a regulatory problem in one. So before a checkout session is
 * created the Price is fetched and compared, and a mismatch refuses the sale
 * with a clear message rather than taking the wrong money. Checked once per
 * process every ten minutes; a Price cannot change amount, only be replaced.
 */
export class PriceMismatchError extends Error {
  constructor(public readonly plan: PlanId | 'refill', detail: string) {
    super(`Stripe Price for the ${plan} plan does not match the site: ${detail}`);
    this.name = 'PriceMismatchError';
  }
}

const PRICE_CHECK_TTL_MS = 10 * 60_000;
const priceChecked = new Map<string, number>();
/* A failure is remembered briefly too, so an outage or a mismatch does not
 * turn every checkout and status hit into a fresh round of Stripe calls. */
const PRICE_FAIL_TTL_MS = 30_000;
const priceFailed = new Map<string, { at: number; error: unknown }>();

function rememberedFailure(priceId: string): void {
  const f = priceFailed.get(priceId);
  if (f && Date.now() - f.at < PRICE_FAIL_TTL_MS) throw f.error;
}

export async function verifiedPriceIdForPlan(id: PlanId): Promise<string> {
  const priceId = priceIdForPlan(id);
  const at = priceChecked.get(priceId);
  if (at && Date.now() - at < PRICE_CHECK_TTL_MS) return priceId;
  rememberedFailure(priceId);

  try {
    const plan = PLANS[id];
    const price = await stripe().prices.retrieve(priceId);
    const problems: string[] = [];
    if (!price.active) problems.push('the Price is archived');
    if (price.unit_amount !== plan.amount) {
      problems.push(`Stripe charges ${(price.unit_amount ?? 0) / 100} and the site says ${plan.amount / 100}`);
    }
    if (price.currency !== 'usd') problems.push(`currency is ${price.currency}, not usd`);
    if (price.recurring?.interval !== plan.interval) {
      problems.push(`interval is ${price.recurring?.interval ?? 'one-off'}, not ${plan.interval}`);
    }
    if (problems.length) throw new PriceMismatchError(id, problems.join('; '));
  } catch (error) {
    priceFailed.set(priceId, { at: Date.now(), error });
    throw error;
  }

  priceChecked.set(priceId, Date.now());
  return priceId;
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

/*
 * THE REFILL PRICE: one day's allowance again, for 99 cents, one-time.
 *
 * Optional. Until STRIPE_PRICE_REFILL is set the offer does not appear and the
 * route refuses, so the feature ships inert and switches on when the Price
 * exists (npm run stripe:seed creates it). Verified the same way as the plan
 * prices -- amount, currency, and that it is NOT recurring, because a
 * recurring Price here would silently start a second subscription.
 */
export const REFILL_AMOUNT_CENTS = 99;

export function refillPriceId(): string | null {
  return process.env.STRIPE_PRICE_REFILL || null;
}

export async function verifiedRefillPriceId(): Promise<string> {
  const priceId = refillPriceId();
  if (!priceId) throw new PriceMismatchError('refill', 'STRIPE_PRICE_REFILL is not set');
  const at = priceChecked.get(priceId);
  if (at && Date.now() - at < PRICE_CHECK_TTL_MS) return priceId;

  const price = await stripe().prices.retrieve(priceId);
  const problems: string[] = [];
  if (!price.active) problems.push('the Price is archived');
  if (price.unit_amount !== REFILL_AMOUNT_CENTS) {
    problems.push(`Stripe charges ${(price.unit_amount ?? 0) / 100} and the site says ${REFILL_AMOUNT_CENTS / 100}`);
  }
  if (price.currency !== 'usd') problems.push(`currency is ${price.currency}, not usd`);
  if (price.recurring) problems.push('the Price is recurring; a refill must be one-time');
  if (problems.length) throw new PriceMismatchError('refill', problems.join('; '));

  priceChecked.set(priceId, Date.now());
  return priceId;
}
