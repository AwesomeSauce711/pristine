import 'server-only';

import { and, desc, eq, sql } from 'drizzle-orm';
import type Stripe from 'stripe';
import { db, schema } from '@/db';
import { PLANS } from '@/lib/plans';
import {
  computeEntitlement, governingSubscription, type SubscriptionFacts,
} from './entitlement';
import {
  canceledAtOf, endedAtOf, periodOf, planForPriceId, priceIdOf, stripe,
  trialEndOf, trialStartOf,
} from './stripe';

/*
 * sync.ts — bring one subscription up to date, then recompute access.
 *
 * THE RULE THAT MAKES WEBHOOK ORDERING IRRELEVANT
 * A webhook is treated as a SIGNAL TO RE-FETCH, never as state to apply. Stripe
 * makes no ordering guarantee and retries for up to three days, so applying
 * event payloads directly means a delayed `customer.subscription.updated` can
 * overwrite newer truth with older truth.
 *
 * Re-fetching removes the problem rather than handling it: whichever handler
 * runs last writes the freshest state from the API, so any arrival order
 * converges on the same answer. The `lastEventCreated` guard is a second belt
 * for the case where two handlers race and the older one wins the write.
 */

/**
 * Re-fetch a subscription from Stripe and update everything derived from it.
 *
 * `eventCreated` is the `created` timestamp of the event that triggered this,
 * when there was one. A manual sync passes nothing.
 */
export async function syncSubscription(
  subscriptionId: string,
  eventCreated?: Date,
): Promise<void> {
  const sub = await stripe().subscriptions.retrieve(subscriptionId, {
    expand: ['items.data.price', 'default_payment_method'],
  });

  const userId = await resolveUserId(sub);
  if (!userId) {
    // Nothing to attach this to. Worth shouting about: it means a customer was
    // created outside our signup flow, or metadata was lost.
    console.error(`[billing] no user for subscription ${sub.id} (customer ${String(sub.customer)})`);
    return;
  }

  const { start, end } = periodOf(sub);
  const priceId = priceIdOf(sub);
  const tier = planForPriceId(priceId);

  const existing = await db().select().from(schema.subscriptions)
    .where(eq(schema.subscriptions.stripeSubscriptionId, sub.id)).limit(1);
  const prior = existing[0];

  /*
   * Ignore an event older than what we have already applied. Without this, a
   * retry of a three-day-old `updated` could resurrect a cancelled plan.
   */
  if (eventCreated && prior?.lastEventCreated && prior.lastEventCreated > eventCreated) {
    return;
  }

  const row = {
    stripeSubscriptionId: sub.id,
    userId,
    stripeCustomerId: String(sub.customer),
    priceId: priceId ?? '',
    status: sub.status,
    currentPeriodStart: start,
    currentPeriodEnd: end,
    trialStart: trialStartOf(sub),
    trialEnd: trialEndOf(sub),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    canceledAt: canceledAtOf(sub),
    endedAt: endedAtOf(sub),
    // Never unset once set: it records that money has actually changed hands.
    firstPaidAt: prior?.firstPaidAt ?? null,
    lastEventCreated: eventCreated ?? prior?.lastEventCreated ?? null,
    syncedAt: new Date(),
    raw: sub as unknown as Record<string, unknown>,
  };

  await db().insert(schema.subscriptions).values(row)
    .onConflictDoUpdate({ target: schema.subscriptions.stripeSubscriptionId, set: row });

  await recomputeEntitlement(userId);
  void tier;
}

/**
 * Rebuild a user's entitlement row from every subscription we hold for them.
 *
 * Always derived from the full set rather than patched in place, so a user with
 * an old cancelled plan and a new active one cannot end up with the wrong one
 * governing.
 */
export async function recomputeEntitlement(userId: string): Promise<void> {
  const rows = await db().select().from(schema.subscriptions)
    .where(eq(schema.subscriptions.userId, userId))
    .orderBy(desc(schema.subscriptions.syncedAt));

  const facts: SubscriptionFacts[] = rows.map((r) => ({
    status: r.status as Stripe.Subscription.Status,
    currentPeriodStart: r.currentPeriodStart,
    currentPeriodEnd: r.currentPeriodEnd,
    trialEnd: r.trialEnd,
    cancelAtPeriodEnd: r.cancelAtPeriodEnd,
    endedAt: r.endedAt,
    firstPaidAt: r.firstPaidAt,
    tier: planForPriceId(r.priceId),
  }));

  const governing = governingSubscription(facts);
  const computed = computeEntitlement(governing);
  const source = governing ? rows[facts.indexOf(governing)] : null;

  /*
   * A revocation from a dispute or refund outranks anything the subscription
   * window says, and must survive a later resync. It is cleared only
   * deliberately, by `restoreEntitlement`.
   */
  const current = await db().select().from(schema.entitlements)
    .where(eq(schema.entitlements.userId, userId)).limit(1);
  const revokedAt = current[0]?.revokedAt ?? null;
  const revokedReason = current[0]?.revokedReason ?? null;

  const value = {
    userId,
    state: revokedAt ? ('revoked' as const) : computed.state,
    accessUntil: computed.accessUntil,
    sourceSubscriptionId: source?.stripeSubscriptionId ?? null,
    priceId: source?.priceId ?? null,
    tier: computed.tier,
    inTrial: computed.inTrial,
    cancelAtPeriodEnd: computed.cancelAtPeriodEnd,
    periodStartedAt: computed.periodStartedAt,
    dailyPatchCap: computed.dailyPatchCap,
    periodPatchCap: computed.periodPatchCap,
    revokedAt,
    revokedReason,
    updatedAt: new Date(),
  };

  await db().insert(schema.entitlements).values(value)
    .onConflictDoUpdate({ target: schema.entitlements.userId, set: value });
}

/** Revoke immediately — a dispute or a full refund. Survives later resyncs. */
export async function revokeEntitlement(userId: string, reason: string): Promise<void> {
  await db().insert(schema.entitlements)
    .values({
      userId,
      state: 'revoked',
      accessUntil: new Date(0),
      revokedAt: new Date(),
      revokedReason: reason,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.entitlements.userId,
      set: {
        state: 'revoked',
        accessUntil: new Date(0),
        revokedAt: new Date(),
        revokedReason: reason,
        updatedAt: new Date(),
      },
    });
}

/** Undo a revocation — a dispute won. */
export async function restoreEntitlement(userId: string): Promise<void> {
  await db().update(schema.entitlements)
    .set({ revokedAt: null, revokedReason: null, updatedAt: new Date() })
    .where(eq(schema.entitlements.userId, userId));
  await recomputeEntitlement(userId);
}

/** Record that money actually arrived. Gates the grace period. */
export async function markFirstPaid(subscriptionId: string, at: Date): Promise<void> {
  await db().update(schema.subscriptions)
    .set({ firstPaidAt: at })
    .where(and(
      eq(schema.subscriptions.stripeSubscriptionId, subscriptionId),
      sql`${schema.subscriptions.firstPaidAt} is null`,
    ));
}

/**
 * Find the user a Stripe object belongs to.
 *
 * Two independent routes, deliberately. `metadata.user_id` is copied onto the
 * Subscription at checkout, so subscription events are self-describing whatever
 * order they arrive in; the customer lookup covers anything created outside
 * that flow, such as a plan started from the Stripe dashboard.
 */
async function resolveUserId(sub: Stripe.Subscription): Promise<string | null> {
  const fromMetadata = sub.metadata?.user_id;
  if (fromMetadata) return fromMetadata;

  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  if (!customerId) return null;

  const rows = await db().select({ id: schema.users.id }).from(schema.users)
    .where(eq(schema.users.stripeCustomerId, customerId)).limit(1);
  return rows[0]?.id ?? null;
}

export async function userIdForCustomer(customerId: string): Promise<string | null> {
  const rows = await db().select({ id: schema.users.id }).from(schema.users)
    .where(eq(schema.users.stripeCustomerId, customerId)).limit(1);
  return rows[0]?.id ?? null;
}

export { PLANS };
