import { issueLoginCode, normaliseEmail } from '@/lib/auth';
import { clientIp, limit, tooMany } from '@/lib/ratelimit';

/*
 * POST /api/auth/request-code
 *
 * Rate-limited on two axes deliberately. Per-email stops someone spamming one
 * person's inbox; per-IP stops someone enumerating many addresses from one
 * machine. This endpoint sends mail on demand, and an unmetered one is a
 * reliable way to get a sending domain blocklisted.
 *
 * The response is identical whether or not the address has an account. Saying
 * otherwise would confirm which emails are registered to anyone who asks.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function POST(req: Request) {
  let email: string;
  try {
    const body = await req.json();
    email = normaliseEmail(String(body.email ?? ''));
  } catch {
    return Response.json({ code: 'bad_request' }, { status: 400 });
  }

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return Response.json(
      { code: 'bad_email', message: 'That does not look like an email address.' },
      { status: 400 },
    );
  }

  const perEmail = await limit(`code:email:${email}`, 3, 600);
  if (!perEmail.ok) return tooMany(perEmail);

  const perIp = await limit(`code:ip:${clientIp(req)}`, 10, 3600);
  if (!perIp.ok) return tooMany(perIp);

  try {
    const result = await issueLoginCode(email);
    // devCode is present outside production only, so the flow is testable
    // before an email provider exists.
    return Response.json({ ok: true, devCode: result.devCode });
  } catch (e) {
    console.error('[auth] could not issue code', e);
    return Response.json(
      { code: 'send_failed', message: 'We could not send a code just now. Please try again.' },
      { status: 500 },
    );
  }
}
