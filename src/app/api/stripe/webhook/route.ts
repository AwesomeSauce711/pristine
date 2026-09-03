import { and, eq, isNull, inArray } from 'drizzle-orm';
import type Stripe from 'stripe';
import { db, schema } from '@/db';
import { revokeAllSessions } from '@/lib/auth';
import { resolvePendingCheckout } from '@/lib/billing/claim';
import { saveEvidence } from '@/lib/billing/dispute-evidence';
import { stripe } from '@/lib/billing/stripe';
import {
  markFirstPaid, recomputeEntitlement, restoreEntitlement, revokeEntitlement,
  syncSubscription, userIdForCustomer,
} from '@/lib/billing/sync';

/*
 * POST /api/stripe/webhook — the only writer of billing state.
 *
 * THREE PROPERTIES THIS MUST HAVE, and none of them are optional:
 *
 * 1. AUTHENTIC. Verified against the raw body with the signing secret. Anything
 *    else is an endpoint that lets a stranger grant themselves a subscription.
 *
 * 2. IDEMPOTENT. Stripe retries for up to three days, and the same event will
 *    arrive more than once. The `stripe_events` table is the ledger: an insert
 *    that conflicts means we have seen it, and we stop.
 *
 * 3. ORDER-INDEPENDENT. Stripe guarantees no ordering. Handlers therefore
 *    re-fetch from the API rather than applying the event payload, so whichever
 *    runs last writes the freshest truth. See sync.ts.
 *
 * Returning non-2xx makes Stripe retry, which is what we want for a transient
 * failure and emphatically not what we want for an event we simply do not
 * handle — those are recorded as `ignored` and acknowledged.
 */

/** Handled here. Anything else is acknowledged and ignored. */
const HANDLED = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.trial_will_end',
  'invoice.paid',
  'invoice.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.closed',
  'radar.early_fraud_warning.created',
]);

export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[webhook] STRIPE_WEBHOOK_SECRET is not set');
    return new Response('not configured', { status: 500 });
  }

  const signature = req.headers.get('stripe-signature');
  if (!signature) return new Response('missing signature', { status: 400 });

  // Must be the RAW body — any parsing first will break verification.
  const raw = await req.text();

  let event: Stripe.Event;
  try {
    // The async form works in every runtime, including those without a
    // synchronous crypto implementation.
    event = await stripe().webhooks.constructEventAsync(raw, signature, secret);
  } catch (e) {
    console.error('[webhook] signature verification failed', e);
    return new Response('bad signature', { status: 400 });
  }

  /* ---- idempotency ------------------------------------------------------ */

  /* A test event on the live endpoint (or the reverse) is misconfiguration,
   * not traffic. Refuse it rather than write sandbox facts into live tables. */
  const liveKey = (process.env.STRIPE_SECRET_KEY ?? '').startsWith('sk_live_');
  if (event.livemode !== liveKey) {
    console.error(`[webhook] ${event.type} livemode=${event.livemode} does not match the configured key`);
    return new Response('mode mismatch', { status: 400 });
  }

  const inserted = await db().insert(schema.stripeEvents)
    .values({
      id: event.id,
      type: event.type,
      created: new Date(event.created * 1000),
      status: HANDLED.has(event.type) ? 'processing' : 'ignored',
      livemode: event.livemode,
    })
    .onConflictDoNothing()
    .returning({ id: schema.stripeEvents.id });

  if (!inserted.length) {
    /*
     * Already in the ledger — but "seen before" and "dealt with" are not the
     * same thing, and conflating them silently drops events.
     *
     * A handler that throws leaves the row `failed` and returns 500 so Stripe
     * retries. That retry carries the SAME event id, so it conflicts here. If
     * every conflict is answered "duplicate, thanks", the retry is acknowledged
     * without ever being processed and Stripe stops sending it — a subscription
     * that failed to activate because of a momentary database blip would then
     * stay inactive forever, with a paying customer locked out and nothing in
     * the logs after the first error.
     *
     * So a `failed` row is retaken. Anything else really is a duplicate.
     */
    const [prior] = await db().select().from(schema.stripeEvents)
      .where(eq(schema.stripeEvents.id, event.id)).limit(1);

    /*
     * Retake a failed row -- and a row stuck in 'processing': a crash or a
     * platform timeout mid-handler never reaches the catch below, and without
     * this every retry Stripe sends would be waved through as a duplicate.
     * Handlers re-fetch from Stripe and are idempotent, so retaking a
     * half-done one is safe.
     */
    const stuck = prior?.status === 'processing'
      && Date.now() - prior.receivedAt.getTime() > 10 * 60_000;
    if (prior?.status !== 'failed' && !stuck) {
      return Response.json({ received: true, duplicate: true });
    }

    await db().update(schema.stripeEvents)
      .set({ status: 'processing', attempts: prior.attempts + 1, error: null })
      .where(eq(schema.stripeEvents.id, event.id));
    console.warn(`[webhook] retaking ${event.type} (${event.id}), attempt ${prior.attempts + 2}`);
  }
  if (!HANDLED.has(event.type)) {
    return Response.json({ received: true, ignored: true });
  }

  /* ---- handle ----------------------------------------------------------- */

  try {
    await handle(event);
    await db().update(schema.stripeEvents)
      .set({ status: 'processed', processedAt: new Date() })
      .where(eq(schema.stripeEvents.id, event.id));
    return Response.json({ received: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[webhook] ${event.type} (${event.id}) failed:`, message);
    await db().update(schema.stripeEvents)
      .set({ status: 'failed', error: message.slice(0, 1000) })
      .where(eq(schema.stripeEvents.id, event.id));
    // 500 so Stripe retries; the ledger row is left `failed` and can be retaken.
    return new Response('handler failed', { status: 500 });
  }
}

async function handle(event: Stripe.Event): Promise<void> {
  const at = new Date(event.created * 1000);

  switch (event.type) {
    /*
     * Confirms the customer mapping and captures consent. NOT a source of
     * entitlement — the subscription events are, and they may well arrive
     * first.
     */
    case 'checkout.session.completed': {
      const s = event.data.object;

      /* A refill is a one-time payment, not a subscription; it has its own
       * ledger and nothing below applies to it. */
      if (s.mode === 'payment' && s.metadata?.kind === 'refill') {
        await recordRefill(s);
        return;
      }
      /*
       * client_reference_id is a user id ONLY for a signed-in checkout. An
       * anonymous one carries `pc_<pending id>`, which is not a user and is not
       * even a UUID — passing it to a uuid column throws a cast error and fails
       * the whole webhook, so it has to be filtered here rather than relied on.
       */
      const ref = s.client_reference_id;
      const userId = ref && !ref.startsWith('pc_') ? ref : null;
      const customerId = typeof s.customer === 'string' ? s.customer : s.customer?.id;

      if (userId && customerId) {
        await db().update(schema.users)
          .set({ stripeCustomerId: customerId })
          .where(and(eq(schema.users.id, userId), isNull(schema.users.stripeCustomerId)));
      }
      if (s.metadata?.consent_id && userId) {
        await db().update(schema.consents)
          .set({ userId })
          .where(eq(schema.consents.id, s.metadata.consent_id));
      }

      /*
       * ANONYMOUS CHECKOUT: this is where the account comes into existence.
       *
       * Authoritative on purpose — the webhook is the one path Stripe retries
       * for three days, so an account is created even if the buyer closes the
       * tab before returning. The claim on /welcome does the same work if it
       * gets there first; both are idempotent and the pending row arbitrates.
       *
       * The user is created but NEVER marked email-verified. Stripe collected
       * the address; nothing has proved anyone reads it.
       */
      const resolved = await resolvePendingCheckout(
        s.id,
        s.customer_details?.email,
        null,
      );
      const effectiveUserId = userId ?? resolved?.userId ?? null;

      /*
       * An anonymous checkout has no Customer of ours attached, so link the one
       * Stripe made. Without this, every later customer.* event for this buyer
       * resolves to nobody.
       */
      /* Only ever fills an empty slot: an account's Customer is never re-pointed
       * by a checkout that merely carried its email. */
      if (effectiveUserId && customerId) {
        await db().update(schema.users)
          .set({ stripeCustomerId: customerId })
          .where(and(eq(schema.users.id, effectiveUserId), isNull(schema.users.stripeCustomerId)));
      }

      const subId = typeof s.subscription === 'string' ? s.subscription : s.subscription?.id;
      if (subId) await syncSubscription(subId, at);
      if (subId && effectiveUserId) await recordTrialGrant(effectiveUserId, subId, s);
      return;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.trial_will_end': {
      await syncSubscription(event.data.object.id, at);
      return;
    }

    /* Money arrived. Records the card fingerprint and unlocks the grace tail. */
    case 'invoice.paid': {
      const inv = event.data.object;
      await upsertInvoice(inv);
      const subId = subscriptionIdOf(inv);
      if (subId) {
        /*
         * Only a real payment starts the grace clock.
         *
         * A trial's opening invoice is $0 and still arrives as invoice.paid. If
         * that sets first_paid_at, every trialing subscription earns the 72-hour
         * grace tail reserved for customers who have actually paid — which is
         * precisely the farming route the grace rule exists to close.
         */
        if ((inv.amount_paid ?? 0) > 0) {
          await markFirstPaid(subId, inv.status_transitions?.paid_at
            ? new Date(inv.status_transitions.paid_at * 1000) : at);
        }
        await syncSubscription(subId, at);
      }
      return;
    }

    /*
     * Does NOT revoke. Stripe is still retrying and the grace tail already
     * covers this window; cutting access at the first failed attempt turns a
     * recoverable card problem into a cancellation and often a dispute.
     */
    case 'invoice.payment_failed': {
      const inv = event.data.object;
      await upsertInvoice(inv);
      const subId = subscriptionIdOf(inv);
      if (subId) await syncSubscription(subId, at);
      return;
    }

    /*
     * A full refund of the current period ends access; a partial refund does
     * not, because the customer still holds a period they paid for.
     */
    case 'charge.refunded': {
      const charge = event.data.object;
      /* A refunded refill takes its allowance with it. Any refund, not only a
       * full one: it is 99 cents, and a partial refund of that is a mistake. */
      const pi = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
      let refillRows = 0;
      if (pi) {
        const revokedRefills = await db().update(schema.patchRefills)
          .set({ revokedAt: at })
          .where(and(eq(schema.patchRefills.stripePaymentIntentId, pi), isNull(schema.patchRefills.revokedAt)))
          .returning({ id: schema.patchRefills.id });
        refillRows = revokedRefills.length;
      }
      /*
       * A refunded 99-cent top-up is a refunded top-up, nothing more: its own
       * row is revoked above and the plan is untouched. The charge carries the
       * refill's metadata (copied from the PaymentIntent), and the ledger row
       * says the same thing.
       */
      const isRefill = charge.metadata?.kind === 'refill' || refillRows > 0;
      const customerId = typeof charge.customer === 'string' ? charge.customer : charge.customer?.id;
      const userId = customerId ? await userIdForCustomer(customerId) : null;

      if (charge.id) {
        await db().update(schema.invoices)
          .set({ amountRefundedCents: charge.amount_refunded })
          .where(eq(schema.invoices.stripeChargeId, charge.id));
      }
      if (!isRefill && userId && charge.amount_refunded >= charge.amount) {
        await revokeEntitlement(userId, 'refund', at);
      }
      return;
    }

    /*
     * Revoke immediately and sign them out everywhere. Someone who disputes a
     * charge should not keep using the product while the dispute runs, and a
     * disputer who resubscribes tends to dispute again.
     */
    case 'charge.dispute.created': {
      const d = event.data.object;
      const chargeId = typeof d.charge === 'string' ? d.charge : d.charge?.id;
      const userId = await userIdForCharge(chargeId);

      await db().insert(schema.disputes).values({
        stripeDisputeId: d.id,
        userId,
        stripeChargeId: chargeId ?? '',
        amountCents: d.amount,
        reason: d.reason ?? null,
        status: d.status,
        evidenceDueBy: d.evidence_details?.due_by
          ? new Date(d.evidence_details.due_by * 1000) : null,
        openedAt: at,
      }).onConflictDoNothing();

      /*
       * An inquiry ("warning_*") is the bank asking a question, not a
       * chargeback; the customer has taken nothing. Evidence is filed either
       * way, but access is pulled only for a real dispute.
       */
      const inquiry = d.status.startsWith('warning_');
      if (userId && !inquiry) {
        await revokeEntitlement(userId, 'dispute', at);
        await db().update(schema.users)
          .set({ blockedAt: new Date(), blockedReason: 'dispute' })
          .where(eq(schema.users.id, userId));
        await revokeAllSessions(userId);
      }

      /*
       * Assemble the response now, while the facts are to hand, and store it as
       * a DRAFT — not submitted. Stripe submits whatever draft exists when the
       * deadline arrives, so nothing is lost if nobody looks, but a human can
       * still add context until then. Submitting here would be final and would
       * throw that option away.
       *
       * Never allowed to fail the webhook: a 500 here makes Stripe retry the
       * whole event for three days, which would re-revoke and re-block on every
       * attempt.
       */
      try {
        const evidence = await saveEvidence(d.id);
        if (evidence?.gaps.length) {
          console.warn(
            `[dispute ${d.id}] evidence is thin: ${evidence.gaps.join(' | ')}`,
          );
        }
      } catch (e) {
        console.error(`[dispute ${d.id}] could not save evidence`, e);
      }
      return;
    }

    case 'charge.dispute.closed': {
      const d = event.data.object;
      const chargeId = typeof d.charge === 'string' ? d.charge : d.charge?.id;
      const userId = await userIdForCharge(chargeId);

      await db().update(schema.disputes)
        .set({ status: d.status, closedAt: at })
        .where(eq(schema.disputes.stripeDisputeId, d.id));

      // A win restores them, and so does an inquiry that closed without
      // becoming a dispute; a loss leaves the revocation standing.
      if (userId && (d.status === 'won' || d.status === 'warning_closed')) {
        await db().update(schema.users)
          .set({ blockedAt: null, blockedReason: null })
          .where(eq(schema.users.id, userId));
        await restoreEntitlement(userId);
      }
      return;
    }

    /*
     * An early fraud warning usually ripens into a dispute. A voluntary refund
     * now does not count against the dispute ratio; the dispute it becomes
     * would. Refunding proactively is cheaper than being right about it.
     */
    case 'radar.early_fraud_warning.created': {
      const w = event.data.object;
      const chargeId = typeof w.charge === 'string' ? w.charge : w.charge?.id;
      if (!chargeId) return;

      try {
        await stripe().refunds.create({ charge: chargeId, reason: 'fraudulent' });
      } catch (e) {
        console.error('[webhook] proactive refund failed', e);
      }
      const userId = await userIdForCharge(chargeId);
      if (userId) {
        await revokeEntitlement(userId, 'early_fraud_warning', at);
        await db().update(schema.users)
          .set({ blockedAt: new Date(), blockedReason: 'early_fraud_warning' })
          .where(eq(schema.users.id, userId));
        await revokeAllSessions(userId);
        /* Leaving the subscription running invites the dispute the warning
         * predicts. Ending it is the refund's natural companion. */
        const live = await db().select({ id: schema.subscriptions.stripeSubscriptionId })
          .from(schema.subscriptions)
          .where(and(
            eq(schema.subscriptions.userId, userId),
            inArray(schema.subscriptions.status, ['trialing', 'active', 'past_due']),
          ));
        for (const sub of live) {
          try {
            await stripe().subscriptions.cancel(sub.id);
          } catch (e) {
            console.error(`[webhook] could not cancel ${sub.id} after a fraud warning`, e);
          }
        }
      }
      return;
    }

    default:
      return;
  }
}

/* ------------------------------------------------------------------ utils */

/**
 * The subscription an invoice belongs to.
 *
 * Isolated because this has moved around between API versions — on current
 * versions it hangs off the invoice's parent details rather than sitting at the
 * top level, and reading the wrong place silently yields null, which would mean
 * `firstPaidAt` never gets set and nobody ever receives a grace period.
 */
function subscriptionIdOf(inv: Stripe.Invoice): string | null {
  const parent = (inv as unknown as {
    parent?: { subscription_details?: { subscription?: string | { id: string } } };
  }).parent;
  const fromParent = parent?.subscription_details?.subscription;
  if (fromParent) return typeof fromParent === 'string' ? fromParent : fromParent.id;

  const legacy = (inv as unknown as { subscription?: string | { id: string } }).subscription;
  if (legacy) return typeof legacy === 'string' ? legacy : legacy.id;

  return null;
}

/*
 * The user behind a charge. The invoices ledger answers when the charge id
 * was recorded with the invoice; current API versions no longer put the
 * charge on the invoice object, so that column is often empty, and a
 * dispute that could not find its customer would revoke nobody. So the
 * charge itself is asked next: its Customer is ours (set on every account
 * before its first checkout), and a refill charge names its user in
 * metadata. Every path here is a lookup by an id Stripe gave us.
 */
async function userIdForCharge(chargeId: string | undefined): Promise<string | null> {
  if (!chargeId) return null;
  const rows = await db().select({ userId: schema.invoices.userId })
    .from(schema.invoices)
    .where(eq(schema.invoices.stripeChargeId, chargeId)).limit(1);
  if (rows[0]?.userId) return rows[0].userId;

  try {
    const charge = await stripe().charges.retrieve(chargeId);
    const customerId = typeof charge.customer === 'string' ? charge.customer : charge.customer?.id;
    if (customerId) {
      const byCustomer = await userIdForCustomer(customerId);
      if (byCustomer) return byCustomer;
    }
    const pi = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
    if (pi) {
      const refill = await db().select({ userId: schema.patchRefills.userId })
        .from(schema.patchRefills)
        .where(eq(schema.patchRefills.stripePaymentIntentId, pi)).limit(1);
      if (refill[0]?.userId) return refill[0].userId;
    }
    const metaUser = charge.metadata?.user_id;
    if (metaUser) {
      const u = await db().select({ id: schema.users.id }).from(schema.users)
        .where(eq(schema.users.id, metaUser)).limit(1);
      if (u[0]) return u[0].id;
    }
  } catch (e) {
    console.error(`[webhook] could not resolve charge ${chargeId} to a user`, e);
  }
  return null;
}

/**
 * The user a subscription belongs to, from our own row. The fallback for an
 * invoice whose customer is not yet linked to an account -- which is what an
 * anonymous checkout looked like in the second the payment landed, and why two
 * real invoices were stored with no user.
 */
async function userIdForSubscription(subId: string | null): Promise<string | null> {
  if (!subId) return null;
  const rows = await db().select({ userId: schema.subscriptions.userId })
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.stripeSubscriptionId, subId)).limit(1);
  return rows[0]?.userId ?? null;
}

/**
 * A paid refill session becomes one ledger row. Idempotent on the session id:
 * Stripe retries, and a retry must not sell the same refill twice.
 */
async function recordRefill(s: Stripe.Checkout.Session): Promise<void> {
  if (s.payment_status !== 'paid') return;
  const ref = s.client_reference_id;
  const userId = (ref && !ref.startsWith('pc_') ? ref : null) ?? s.metadata?.user_id ?? null;
  if (!userId) return;
  const count = Math.max(1, Math.min(50, Number.parseInt(s.metadata?.count ?? '1', 10) || 1));
  const pi = typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id ?? null;
  await db().insert(schema.patchRefills).values({
    userId,
    count,
    amountCents: s.amount_total ?? 0,
    stripeSessionId: s.id,
    stripePaymentIntentId: pi,
  }).onConflictDoNothing();
}

async function upsertInvoice(inv: Stripe.Invoice): Promise<void> {
  const customerId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
  const userId = (customerId ? await userIdForCustomer(customerId) : null)
    ?? await userIdForSubscription(subscriptionIdOf(inv));
  /* Older API versions put the charge on the invoice; current ones list it
   * under payments. Take whichever is present. */
  const legacyCharge = (inv as unknown as { charge?: string | { id: string } }).charge;
  const payments = (inv as unknown as {
    payments?: { data?: Array<{ payment?: { charge?: string | { id: string } | null } }> };
  }).payments;
  const chargeId = legacyCharge ?? payments?.data?.[0]?.payment?.charge ?? null;

  const row = {
    stripeInvoiceId: inv.id!,
    userId,
    stripeSubscriptionId: subscriptionIdOf(inv),
    stripeChargeId: chargeId ? (typeof chargeId === 'string' ? chargeId : chargeId.id) : null,
    status: inv.status ?? 'unknown',
    billingReason: inv.billing_reason ?? null,
    amountDueCents: inv.amount_due,
    amountPaidCents: inv.amount_paid,
    currency: inv.currency,
    paidAt: inv.status_transitions?.paid_at
      ? new Date(inv.status_transitions.paid_at * 1000) : null,
    attemptCount: inv.attempt_count ?? null,
    nextPaymentAttempt: inv.next_payment_attempt
      ? new Date(inv.next_payment_attempt * 1000) : null,
    hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
    syncedAt: new Date(),
  };

  await db().insert(schema.invoices).values(row)
    .onConflictDoUpdate({ target: schema.invoices.stripeInvoiceId, set: row });

  if (userId) await recomputeEntitlement(userId);
}

/*
 * recordTrialGrant — the ledger behind "one free trial per person".
 *
 * WHY HERE AND NOT invoice.paid
 * A trial's opening invoice is $0, so it has no charge and no
 * payment_method_details — there is nothing to read a card fingerprint from.
 * The fingerprint only exists on the PaymentMethod itself, which this event can
 * reach through the session's SetupIntent or the subscription's default.
 *
 * WHY THE UNIQUE INDEX IS THE ENFORCEMENT POINT
 * Checking for an existing row and then inserting is a race: two checkouts a
 * millisecond apart both read "no grant" and both insert. Letting
 * trial_one_per_card reject the second insert makes the database the arbiter,
 * which is the only place the decision can be made atomically.
 *
 * WHY A DUPLICATE DOES NOT BLOCK THE CHECKOUT
 * By the time this runs the customer has already completed checkout. Revoking
 * access here would be a surprise cancellation after payment details were taken
 * — the exact pattern that generates disputes. The row is the evidence; the
 * enforcement it feeds is the decision to offer a trial NEXT time.
 *
 * WALLETS FAIL OPEN, DELIBERATELY
 * A Link or bank-funded PaymentMethod exposes no card fingerprint at all, so
 * cardFingerprint is NULL. Postgres treats NULLs as distinct under a unique
 * index, so trial_one_per_card permits unlimited NULL rows and is a no-op for
 * those customers. That is the intended behaviour — a wallet user is
 * indistinguishable from an evader and blocking them costs real conversion —
 * and it is why the trial QUOTA, which needs no fingerprint, is the control that
 * actually bounds the loss. Recorded rather than assumed: pmType says why.
 */
async function recordTrialGrant(
  userId: string,
  subId: string,
  session: Stripe.Checkout.Session,
): Promise<void> {
  try {
    const sub = await stripe().subscriptions.retrieve(subId, {
      expand: ['default_payment_method'],
    });
    // Only a subscription that actually started a trial consumes the offer.
    if (!sub.trial_end) return;

    let pm = typeof sub.default_payment_method === 'object' ? sub.default_payment_method : null;
    if (!pm && session.setup_intent) {
      const si = await stripe().setupIntents.retrieve(
        typeof session.setup_intent === 'string' ? session.setup_intent : session.setup_intent.id,
        { expand: ['payment_method'] },
      );
      pm = typeof si.payment_method === 'object' ? si.payment_method : null;
    }

    const fingerprint = pm?.card?.fingerprint ?? null;
    const email = session.customer_details?.email ?? '';
    const emailDomain = email.includes('@') ? email.split('@').pop()!.toLowerCase() : 'unknown';

    await db().insert(schema.trialGrants).values({
      userId,
      stripeSubscriptionId: subId,
      cardFingerprint: fingerprint,
      emailDomain,
      pmType: pm?.type ?? 'unknown',
    }).onConflictDoNothing();
  } catch (e) {
    // A missing ledger row must never cost the customer their subscription.
    console.error('[webhook] could not record trial grant', e);
  }
}
