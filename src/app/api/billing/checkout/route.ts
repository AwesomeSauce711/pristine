import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';
import { siteOrigin } from '@/lib/origin';
import { currentUser } from '@/lib/auth';
import { PriceMismatchError, stripe, verifiedPriceIdForPlan } from '@/lib/billing/stripe';
import { CLAIM_COOKIE, CLAIM_TTL_MS } from '@/lib/billing/claim';
import { methodStatus, sellingIsOpen } from '@/lib/method-status';
import { PLANS, disclosure, type PlanId } from '@/lib/plans';
import { clientIp, limit, tooMany } from '@/lib/ratelimit';

/*
 * POST /api/billing/checkout — start a Stripe Checkout Session.
 *
 * TWO PATHS, AND WHY THE ANONYMOUS ONE EXISTS
 * Requiring an account before payment was the single most expensive decision in
 * the old flow. It forced: choose a plan, get diverted to sign-in, wait for an
 * email, come back, and choose the plan again — because the choice lived in
 * component state that the navigation destroyed. Stripe Checkout already
 * collects an email. Letting it do so removes that entire leg.
 *
 * A SIGNED-IN USER STILL BINDS TO THEIR OWN ACCOUNT. The email Stripe collects
 * is ignored in that case: whoever is holding the session cookie is who this
 * subscription belongs to. Only a visitor with no session is resolved by email,
 * and even then paying does not necessarily sign them in — see lib/billing/claim.
 *
 * THE CLAIM NONCE
 * A random value is set as an httpOnly cookie here, and only its SHA-256 is
 * stored. On return, /welcome proves same-browser continuity by presenting the
 * cookie. Nothing identifying goes in the URL — the old success_url carried
 * `?session_id=`, which lands in browser history, synced history, host access
 * logs and any support chat where someone pastes the link. A value Stripe
 * deliberately puts in the URL bar must never be sufficient to mint a session.
 *
 * The disclosure is still recorded verbatim BEFORE the session is created, so a
 * session can never exist without its consent record. Under the anonymous path
 * that row starts with a null user and is backfilled by the webhook.
 */

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomNonce(): string {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function POST(req: Request) {
  const user = await currentUser();
  const ip = clientIp(req);

  let body: { plan?: string; consented?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json({ code: 'bad_request' }, { status: 400 });
  }

  /*
   * The kill switch, enforced where the money is. Existing subscribers are
   * untouched — /api/patch does not consult this — so anyone who already paid
   * keeps working. What stops is taking NEW money for something that may not
   * work, which is the part that turns into refunds and disputes.
   */
  if (!(await sellingIsOpen())) {
    const { status, note } = await methodStatus();
    return Response.json({
      code: 'selling_paused',
      message: note ?? (status === 'broken'
        ? 'Pristine is temporarily not working after a platform change, and we are restoring it '
          + 'as fast as we can. New subscriptions are paused until it is back — please check again '
          + 'soon; we would rather wait for your money than take it for something that is not '
          + 'working today.'
        : 'We are checking a possible problem and have paused new subscriptions for the moment. '
          + 'Please try again shortly.'),
    }, { status: 503 });
  }

  /*
   * SIGN IN FIRST. The anonymous path below is kept intact but no longer
   * reachable from the site: a buyer who is not signed in is sent to sign in
   * with their file stashed, and comes back to pick the plan. The reason is
   * what happened on the first real purchase -- the buyer's address already
   * had an account, so the return could not sign them in (lib/billing/claim
   * explains why it must not), and they landed on a code prompt with no file
   * and no download. With the session established before Stripe, the return
   * is unambiguous: same browser, same account, restore the file, download.
   */
  if (!user) {
    return Response.json(
      { code: 'sign_in_required', message: 'Please sign in first.' },
      { status: 401 },
    );
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

  /*
   * This route used to be gated on currentUser(), which incidentally rate
   * limited it. Anonymous callers can now create Stripe Customers, Checkout
   * Sessions and database rows, so the limit has to be explicit.
   */
  if (!user) {
    const rate = await limit(`checkout:ip:${ip}`, 8, 3600);
    if (!rate.ok) return tooMany(rate);
  }

  /* ---- refuse to sell someone a second subscription -------------------- */

  if (user) {
    const existing = await db().select().from(schema.entitlements)
      .where(eq(schema.entitlements.userId, user.id)).limit(1);
    if (existing[0] && existing[0].accessUntil > new Date() && !existing[0].revokedAt) {
      return Response.json(
        { code: 'already_subscribed', message: 'You already have an active plan.' },
        { status: 409 },
      );
    }
  }

  /* ---- a Stripe customer, only when we already know who this is -------- */

  let customerId: string | null = null;
  if (user) {
    customerId = user.stripeCustomerId;
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
  }

  /* ---- record consent -------------------------------------------------- */

  const firstChargeAt = new Date(Date.now() + plan.trialDays * 86_400_000);
  /*
   * The Price Stripe will charge must be the price the customer is being
   * shown; see verifiedPriceIdForPlan. A mismatch is our configuration
   * error, so the sale is refused with an honest message and the error is
   * logged loudly — never charged and sorted out later.
   */
  let priceId: string;
  try {
    priceId = await verifiedPriceIdForPlan(planId);
  } catch (e) {
    if (e instanceof PriceMismatchError) {
      console.error(`[checkout] REFUSED: ${e.message}. Run \`npm run stripe:seed\` and update the STRIPE_PRICE_* env vars.`);
      return Response.json({
        code: 'price_mismatch',
        message: 'Checkout is paused for a moment while we correct a pricing setting. '
          + 'Nothing has been charged. Please try again shortly.',
      }, { status: 503 });
    }
    throw e;
  }

  const text = disclosure(plan, firstChargeAt);
  const origin = siteOrigin(req);

  const consent = await db().insert(schema.consents).values({
    // Null for an anonymous checkout; the webhook backfills it once Stripe has
    // told us which email paid. The column is nullable for exactly this.
    userId: user?.id ?? null,
    kind: plan.trialDays > 0 ? 'trial_negative_option' : 'immediate_charge',
    priceId,
    disclosureText: text,
    disclosureSha256: await sha256Hex(text),
    amountCents: plan.amount,
    interval: plan.interval,
    firstChargeAt,
    checkboxChecked: true,
    ip: ip === 'unknown' ? '0.0.0.0' : ip,
    userAgent: req.headers.get('user-agent')?.slice(0, 500) ?? 'unknown',
    pageUrl: req.headers.get('referer') ?? `${origin}/app`,
  }).returning({ id: schema.consents.id });

  /* ---- the session ----------------------------------------------------- */

  // Generated here rather than by the database, because it has to go into the
  // Stripe session that is created before the row is written.
  const pendingId = crypto.randomUUID();
  const nonce = randomNonce();

  const meta: Record<string, string> = {
    plan: planId,
    consent_id: consent[0].id,
    pending_checkout_id: pendingId,
    ...(user ? { user_id: user.id } : {}),
  };

  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    ...(customerId ? { customer: customerId } : {}),
    // For a signed-in user this stays the user id, which is what
    // /api/billing/sync compares against. Anonymous checkouts carry the pending
    // handle instead — a non-secret lookup key, never the nonce itself, because
    // this field is rendered in the Stripe Dashboard and in every webhook body.
    client_reference_id: user ? user.id : `pc_${pendingId}`,
    line_items: [{ price: priceId, quantity: 1 }],

    // Always take a card, including for trials. Stated on the page too.
    payment_method_collection: 'always',

    subscription_data: {
      ...(plan.trialDays > 0
        ? {
            trial_period_days: plan.trialDays,
            trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
          }
        : {}),
      // Copied onto the Subscription itself so every subscription event is
      // self-describing, even when it arrives before checkout.session.completed
      // and even when no user existed at checkout time.
      metadata: meta,
    },

    // ALSO at the top level. The webhook's consent backfill reads the Checkout
    // Session's own metadata, which was never set — harmless while consents
    // were written with a user attached, load-bearing now that they are not.
    metadata: meta,

    allow_promotion_codes: false,

    ...(process.env.STRIPE_AUTOMATIC_TAX === '1'
      ? { automatic_tax: { enabled: true }, customer_update: { address: 'auto', name: 'auto' } }
      : {}),

    // Renders directly above Stripe's Subscribe button — the control that
    // actually starts billing, which is where the disclosure belongs. When the
    // consent checkbox is enabled below, this is merged into that object
    // instead: a later `custom_text` key in the same literal would silently
    // replace this one and the disclosure would vanish.
    ...(process.env.STRIPE_TOS_CONSENT === '1'
      ? {}
      : { custom_text: { submit: { message: text } } }),

    /*
     * An affirmative, unticked acceptance checkbox on Stripe's page, replacing
     * the one that used to be in our own modal. California's ARL wants
     * affirmative consent and prohibits a pre-ticked box; Stripe's is neither
     * pre-ticked nor skippable.
     *
     * Gated behind an env var because Stripe REJECTS the session outright unless
     * a Terms of Service URL is configured in the dashboard (Settings → Public
     * details). Turning this on before that is set would break every checkout,
     * so it stays off until the setting exists — the same reasoning as
     * STRIPE_AUTOMATIC_TAX above.
     */
    ...(process.env.STRIPE_TOS_CONSENT === '1'
      ? {
          consent_collection: { terms_of_service: 'required' as const },
          /*
           * Naming the terms explicitly rather than taking Stripe's generic
           * default. "I agree to the terms of service" with no link is weaker
           * evidence than a sentence that says which terms, and links to them,
           * next to the box the customer actually ticked.
           */
          custom_text: {
            submit: { message: text },
            terms_of_service_acceptance: {
              message: `I agree to the [Terms of Service](${origin}/legal/terms) and the `
                + `[Refund Policy](${origin}/legal/refunds).`,
            },
          },
        }
      : {}),

    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    // No query string. Everything needed on return is in the claim cookie, and
    // the claim route can set a session cookie where a page cannot.
    success_url: `${origin}/api/billing/claim`,
    cancel_url: `${origin}/app?cancelled=1`,
  }, {
    idempotencyKey: `checkout:${pendingId}`,
  });

  await db().insert(schema.pendingCheckouts).values({
    id: pendingId,
    nonceHash: await sha256Hex(nonce),
    stripeSessionId: session.id,
    plan: planId,
    consentId: consent[0].id,
    userId: user?.id ?? null,
    ip: ip === 'unknown' ? null : ip,
    expiresAt: new Date(Date.now() + CLAIM_TTL_MS),
  });

  /*
   * `lax`, not `strict`: the return from checkout.stripe.com is a cross-site
   * top-level navigation, and a Strict cookie would not be sent, dead-ending
   * every checkout. The session cookie is already lax for the same reason.
   */
  const jar = await cookies();
  jar.set(CLAIM_COOKIE, nonce, {
    httpOnly: true,
    // Required by the __Host- prefix. localhost is a secure context, so this
    // does not break development.
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(CLAIM_TTL_MS / 1000),
  });

  return Response.json({ url: session.url });
}
