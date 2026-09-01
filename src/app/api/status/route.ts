import { methodStatus } from '@/lib/method-status';

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
  const state = await methodStatus();
  return Response.json(state, {
    headers: {
      // Must not be cached at the edge: the whole point is that flipping the
      // switch takes effect in seconds, not at the next cache expiry.
      'cache-control': 'no-store',
    },
  });
}
