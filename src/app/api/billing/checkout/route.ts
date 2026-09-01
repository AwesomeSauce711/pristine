import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';
import { currentUser } from '@/lib/auth';
import { priceIdForPlan, stripe } from '@/lib/billing/stripe';
import { methodStatus, sellingIsOpen } from '@/lib/method-status';
import { PLANS, disclosure, type PlanId } from '@/lib/plans';

/*
 * POST /api/billing/checkout — start a Stripe Checkout session.
 *
 * Two things here are load-bearing beyond "take the money".
 *
 * 1. THE STRIPE CUSTOMER IS CREATED BEFORE CHECKOUT, and `user_id` is written
 *    into `subscription_data.metadata`. Together these dissolve the classic
 *    webhook ordering race rather than working around it: only
 *    `checkout.session.completed` carries `client_reference_id`, so if the
 *    customer were created during checkout, a `customer.subscription.created`
 *    arriving first would describe a subscription we cannot map to a user.
 *    With both in place, every subscription event is self-describing.
 *
 * 2. THE DISCLOSURE IS RECORDED VERBATIM before the session is created. US
 *    ROSCA and state automatic-renewal laws require the price, frequency,
 *    first-charge date and cancellation method to be shown clearly before
 *    billing details are taken. The stored row — with its hash, IP, user agent
 *    and timestamp — is the evidence that they were, in a chargeback and in a
 *    regulatory inquiry. It is written first so that a session can never exist
 *    without one.
 */

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) {
    return Response.json({ code: 'not_signed_in', message: 'Sign in first.' }, { status: 401 });
  }

  let body: { plan?: string; consented?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json({ code: 'bad_request' }, { status: 400 });
  }

  /*
   * The kill switch, enforced where the money is.
   *
   * Existing subscribers are untouched — /api/patch does not consult this, so
   * anyone who already paid keeps working. What stops is taking NEW money for
   * something that may not work, which is the part that turns into refunds and
   * disputes. Checked server-side because the banner is only a banner.
   */
  if (!(await sellingIsOpen())) {
    const { status, note } = await methodStatus();
    return Response.json({
      code: 'selling_paused',
      message: note ?? (status === 'broken'
        ? 'The method is not working right now, so we have stopped selling subscriptions. '
          + 'Please check back — we would rather lose the sale than take your money for something broken.'
        : 'We are checking a possible problem and have paused new subscriptions for the moment. '
          + 'Please try again shortly.'),
    }, { status: 503 });
  }

  const planId = body.plan as PlanId;
  if (!planId || !(planId in PLANS)) {
    return Response.json({ code: 'unknown_plan' }, { status: 400 });
  }
  const plan = PLANS[planId];

  /*
   * The consent checkbox is not decoration. A pre-checked box is prohibited
   * under California's ARL, and consent that was never affirmatively given is
   * the single most common finding in negative-option enforcement.
   */
  if (!body.consented) {
    return Response.json(
      { code: 'consent_required', message: 'Please confirm the subscription terms.' },
      { status: 400 },
    );
  }

  /* ---- refuse to sell someone a second subscription -------------------- */

  const existing = await db().select().from(schema.entitlements)
    .where(eq(schema.entitlements.userId, user.id)).limit(1);
  if (existing[0] && existing[0].accessUntil > new Date() && !existing[0].revokedAt) {
    return Response.json(
      { code: 'already_subscribed', message: 'You already have an active plan.' },
      { status: 409 },
    );
  }

  /* ---- ensure a Stripe customer, before checkout ----------------------- */

  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe().customers.create({
      email: user.email,
      metadata: { user_id: user.id },
    });
    customerId = customer.id;
    await db().update(schema.users)
      .set({ stripeCustomerId: customerId })
      .where(eq(schema.users.id, user.id));
  }

  /* ---- record consent -------------------------------------------------- */

  const firstChargeAt = new Date(Date.now() + plan.trialDays * 86_400_000);
  const text = disclosure(plan, firstChargeAt);
  const origin = new URL(req.url).origin;

  const consent = await db().insert(schema.consents).values({
    userId: user.id,
    kind: plan.trialDays > 0 ? 'trial_negative_option' : 'immediate_charge',
    priceId: priceIdForPlan(planId),
    disclosureText: text,
    disclosureSha256: await sha256Hex(text),
    amountCents: plan.amount,
    interval: plan.interval,
    firstChargeAt,
    checkboxChecked: true,
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '0.0.0.0',
    userAgent: req.headers.get('user-agent')?.slice(0, 500) ?? 'unknown',
    pageUrl: req.headers.get('referer') ?? `${origin}/pricing`,
  }).returning({ id: schema.consents.id });

  /* ---- the session ----------------------------------------------------- */

  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    client_reference_id: user.id,
    line_items: [{ price: priceIdForPlan(planId), quantity: 1 }],

    // Always take a card, including for trials. Stated on the page too.
    payment_method_collection: 'always',

    subscription_data: {
      ...(plan.trialDays > 0
        ? {
            trial_period_days: plan.trialDays,
            // No card by the end of the trial means it simply ends, rather
            // than leaving a subscription in limbo.
            trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
          }
        : {}),
      // Copied onto the Subscription itself, so every subscription event can be
      // resolved to a user without depending on the checkout event.
      metadata: { user_id: user.id, plan: planId, consent_id: consent[0].id },
    },

    /*
     * Off by default. A visible promo field on a trial checkout invites
     * coupon-hunting extensions and measurably depresses conversion; turn it on
     * per-campaign instead.
     */
    allow_promotion_codes: false,

    /*
     * Stripe Tax is opt-in here only because it must be enabled in the Stripe
     * dashboard first, and a session referencing it before then fails outright.
     * Turn it on: selling digital goods to consumers creates VAT/GST
     * obligations from the first sale, and retrofitting it is painful.
     */
    ...(process.env.STRIPE_AUTOMATIC_TAX === '1'
      ? { automatic_tax: { enabled: true }, customer_update: { address: 'auto', name: 'auto' } }
      : {}),

    custom_text: {
      submit: { message: text },
    },

    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    success_url: `${origin}/welcome?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/pricing?cancelled=1`,
  }, {
    // Same person, same plan, same consent → same session, even if they
    // double-click or the network retries.
    idempotencyKey: `checkout:${user.id}:${planId}:${consent[0].id}`,
  });

  return Response.json({ url: session.url });
}
