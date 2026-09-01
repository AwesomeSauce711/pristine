import { siteOrigin } from '@/lib/origin';
import { currentUser } from '@/lib/auth';
import { stripe } from '@/lib/billing/stripe';

/*
 * POST /api/billing/portal — hand the customer to Stripe's Customer Portal.
 *
 * Cancellation, card updates and invoice history all live there rather than in
 * a flow we wrote. That is a deliberate choice: cancellation must be at least
 * as easy as signing up, and a home-grown cancel flow is exactly where
 * retention dark patterns creep in and where negative-option enforcement lands.
 * Stripe's is one click and is maintained for us.
 *
 * Configure the Portal to cancel at PERIOD END rather than immediately. The
 * entitlement mapping assumes it — `canceled` is treated as "access has ended",
 * which is only correct if a cancellation lands when the paid period does.
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) {
    return Response.json({ code: 'not_signed_in' }, { status: 401 });
  }
  if (!user.stripeCustomerId) {
    return Response.json(
      { code: 'no_customer', message: 'There is no billing history on this account yet.' },
      { status: 400 },
    );
  }

  try {
    const session = await stripe().billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${siteOrigin(req)}/account`,
    });
    return Response.json({ url: session.url });
  } catch (e) {
    console.error('[billing] portal session failed', e);
    return Response.json(
      { code: 'portal_failed', message: 'Could not open billing just now. Please try again.' },
      { status: 502 },
    );
  }
}
