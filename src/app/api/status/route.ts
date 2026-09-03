import { methodStatus } from '@/lib/method-status';
import { priceConfigProblems, refillPriceId, verifiedPriceIdForPlan, verifiedRefillPriceId } from '@/lib/billing/stripe';
import { PLAN_ORDER } from '@/lib/plans';

/*
 * Do the Stripe Prices the site would charge still match what it shows? The
 * checkout route refuses a sale on a mismatch; this is the same check, exposed
 * as one word so the canary can watch it without being able to start a
 * checkout (which now needs a session). Cached ten minutes inside
 * verifiedPriceIdForPlan, so this costs nothing per request in the steady
 * state. Only the verdict leaves the server.
 */
async function pricesVerdict(): Promise<'ok' | 'mismatch' | 'unavailable'> {
  if (!process.env.STRIPE_SECRET_KEY) return 'unavailable';
  /* A price id filed under the wrong plan gives that customer the wrong
   * daily cap and the wrong plan name, and nothing else would ever say so. */
  const misconfigured = priceConfigProblems();
  if (misconfigured.length) {
    console.error(`[status] price configuration: ${misconfigured.join('; ')}`);
    return 'mismatch';
  }
  try {
    for (const id of PLAN_ORDER) await verifiedPriceIdForPlan(id);
    if (refillPriceId()) await verifiedRefillPriceId();
    return 'ok';
  } catch (e) {
    return e instanceof Error && e.name === 'PriceMismatchError' ? 'mismatch' : 'unavailable';
  }
}

/*
 * GET /api/status — is the method working?
 *
 * Public and unauthenticated on purpose. It says nothing an unhappy customer
 * could not already tell you, and a status page that requires signing in is
 * useless in exactly the situation it exists for.
 *
 * Display only. The checkout route re-reads the flag server-side, so tampering
 * with this response changes what a banner looks like and nothing else.
 */
export async function GET() {
  const [state, prices] = await Promise.all([methodStatus(), pricesVerdict()]);
  return Response.json({ ...state, prices }, {
    headers: {
      // Must not be cached at the edge: the whole point is that flipping the
      // switch takes effect in seconds, not at the next cache expiry.
      'cache-control': 'no-store',
    },
  });
}
