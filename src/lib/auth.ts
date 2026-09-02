import 'server-only';

import { cookies, headers } from 'next/headers';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db, schema } from '@/db';
import { emailConfigured, sendLoginCode } from '@/lib/email';

/*
 * auth.ts — accounts, sessions, and email codes.
 *
 * NO PASSWORDS. There is nothing here worth the support burden and breach risk
 * of storing them: a short-lived emailed code proves control of the address,
 * which is the only thing an account here actually represents.
 *
 * SESSIONS ARE OPAQUE AND SERVER-SIDE, not JWTs. A JWT keeps working until it
 * expires, so a chargeback could not revoke access until then. With a row per
 * session, `charge.dispute.created` can revoke every session in the same
 * transaction that revokes entitlement. The cost is one indexed lookup per
 * request, which is the correct trade for a paid product.
 *
 * Only the SHA-256 of each token is stored, so a database leak does not hand
 * over live sessions.
 */

const COOKIE = '__Host-pristine_session';
/*
 * Six months. There is no password, so the code in the inbox IS the sign-in,
 * and a session that lapsed every month would have a paying customer fetching
 * a code twelve times a year to use what they pay for. Six months on a
 * device is long enough that a subscriber effectively never sees the sign-in
 * page again; revocation (dispute, sign-out) is still immediate because the
 * session is a row, not a token — see the note at the top.
 */
const SESSION_DAYS = 180;
const CODE_TTL_MINUTES = 10;
const MAX_CODE_ATTEMPTS = 5;

/* --------------------------------------------------------------- helpers */

const enc = new TextEncoder();

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function randomToken(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A six-digit code, drawn without modulo bias.
 *
 * `x % 1_000_000` over a 32-bit draw is very slightly biased toward low codes.
 * It would not matter in practice, but rejection sampling costs one loop and
 * removes the need to argue about it.
 */
function numericCode(): string {
  const limit = Math.floor(0xFFFFFFFF / 1_000_000) * 1_000_000;
  const a = new Uint32Array(1);
  do { crypto.getRandomValues(a); } while (a[0] >= limit);
  return String(a[0] % 1_000_000).padStart(6, '0');
}

export const normaliseEmail = (email: string): string => email.trim().toLowerCase();

/* ------------------------------------------------------------- sessions */

export interface SessionUser {
  id: string;
  email: string;
  stripeCustomerId: string | null;
  /* Carried so usage rows can be tied to a device without a second query.
   * It is dispute evidence, not a security control — it identifies a browser
   * that signed in, and nothing stops someone clearing it. */
  deviceId: string | null;
}

/**
 * Start a session and set the cookie. Returns the DEVICE id, not the token.
 *
 * The token's only consumer is the cookie this function sets, so returning it
 * would hand a live credential to a caller with no use for it. The device id is
 * what callers actually want — it labels usage rows for the audit trail.
 */
export async function createSession(userId: string): Promise<string> {
  const token = randomToken();
  const deviceId = randomToken(8);
  const h = await headers();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);

  await db().insert(schema.sessions).values({
    userId,
    tokenHash: await sha256Hex(token),
    deviceId,
    ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: h.get('user-agent')?.slice(0, 500) ?? null,
    expiresAt,
  });

  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });

  return deviceId;
}

/** The signed-in user, or null. Never throws — an unreadable session is signed out. */
export async function currentUser(): Promise<SessionUser | null> {
  let token: string | undefined;
  try {
    token = (await cookies()).get(COOKIE)?.value;
  } catch {
    return null;
  }
  if (!token) return null;

  try {
    const rows = await db()
      .select({
        id: schema.users.id,
        email: schema.users.email,
        stripeCustomerId: schema.users.stripeCustomerId,
        deviceId: schema.sessions.deviceId,
        sessionId: schema.sessions.id,
      })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .where(and(
        eq(schema.sessions.tokenHash, await sha256Hex(token)),
        isNull(schema.sessions.revokedAt),
        gt(schema.sessions.expiresAt, new Date()),
        // A blocked account is signed out everywhere, immediately.
        isNull(schema.users.blockedAt),
      ))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    // Best-effort activity stamp; never let it fail the request.
    void db().update(schema.sessions)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.sessions.id, row.sessionId))
      .catch(() => {});

    return {
      id: row.id, email: row.email,
      stripeCustomerId: row.stripeCustomerId, deviceId: row.deviceId,
    };
  } catch {
    return null;
  }
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) {
    await db().update(schema.sessions)
      .set({ revokedAt: new Date() })
      .where(eq(schema.sessions.tokenHash, await sha256Hex(token)));
  }
  jar.delete(COOKIE);
}

/** Revoke every session for a user. Called on dispute, block, or "sign out everywhere". */
export async function revokeAllSessions(userId: string): Promise<void> {
  await db().update(schema.sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)));
}

/* ---------------------------------------------------------- email codes */

export interface SendCodeResult {
  ok: boolean;
  /** Present only outside production, so the flow is testable without email set up. */
  devCode?: string;
}

/**
 * Issue a sign-in code.
 *
 * Always reports success, whether or not the address has an account. Telling an
 * anonymous caller which emails exist is an account-enumeration oracle, and the
 * information is of no use to the legitimate owner.
 */
export async function issueLoginCode(rawEmail: string): Promise<SendCodeResult> {
  const email = normaliseEmail(rawEmail);
  const code = numericCode();
  const h = await headers();

  await db().insert(schema.loginTokens).values({
    email,
    codeHash: await sha256Hex(`${email}:${code}`),
    purpose: 'signin',
    expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60_000),
    ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  });

  await sendLoginEmail(email, code);

  return process.env.NODE_ENV === 'production' ? { ok: true } : { ok: true, devCode: code };
}

/**
 * Exchange a code for a session, creating the account on first sign-in.
 *
 * Returns null for anything wrong — wrong code, expired, already used, too many
 * attempts — without distinguishing between them, because the distinctions are
 * only useful to someone guessing.
 */
export async function redeemLoginCode(rawEmail: string, code: string): Promise<SessionUser | null> {
  const email = normaliseEmail(rawEmail);
  /*
   * Strip everything that is not a digit before hashing.
   *
   * People paste from a mail client, and what arrives may carry spaces, a
   * non-breaking space, a stray newline, or the invisible characters some
   * clients wrap around a selection. Rejecting those is indistinguishable to
   * the user from a wrong code, and they retry with the same paste.
   */
  const digits = code.replace(/\D+/g, '');
  const codeHash = await sha256Hex(`${email}:${digits}`);
  const now = new Date();

  const rows = await db()
    .select()
    .from(schema.loginTokens)
    .where(and(
      eq(schema.loginTokens.email, email),
      eq(schema.loginTokens.purpose, 'signin'),
      isNull(schema.loginTokens.consumedAt),
      gt(schema.loginTokens.expiresAt, now),
    ))
    .orderBy(sql`${schema.loginTokens.expiresAt} desc`)
    .limit(1);

  const token = rows[0];
  if (!token) return null;

  if (token.attempts >= MAX_CODE_ATTEMPTS) {
    await db().update(schema.loginTokens)
      .set({ consumedAt: now })
      .where(eq(schema.loginTokens.id, token.id));
    return null;
  }

  if (token.codeHash !== codeHash) {
    await db().update(schema.loginTokens)
      .set({ attempts: token.attempts + 1 })
      .where(eq(schema.loginTokens.id, token.id));
    return null;
  }

  // Single use, burned before the session is minted.
  await db().update(schema.loginTokens)
    .set({ consumedAt: now })
    .where(eq(schema.loginTokens.id, token.id));

  const h = await headers();
  const existing = await db().select().from(schema.users)
    .where(eq(schema.users.email, email)).limit(1);

  let user = existing[0];
  if (!user) {
    const created = await db().insert(schema.users).values({
      email,
      emailVerifiedAt: now,
      signupIp: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      signupUserAgent: h.get('user-agent')?.slice(0, 500) ?? null,
    }).returning();
    user = created[0];
  } else if (!user.emailVerifiedAt) {
    await db().update(schema.users)
      .set({ emailVerifiedAt: now })
      .where(eq(schema.users.id, user.id));
  }

  const deviceId = await createSession(user.id);
  return {
    id: user.id, email: user.email,
    stripeCustomerId: user.stripeCustomerId, deviceId,
  };
}

/**
 * Deliver the code.
 *
 * Not yet wired to a provider. In development the code is logged and also
 * returned to the caller, so the whole sign-in flow can be exercised before any
 * email account exists. In production, refusing to send is the safe failure:
 * silently dropping the mail would look identical to a wrong code and generate
 * support tickets nobody can diagnose.
 */
async function sendLoginEmail(email: string, code: string): Promise<void> {
  /*
   * A configured provider always wins, including locally: exercising the real
   * send path before deploying is worth more than the console convenience. Only
   * when none is configured does development fall back to logging, so the whole
   * flow stays testable with no email account in existence.
   */
  if (emailConfigured()) {
    await sendLoginCode(email, code, CODE_TTL_MINUTES);
    return;
  }

  if (process.env.NODE_ENV !== 'production') {
    console.log(`\n  [auth] sign-in code for ${email}: ${code}\n`);
    return;
  }
  throw new Error(
    'No email provider is configured. Set RESEND_API_KEY and EMAIL_FROM, ' +
    'or sign-in codes will never arrive.',
  );
}
