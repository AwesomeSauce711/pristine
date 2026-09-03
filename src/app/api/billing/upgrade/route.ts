import { and, eq, inArray } from 'drizzle-orm';
import type Stripe from 'stripe';
import { db, schema } from '@/db';
import { currentUser } from '@/lib/auth';
import { PriceMismatchError, planForPriceId, stripe, verifiedPriceIdForPlan } from '@/lib/billing/stripe';
import { syncSubscription } from '@/lib/billing/sync';
import { methodStatus, sellingIsOpen } from '@/lib/method-status';
import { PLANS, PLAN_ORDER, money, type PlanId } from '@/lib/plans';
import { limit, requestIp, tooMany } from '@/lib/ratelimit';

/*
 * POST /api/billing/upgrade { plan }
 *
 * Moves the caller's live subscription to a bigger plan, now.
 *
 * WHY THIS IS NOT A CHECKOUT. A subscriber cannot buy a second subscription
 * (checkout refuses one), and the right way to a bigger plan is to change
 * the one they have: Stripe swaps the price on the existing subscription,
 * starts a fresh period today, invoices the new price at once and credits
 * the unused part of the old period against it. One subscription, one
 * charge, no overlap. If the card declines, nothing changes.
 *
 * A trial ends when it is upgraded: the bigger plan is paid for from today.
 * Otherwise a seven-day trial of the smallest plan could be traded up to
 * the largest allowance for nothing.
 *
 * Downgrades are not offered here. Someone who wants less next period
 * cancels and re-subscribes, or asks; a downgrade with a credit and a
 * shortened allowance is a support conversation, not a button.
 */
async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function upgradeDisclosure(from: PlanId, to: PlanId, trialing: boolean): string {
  const a = PLANS[from];
  const b = PLANS[to];
  const ending = trialing
    ? 'Your free trial ends now. '
    : `What is left of your ${a.name} period is credited against it. `;
  return `Switching from ${a.name} to ${b.name}: ${money(b.amount)} is charged today. ${ending}`
    + `Then ${money(b.amount)} every ${b.interval} until you cancel. Cancel any time from Account.`;
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) {
    return Response.json({ code: 'sign_in_required', message: 'Please sign in first.' }, { status: 401 });
  }

  const rate = await limit(`upgrade:user:${user.id}`, 5, 3600);
  if (!rate.ok) return tooMany(rate);
  const once = await limit(`upgrade:once:${user.id}`, 1, 10);
  if (!once.ok) return tooMany(once);

  let body: { plan?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ code: 'bad_request' }, { status: 400 });
  }
  const to = body.plan as PlanId;
  if (!to || !(to in PLANS)) return Response.json({ code: 'unknown_plan' }, { status: 400 });

  /* The same switch that pauses new subscriptions pauses bigger ones. */
  if (!(await sellingIsOpen())) {
    const { note } = await methodStatus();
    return Response.json({
      code: 'selling_paused',
      message: note ?? 'Plan changes are paused for the moment while we check a possible problem. Please try again shortly.',
    }, { status: 503 });
  }

  const live = await db().select().from(schema.subscriptions)
    .where(and(
      eq(schema.subscriptions.userId, user.id),
      inArray(schema.subscriptions.status, ['trialing', 'active', 'past_due']),
    ))
    .limit(1);
  const sub = live[0];
  if (!sub) {
    return Response.json(
      { code: 'no_plan', message: 'There is no plan to upgrade. Choose a plan first.' },
      { status: 409 },
    );
  }
  const from = planForPriceId(sub.priceId);
  if (!from) {
    return Response.json(
      { code: 'unknown_current_plan', message: 'Your current plan could not be identified. Please contact support.' },
      { status: 409 },
    );
  }
  if (PLAN_ORDER.indexOf(to) <= PLAN_ORDER.indexOf(from)) {
    return Response.json(
      { code: 'not_an_upgrade', message: `${PLANS[to].name} is not a bigger plan than ${PLANS[from].name}.` },
      { status: 400 },
    );
  }
  if (sub.status === 'past_due') {
    return Response.json(
      { code: 'payment_failed', message: 'Your last payment failed. Update your card first, then upgrade.' },
      { status: 409 },
    );
  }

  let priceId: string;
  try {
    priceId = await verifiedPriceIdForPlan(to);
  } catch (e) {
    if (e instanceof PriceMismatchError) {
      console.error(`[upgrade] REFUSED: ${e.message}`);
      return Response.json({
        code: 'price_mismatch',
        message: 'Plan changes are paused for a moment while we correct a pricing setting. Nothing has been charged.',
      }, { status: 503 });
    }
    throw e;
  }

  const trialing = sub.status === 'trialing';
  const text = upgradeDisclosure(from, to, trialing);

  /* The record of what was agreed to, written before the change is made,
   * the same way checkout records its disclosure. */
  await db().insert(schema.consents).values({
    userId: user.id,
    kind: 'plan_change',
    priceId,
    disclosureText: text,
    disclosureSha256: await sha256Hex(text),
    amountCents: PLANS[to].amount,
    interval: PLANS[to].interval,
    firstChargeAt: new Date(),
    checkboxChecked: true,
    ip: requestIp(req.headers) ?? '0.0.0.0',
    userAgent: req.headers.get('user-agent')?.slice(0, 500) ?? 'unknown',
    pageUrl: req.headers.get('referer') ?? `/pricing`,
  });

  let current: Stripe.Subscription;
  try {
    current = await stripe().subscriptions.retrieve(sub.stripeSubscriptionId);
  } catch (e) {
    console.error('[upgrade] could not read the subscription', e);
    return Response.json({ code: 'internal', message: 'The plan could not be changed just now. Nothing has been charged.' }, { status: 500 });
  }
  const item = current.items.data[0];
  if (!item) {
    return Response.json({ code: 'internal', message: 'The plan could not be changed just now. Nothing has been charged.' }, { status: 500 });
  }

  try {
    await stripe().subscriptions.update(sub.stripeSubscriptionId, {
      items: [{ id: item.id, price: priceId }],
      /* A fresh period from today, invoiced now, the old period's remainder
       * credited. `error_if_incomplete`: if the charge fails, the change is
       * not made -- there is no half-upgraded state to untangle. */
      proration_behavior: 'always_invoice',
      payment_behavior: 'error_if_incomplete',
      ...(trialing ? { trial_end: 'now' as const } : { billing_cycle_anchor: 'now' as const }),
      metadata: { ...(current.metadata ?? {}), plan: to, upgraded_from: from, user_id: user.id },
    }, { idempotencyKey: `upgrade:${sub.stripeSubscriptionId}:${to}:${Math.floor(Date.now() / 60_000)}` });
  } catch (e) {
    const err = e as { code?: string; decline_code?: string; message?: string };
    console.error('[upgrade] Stripe refused the change', err.code ?? err.message);
    if (err.code === 'card_declined' || err.code === 'card_error' || err.decline_code) {
      return Response.json(
        { code: 'card_declined', message: 'Your card was declined, so the plan was not changed. Update your card from Account and try again.' },
        { status: 402 },
      );
    }
    return Response.json(
      { code: 'internal', message: 'The plan could not be changed just now. Nothing has been charged.' },
      { status: 500 },
    );
  }

  /* The webhook will say the same shortly; saying it now means the account
   * page the customer lands on already shows the new plan. */
  try {
    await syncSubscription(sub.stripeSubscriptionId, new Date());
  } catch (e) {
    console.error('[upgrade] sync after the change failed (the webhook will retry)', e);
  }

  return Response.json({ ok: true, plan: to, from });
}
