import { currentUser } from '@/lib/auth';
import { stripe } from '@/lib/billing/stripe';
import { syncSubscription } from '@/lib/billing/sync';
import { limit, tooMany } from '@/lib/ratelimit';

/*
 * POST /api/billing/sync — reconcile this user's subscription on demand.
 *
 * The webhook is the source of truth and almost always wins the race. This
 * exists for the ~1% where it is slow or was dropped during a deploy, so a
 * customer who has just paid is never left staring at a paywall.
 *
 * THE REDIRECT IS NOT TRUSTED FOR ENTITLEMENT. A `session_id` in a URL is
 * something the browser hands us: it can be bookmarked, shared, or invented.
 * What we do with it is ask STRIPE about it, and then check that the session
 * Stripe describes actually belongs to the person asking.
 *
 * That `client_reference_id` check is the important line in this file. Without
 * it, anyone who obtained another user's session id could graft that payment
 * onto their own account.
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ code: 'not_signed_in' }, { status: 401 });

  // This endpoint calls Stripe, so it must not be usable as an amplifier.
  const rate = await limit(`sync:${user.id}`, 5, 3600);
  if (!rate.ok) return tooMany(rate);

  let sessionId: string | null = null;
  try {
    const body = await req.json().catch(() => ({}));
    sessionId = body.sessionId ? String(body.sessionId) : null;
  } catch {
    /* body is optional */
  }

  try {
    if (sessionId) {
      const session = await stripe().checkout.sessions.retrieve(sessionId, {
        expand: ['subscription'],
      });

      if (session.client_reference_id !== user.id) {
        // Someone else's checkout session. Refuse, and say nothing about it.
        return Response.json({ code: 'not_found' }, { status: 404 });
      }
      if (session.status !== 'complete') {
        return Response.json({ ok: false, pending: true });
      }

      const subId = typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription?.id;
      if (subId) await syncSubscription(subId);
      return Response.json({ ok: true });
    }

    // No session id: reconcile whatever subscriptions this customer has.
    if (!user.stripeCustomerId) return Response.json({ ok: true, nothing: true });

    const subs = await stripe().subscriptions.list({
      customer: user.stripeCustomerId,
      status: 'all',
      limit: 10,
    });
    for (const s of subs.data) await syncSubscription(s.id);
    return Response.json({ ok: true, synced: subs.data.length });
  } catch (e) {
    console.error('[billing] manual sync failed', e);
    return Response.json(
      { code: 'sync_failed', message: 'Could not check your subscription just now.' },
      { status: 502 },
    );
  }
}
