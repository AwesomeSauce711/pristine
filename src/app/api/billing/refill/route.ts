import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';
import { siteOrigin } from '@/lib/origin';
import { currentUser } from '@/lib/auth';
import { PriceMismatchError, REFILL_AMOUNT_CENTS, refillPriceId, stripe, verifiedRefillPriceId } from '@/lib/billing/stripe';
import { limit, tooMany } from '@/lib/ratelimit';

/*
 * POST /api/billing/refill -- buy one more day's allowance, for 99 cents.
 *
 * WHO CAN
 * A signed-in reader with a plan that is live right now. The count is the
 * plan's own daily cap from their entitlement row -- 1, 3 or 10 -- so a refill
 * always means "the same again", never a number chosen by the client.
 *
 * WHAT IT IS
 * A one-time Stripe Checkout (mode 'payment'), not a subscription change: no
 * proration, no plan switch, nothing recurring. The webhook records the paid
 * session as a refill row; resolveAccess counts it. The return is the same
 * /app?resume=1&paid=1 the subscription return uses, so the file is restored
 * and the download starts on its own once the allowance has landed.
 *
 * Inert until STRIPE_PRICE_REFILL exists (503 refill_unavailable), so the
 * feature can ship before the Price does.
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) {
    return Response.json({ code: 'sign_in_required', message: 'Please sign in first.' }, { status: 401 });
  }
  if (!refillPriceId()) {
    return Response.json(
      { code: 'refill_unavailable', message: 'Refills are not available yet.' },
      { status: 503 },
    );
  }

  const rate = await limit(`refill:user:${user.id}`, 10, 3600);
  if (!rate.ok) return tooMany(rate);

  const rows = await db().select().from(schema.entitlements)
    .where(eq(schema.entitlements.userId, user.id)).limit(1);
  const ent = rows[0];
  const live = !!ent && ent.accessUntil > new Date() && !ent.revokedAt;
  if (!live) {
    return Response.json(
      { code: 'no_plan', message: 'A refill adds to a plan. Choose a plan first.' },
      { status: 409 },
    );
  }
  const count = Math.max(1, Math.min(50, ent.dailyPatchCap));

  let priceId: string;
  try {
    priceId = await verifiedRefillPriceId();
  } catch (e) {
    if (e instanceof PriceMismatchError) {
      console.error(`[refill] REFUSED: ${e.message}. Run \`npm run stripe:seed\` and set STRIPE_PRICE_REFILL.`);
      return Response.json(
        { code: 'price_mismatch', message: 'Refills are paused for a moment while we correct a pricing setting. Nothing has been charged.' },
        { status: 503 },
      );
    }
    throw e;
  }

  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe().customers.create({ email: user.email, metadata: { user_id: user.id } });
    customerId = customer.id;
    await db().update(schema.users).set({ stripeCustomerId: customerId }).where(eq(schema.users.id, user.id));
  }

  const origin = siteOrigin(req);
  const meta = { kind: 'refill', user_id: user.id, count: String(count) };
  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    customer: customerId,
    client_reference_id: user.id,
    line_items: [{ price: priceId, quantity: 1 }],
    metadata: meta,
    payment_intent_data: {
      metadata: meta,
      description: `Pristine refill: ${count} more today`,
    },
    custom_text: {
      submit: {
        message: `One-time payment of $${(REFILL_AMOUNT_CENTS / 100).toFixed(2)}. Adds ${count} more `
          + `${count === 1 ? 'video' : 'videos'} to your allowance for the next 24 hours. Nothing recurring.`,
      },
    },
    allow_promotion_codes: false,
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    success_url: `${origin}/app?resume=1&paid=1`,
    cancel_url: `${origin}/app?cancelled=1`,
  }, {
    idempotencyKey: `refill:${crypto.randomUUID()}`,
  });

  return Response.json({ url: session.url });
}
