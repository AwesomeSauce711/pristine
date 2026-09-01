import { cookies } from 'next/headers';
import { currentUser } from '@/lib/auth';
import { CLAIM_COOKIE, claimCheckout } from '@/lib/billing/claim';
import { clientIp } from '@/lib/ratelimit';

/*
 * GET /api/billing/claim — where Stripe returns after a successful checkout.
 *
 * WHY A ROUTE HANDLER AND NOT A PAGE
 * Claiming has to set the session cookie, and Next only permits that from a
 * Route Handler or a Server Action — never during a Server Component render. A
 * page would have to bounce through a second request to do the same work, which
 * the user sees as a flash of an intermediate screen at the exact moment they
 * are wondering whether their payment worked.
 *
 * WHY GET IS ACCEPTABLE HERE DESPITE MUTATING
 * This is a redirect target for a third party, the same shape as an OAuth
 * callback, and Stripe issues a GET. The action is gated on an httpOnly,
 * single-use, short-lived nonce that only this browser holds, so a forged
 * request cannot claim anything for the attacker. The residual is that someone
 * who can make a victim's browser issue this GET can BURN their claim early —
 * a nuisance, not an escalation: the buyer still owns the subscription and can
 * still sign in with an emailed code.
 *
 * Everything about who gets signed in lives in lib/billing/claim.ts, including
 * the rule that a payment against an address that ALREADY has an account never
 * mints a session.
 */
export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const jar = await cookies();
  const nonce = jar.get(CLAIM_COOKIE)?.value;
  const user = await currentUser();

  let outcome;
  try {
    outcome = await claimCheckout(nonce, !!user, clientIp(req) || null);
  } catch (e) {
    console.error('[claim] failed', e);
    // Never strand someone who has just paid. The webhook is authoritative and
    // will have done the work; /welcome can pick it up from there.
    return Response.redirect(`${origin}/welcome?state=error`, 303);
  }

  // Whatever happened, this nonce is spent.
  if (nonce) jar.delete(CLAIM_COOKIE);

  switch (outcome.status) {
    case 'signed_in':
    case 'already_signed_in':
      /*
       * Straight back to the tool with the resume flag. The file the user
       * dropped was stashed before the redirect, so /app restores it and the
       * download starts without them doing anything.
       */
      return Response.redirect(`${origin}/app?resume=1`, 303);

    case 'needs_code':
      return Response.redirect(
        `${origin}/welcome?state=code&email=${encodeURIComponent(outcome.email)}`,
        303,
      );

    case 'pending':
      return Response.redirect(`${origin}/welcome?state=pending`, 303);

    default:
      return Response.redirect(`${origin}/welcome`, 303);
  }
}
