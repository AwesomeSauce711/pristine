import { devUnlockAvailable } from '@/lib/dev-access';
import { resolveAccess } from '@/lib/entitlement';
import { REFILL_AMOUNT_CENTS, refillPriceId } from '@/lib/billing/stripe';

/*
 * GET /api/me — what the UI should render.
 *
 * FOR DISPLAY ONLY. This tells the browser whether to show a Download button or
 * a paywall; it is never what grants access. `/api/patch` re-resolves
 * entitlement server-side on every call, so tampering with this response
 * changes what a page looks like and nothing else.
 *
 * Also polled by /welcome while the Stripe webhook lands.
 */
export async function GET() {
  const access = await resolveAccess();

  return Response.json(
    {
      signedIn: !!access.user,
      email: access.user?.email ?? null,
      entitled: access.ok,
      /* A live plan, whether or not there is allowance left right now. The
       * tool page gates the plans on THIS: a subscriber at the day's cap must
       * be offered a refill, never the plans again. */
      hasPlan: access.ok || access.denial === 'daily_quota' || access.denial === 'period_quota',
      state: access.state,
      tier: access.tier,
      accessUntil: access.accessUntil?.toISOString() ?? null,
      dailyRemaining: access.dailyRemaining,
      periodRemaining: access.periodRemaining,
      dailyCap: access.dailyCap ?? null,
      resetsAt: access.resetsAt?.toISOString() ?? null,
      refillsToday: access.refillsToday ?? 0,
      /* Whether the 99-cent refill can be offered: the Price exists. */
      refill: refillPriceId() ? { amountCents: REFILL_AMOUNT_CENTS } : null,
      denial: access.denial ?? null,
      // Lets the UI offer the dev unlock button. Always false in production.
      devUnlockAvailable: devUnlockAvailable(),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
