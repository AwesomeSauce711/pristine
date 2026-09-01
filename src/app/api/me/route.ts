import { devUnlockAvailable } from '@/lib/dev-access';
import { resolveAccess } from '@/lib/entitlement';

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
      state: access.state,
      tier: access.tier,
      accessUntil: access.accessUntil?.toISOString() ?? null,
      dailyRemaining: access.dailyRemaining,
      periodRemaining: access.periodRemaining,
      denial: access.denial ?? null,
      // Lets the UI offer the dev unlock button. Always false in production.
      devUnlockAvailable: devUnlockAvailable(),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
