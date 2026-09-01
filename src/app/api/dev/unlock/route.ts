import { cookies } from 'next/headers';
import { DEV_UNLOCK_COOKIE, devUnlockAvailable } from '@/lib/dev-access';

/*
 * POST /api/dev/unlock — grant (or revoke) the development unlock.
 *
 * Re-checks the guards rather than trusting that `resolveAccess` will. Defence
 * in depth matters more than usual here: the failure mode of this route being
 * reachable in production is that the product becomes free, so it refuses
 * loudly rather than assuming a caller has already checked.
 *
 * In a production build this returns 404 — not 403 — so it is indistinguishable
 * from a route that does not exist.
 */
export async function POST(req: Request) {
  if (!devUnlockAvailable()) {
    return new Response('Not found', { status: 404 });
  }

  let lock = false;
  try {
    const body = await req.json().catch(() => ({}));
    lock = body?.lock === true;
  } catch {
    /* body optional */
  }

  const jar = await cookies();
  if (lock) {
    jar.delete(DEV_UNLOCK_COOKIE);
  } else {
    jar.set(DEV_UNLOCK_COOKIE, '1', {
      httpOnly: true,
      // Not `secure`, because development runs over plain http on localhost.
      // This cookie only exists at all when NODE_ENV is not production.
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 8,
    });
  }

  void req;
  return Response.json({ ok: true, unlocked: !lock });
}
