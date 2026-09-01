import 'server-only';

import { COMPANY } from '@/lib/company';

/*
 * email.ts — transactional mail, over Resend's HTTP API.
 *
 * No SDK. Sending an email is one POST with a JSON body, and a dependency that
 * wraps `fetch` is a supply-chain surface and a version to maintain in exchange
 * for nothing.
 *
 * WHY FAILURES THROW RATHER THAN BEING SWALLOWED
 * A sign-in code that is silently dropped is indistinguishable, from the user's
 * side, from a code they typed wrong. They retry, it fails again, and the
 * support ticket that arrives contains no information anyone can act on. An
 * outright error at least surfaces the real cause at the moment it happens.
 *
 * WHY THERE IS NO QUEUE OR RETRY
 * The only mail on the critical path is the sign-in code, and it is worthless
 * by the time a retry would land — the user is sitting on the form now, and the
 * code expires in minutes. Retrying a stale code is worse than failing fast,
 * because it fills an inbox with codes that no longer work. Mail that genuinely
 * benefits from retry (receipts, dunning) is sent by Stripe, not by us.
 */

const ENDPOINT = 'https://api.resend.com/emails';

export class EmailError extends Error {}

function config() {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  return { key, from };
}

/** Whether mail can actually be sent in this process. */
export function emailConfigured(): boolean {
  const { key, from } = config();
  return !!key && !!from;
}

interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

async function send(mail: Mail): Promise<void> {
  const { key, from } = config();
  if (!key || !from) {
    throw new EmailError(
      'RESEND_API_KEY and EMAIL_FROM must both be set before mail can be sent.',
    );
  }

  /*
   * A hung mail provider must not hold a request open. The sign-in route is
   * rate-limited per IP, so a provider timing out at 30s would otherwise pin
   * connections and take the whole route down with it.
   */
  const abort = AbortSignal.timeout(10_000);

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        // Transactional mail must never carry a list-unsubscribe or land in a
        // marketing stream; a sign-in code that goes to the Promotions tab is a
        // sign-in code that does not arrive.
        headers: { 'X-Entity-Ref-ID': crypto.randomUUID() },
      }),
      signal: abort,
    });
  } catch (e) {
    throw new EmailError(
      `Could not reach the email provider: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new EmailError(`Email provider returned ${res.status}: ${body.slice(0, 300)}`);
  }
}

/* ------------------------------------------------------------------ layout */

const wrap = (title: string, body: string): string => `
<!doctype html>
<html><body style="margin:0;padding:32px 16px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:14px;padding:32px;">
    <tr><td>
      <div style="font-size:15px;font-weight:600;letter-spacing:-0.01em;color:#111;">${COMPANY.tradingName}</div>
      <h1 style="margin:20px 0 0;font-size:19px;font-weight:600;color:#111;letter-spacing:-0.01em;">${title}</h1>
      ${body}
      <p style="margin:28px 0 0;font-size:12px;line-height:1.6;color:#8a8a8f;">
        ${COMPANY.legalName}${COMPANY.address && COMPANY.address !== 'TO BE COMPLETED' ? ` · ${COMPANY.address}` : ''}<br>
        Questions: <a href="mailto:${COMPANY.supportEmail}" style="color:#6b6b70;">${COMPANY.supportEmail}</a>
      </p>
    </td></tr>
  </table>
</body></html>`;

/* ------------------------------------------------------------------ sign-in */

export async function sendLoginCode(email: string, code: string, ttlMinutes: number): Promise<void> {
  /*
   * The digits are spaced by CSS letter-spacing, NOT by putting real spaces
   * between them. Literal spaces look identical and survive into the clipboard,
   * so "3 8 7 6 7 9" is what gets pasted — and mail clients are free to wrap or
   * drop part of it at a space, which is exactly what happened: a copy from
   * Gmail yielded only the first three digits. Visual spacing belongs in the
   * stylesheet; the text has to stay the literal code.
   */
  await send({
    to: email,
    // The code goes in the subject too: on a phone the notification alone is
    // often enough, without opening the mail at all.
    subject: `${code} is your ${COMPANY.tradingName} sign-in code`,
    text:
      `Your ${COMPANY.tradingName} sign-in code is ${code}.\n\n` +
      `It expires in ${ttlMinutes} minutes and can be used once.\n\n` +
      `If you did not request this, you can ignore this email — no one can sign in without the code.\n`,
    html: wrap('Your sign-in code', `
      <p style="margin:14px 0 0;font-size:14px;line-height:1.6;color:#3a3a3f;">
        Enter this code to finish signing in. It expires in ${ttlMinutes} minutes and works once.
      </p>
      <div style="margin:22px 0;padding:16px;background:#f5f5f7;border-radius:10px;text-align:center;
                  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:26px;
                  letter-spacing:0.18em;font-weight:600;color:#111;">${code}</div>
      <p style="margin:0;font-size:13px;line-height:1.6;color:#8a8a8f;">
        If you did not request this, ignore this email. No one can sign in without the code.
      </p>
    `),
  });
}
