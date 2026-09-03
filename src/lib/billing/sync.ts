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
    cancelAtPeriodEnd: isScheduledToEnd(sub),
    canceledAt: canceledAtOf(sub),
    endedAt: endedAtOf(sub),
    /*
     * Read for the INSERT path only. The UPDATE path must not touch this column
     * at all — see the onConflictDoUpdate below.
     */
    firstPaidAt: prior?.firstPaidAt ?? null,
    lastEventCreated: eventCreated ?? prior?.lastEventCreated ?? null,
    syncedAt: new Date(),
    raw: redact(sub),
  };

  /*
   * firstPaidAt is deliberately EXCLUDED from the update.
   *
   * Stripe delivers events in parallel, and on the first real purchase three
   * arrived at once. `invoice.paid` called markFirstPaid and set the column;
   * `checkout.session.completed` was already mid-flight with a `prior` it had
   * read moments earlier — before that write — and its upsert wrote the stale
   * null straight back over it.
   *
   * The consequence is not cosmetic. firstPaidAt gates the grace period, so a
   * customer who has genuinely paid would get NO grace window when a renewal
   * failed: locked out immediately instead of keeping access for 24 hours while
   * Stripe retries the card. That is a support ticket and a likely dispute from
   * someone who did nothing wrong.
   *
   * Leaving the column out of the update makes markFirstPaid its sole writer,
   * so no ordering of events can undo it. Re-reading and merging would not fix
   * it — the read and the write would still not be atomic.
   */
  const { firstPaidAt: _neverUpdated, ...updatable } = row;

  await db().insert(schema.subscriptions).values(row)
    .onConflictDoUpdate({
      target: schema.subscriptions.stripeSubscriptionId,
      set: updatable,
    });

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
  let revokedAt = current[0]?.revokedAt ?? null;
  let revokedReason = current[0]?.revokedReason ?? null;

  /*
   * A REFUND'S REVOCATION BELONGS TO THE SUBSCRIPTION THAT WAS REFUNDED.
   *
   * When the customer later buys again -- a subscription that began after the
   * refund and is live -- the old refund has nothing to say about the new
   * purchase, and carrying it forward did two things at once: the fresh trial
   * showed as "No active plan" with every download refused, and, because the
   * checkout guard reads this same row and saw it revoked, a second trial
   * could be started on top of the first. A refund of the CURRENT
   * subscription's charge still sticks: that subscription began before the
   * refund. A dispute or a fraud warning is different in kind and is never
   * cleared here, whatever is bought in the meantime -- only restoreEntitlement
   * lifts those.
   */
  const live = !!governing && ['trialing', 'active', 'past_due'].includes(governing.status);
  const startedAfterRefund = !!source?.currentPeriodStart && !!revokedAt
    && source.currentPeriodStart.getTime() > revokedAt.getTime();
  if (revokedAt && revokedReason === 'refund' && live && startedAfterRefund) {
    revokedAt = null;
    revokedReason = null;
  }

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

/** Reasons that outrank a plain refund: never overwritten by one. */
const STICKY_REVOKES = new Set(['dispute', 'early_fraud_warning']);

/**
 * Revoke immediately — a dispute, a fraud warning or a full refund. Survives
 * later resyncs. `at` is the event's own time, so a webhook delivered late
 * cannot revoke a subscription bought after the refund it describes. A refund
 * arriving after a dispute or fraud warning (the fraud handler's own refund
 * does exactly that) keeps the stronger reason.
 */
export async function revokeEntitlement(userId: string, reason: string, at: Date = new Date()): Promise<void> {
  const current = await db().select({ reason: schema.entitlements.revokedReason })
    .from(schema.entitlements).where(eq(schema.entitlements.userId, userId)).limit(1);
  const standing = current[0]?.reason ?? null;
  if (standing && STICKY_REVOKES.has(standing) && !STICKY_REVOKES.has(reason)) return;

  await db().insert(schema.entitlements)
    .values({
      userId,
      state: 'revoked',
      accessUntil: new Date(0),
      revokedAt: at,
      revokedReason: reason,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.entitlements.userId,
      set: {
        state: 'revoked',
        accessUntil: new Date(0),
        revokedAt: at,
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

/**
 * Is this subscription scheduled to stop?
 *
 * `cancel_at_period_end` ALONE IS NO LONGER THE ANSWER. On recent API versions
 * Stripe records a cancel-at-period-end as `cancel_at: <period end>` with the
 * boolean left FALSE and the intent in `cancellation_details`. Reading only the
 * boolean therefore reports a cancelled subscription as renewing — which is what
 * the account page told a real customer after a real cancellation.
 *
 * The consequence is customer-facing and bad: someone who has just cancelled is
 * shown "renews on the 8th". They either cancel again, or they call their bank,
 * and both of those are worse than the support email.
 *
 * `ended_at` is checked because a subscription that has already stopped is not
 * "scheduled to" stop — it is done, and `status` covers it.
 */
/**
 * Strip personal data out of the Stripe object before storing it.
 *
 * The full Subscription carries `default_payment_method.billing_details` —
 * cardholder name, email, phone and postal code. None of it was ever read: this
 * column has no reader anywhere in the codebase, it exists so a webhook problem
 * can be diagnosed after the fact. Keeping identity data indefinitely for a use
 * that never happens is the exact thing data minimisation is about, and the
 * privacy policy does not disclose collecting a name or a postal code — so the
 * choice is to disclose it or to stop doing it, and stopping is better.
 *
 * What stays is the shape of the subscription: statuses, ids, dates, the price.
 * That is what makes a bad sync legible, and none of it identifies anyone on its
 * own.
 */
function redact(sub: Stripe.Subscription): Record<string, unknown> {
  const raw = JSON.parse(JSON.stringify(sub)) as Record<string, unknown>;

  const pm = raw.default_payment_method as Record<string, unknown> | null | undefined;
  if (pm && typeof pm === 'object') {
    delete pm.billing_details;
    // The card's own fields — brand, last4, funding, country — are disclosed and
    // useful. `fingerprint` is not disclosed and identifies a card across
    // customers, so it goes.
    const card = pm.card as Record<string, unknown> | undefined;
    if (card) delete card.fingerprint;
  }
  delete raw.customer_details;

  return raw;
}

export function isScheduledToEnd(sub: Stripe.Subscription): boolean {
  if (sub.ended_at) return false;
  if (sub.cancel_at_period_end) return true;
  if (sub.cancel_at) return true;
  return sub.cancellation_details?.reason === 'cancellation_requested';
}

/**
 * Record that money actually arrived. Gates the grace period.
 *
 * WHY IT MAY HAVE TO CREATE THE ROW FIRST
 * Stripe sends invoice.paid and customer.subscription.created in the same
 * second, and the webhook handles them concurrently. On a real purchase the
 * payment landed before the subscription row existed: the UPDATE matched
 * nothing, the row was inserted a moment later with first_paid_at null, and
 * the sync's update path never touches that column (on purpose -- see the
 * upsert). So a paying customer had no first payment on record, which is the
 * fact that gates the grace period. If the update matches no row, the row is
 * synced into existence and the stamp is applied again.
 */
export async function markFirstPaid(subscriptionId: string, at: Date): Promise<void> {
  const stamp = () => db().update(schema.subscriptions)
    .set({ firstPaidAt: at })
    .where(and(
      eq(schema.subscriptions.stripeSubscriptionId, subscriptionId),
      sql`${schema.subscriptions.firstPaidAt} is null`,
    ))
    .returning({ id: schema.subscriptions.stripeSubscriptionId });

  if ((await stamp()).length) return;
  const exists = await db().select({ id: schema.subscriptions.stripeSubscriptionId })
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.stripeSubscriptionId, subscriptionId)).limit(1);
  if (exists.length) return; // already stamped by an earlier payment
  await syncSubscription(subscriptionId, at);
  await stamp();
}

/**
 * Find the user a Stripe object belongs to.
 *
 * THREE independent routes, deliberately.
 *
 * `metadata.user_id` is copied onto the Subscription at checkout, so events are
 * self-describing whatever order they arrive in. The customer lookup covers
 * anything created outside that flow, such as a plan started from the Stripe
 * dashboard.
 *
 * The third exists because anonymous checkout broke the first two. When nobody
 * is signed in there is no user_id to copy and no Customer of ours to match, so
 * a `customer.subscription.created` arriving before `checkout.session.completed`
 * resolved to nothing and the entitlement was silently never written — the exact
 * ordering independence the rest of this file is built to guarantee. The pending
 * checkout id is carried in the same metadata and survives that gap.
 */
async function resolveUserId(sub: Stripe.Subscription): Promise<string | null> {
  const fromMetadata = sub.metadata?.user_id;
  if (fromMetadata) return fromMetadata;

  const pendingId = sub.metadata?.pending_checkout_id;
  if (pendingId) {
    const rows = await db().select({ userId: schema.pendingCheckouts.userId })
      .from(schema.pendingCheckouts)
      .where(eq(schema.pendingCheckouts.id, pendingId)).limit(1);
    if (rows[0]?.userId) return rows[0].userId;
  }

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
