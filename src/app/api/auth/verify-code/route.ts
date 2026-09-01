import { normaliseEmail, redeemLoginCode } from '@/lib/auth';
import { clientIp, limit, tooMany } from '@/lib/ratelimit';

/*
 * POST /api/auth/verify-code
 *
 * A six-digit code is a million possibilities, which is only strong enough
 * because guessing is bounded. Two bounds apply: the stored token burns itself
 * after five wrong attempts, and this endpoint limits attempts per IP so an
 * attacker cannot simply request a fresh code and keep going.
 *
 * Every failure returns the same message. Distinguishing "wrong code" from
 * "expired" from "already used" only helps someone guessing.
 */

export async function POST(req: Request) {
  let email: string;
  let code: string;
  try {
    const body = await req.json();
    email = normaliseEmail(String(body.email ?? ''));
    /*
     * Strip to digits before validating, not after.
     *
     * People paste from a mail client, and what arrives can carry spaces, a
     * non-breaking space, or the invisible characters some clients wrap around a
     * selection. Validating the raw string rejects a perfectly correct code and
     * shows the same "wrong code" message as a genuine mistake, so the user
     * retries the identical paste and fails again.
     */
    code = String(body.code ?? '').replace(/\D+/g, '');
  } catch {
    return Response.json({ code: 'bad_request' }, { status: 400 });
  }

  if (!email || !/^\d{6}$/.test(code)) {
    return Response.json(
      { code: 'bad_code', message: 'Enter the six-digit code from your email.' },
      { status: 400 },
    );
  }

  const perIp = await limit(`verify:ip:${clientIp(req)}`, 20, 3600);
  if (!perIp.ok) return tooMany(perIp);

  const perEmail = await limit(`verify:email:${email}`, 8, 900);
  if (!perEmail.ok) return tooMany(perEmail);

  try {
    const user = await redeemLoginCode(email, code);
    if (!user) {
      return Response.json(
        { code: 'bad_code', message: 'That code was not right, or it has expired.' },
        { status: 400 },
      );
    }
    return Response.json({ ok: true, email: user.email });
  } catch (e) {
    console.error('[auth] verify failed', e);
    return Response.json(
      { code: 'internal', message: 'Something went wrong. Please try again.' },
      { status: 500 },
    );
  }
}
