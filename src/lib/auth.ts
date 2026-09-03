import 'server-only';

import { cache } from 'react';

import { cookies, headers } from 'next/headers';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db, schema } from '@/db';
import { emailConfigured, sendLoginCode } from '@/lib/email';
import { requestIp } from '@/lib/ratelimit';

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

/*
 * Anything that can run the statements below: the database handle, or the
 * transaction redeemLoginCode holds while it burns a code and mints the
 * session it pays for.
 */
type DbWriter = Pick<ReturnType<typeof db>, 'insert' | 'update' | 'select'>;

interface MintedSession {
  token: string;
  deviceId: string;
  expiresAt: Date;
}

/** The row only; the cookie is the caller's, so it can follow a commit. */
async function insertSession(userId: string, exec: DbWriter): Promise<MintedSession> {
  const token = randomToken();
  const deviceId = randomToken(8);
  const h = await headers();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);

  await exec.insert(schema.sessions).values({
    userId,
    tokenHash: await sha256Hex(token),
    deviceId,
    ip: requestIp(h),
    userAgent: h.get('user-agent')?.slice(0, 500) ?? null,
    expiresAt,
  });

  return { token, deviceId, expiresAt };
}

async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

/**
 * Start a session and set the cookie. Returns the DEVICE id, not the token.
 *
 * The token's only consumer is the cookie this function sets, so returning it
 * would hand a live credential to a caller with no use for it. The device id is
 * what callers actually want — it labels usage rows for the audit trail.
 */
export async function createSession(userId: string): Promise<string> {
  const minted = await insertSession(userId, db());
  await setSessionCookie(minted.token, minted.expiresAt);
  return minted.deviceId;
}

/**
 * The session could not be looked up AT ALL, as opposed to there being none.
 *
 * The two used to be the same null, and one query the database did not
 * answer then read as "signed out" on every surface at once: /api/me said
 * so, /api/patch sent the reader to sign in, the nav flipped to "Sign in".
 * A route that can answer "try again in a moment" catches this and does.
 */
export class SessionUnavailable extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super('The session could not be looked up.');
    this.name = 'SessionUnavailable';
    this.cause = cause;
  }
}

/* Carries the session row's own id and expiry so renewSession need not
 * fetch the same row a second time. Not part of SessionUser: callers of
 * currentUser have no business with either. */
type SessionRow = SessionUser & { sessionId: string; expiresAt: Date };

/**
 * The session behind the cookie: null for no cookie or no live row, and
 * SessionUnavailable when the database could not be asked.
 *
 * Memoised per request with React's `cache`: the account page, resolveAccess
 * and anything else on the same render all ask, and each ask was a session
 * join against the database in series. Now the first answers for all of them.
 * The memo lives only for the one server request, so revocation is exactly as
 * immediate as it was.
 */
export const lookupSession = cache(async function lookupSession(): Promise<SessionRow | null> {
  let token: string | undefined;
  try {
    token = (await cookies()).get(COOKIE)?.value;
  } catch {
    /* Called outside a request. Nothing to look up; not a fault. */
    return null;
  }
  if (!token) return null;

  let rows: SessionRow[];
  try {
    rows = await db()
      .select({
        id: schema.users.id,
        email: schema.users.email,
        stripeCustomerId: schema.users.stripeCustomerId,
        deviceId: schema.sessions.deviceId,
        sessionId: schema.sessions.id,
        expiresAt: schema.sessions.expiresAt,
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
  } catch (e) {
    throw new SessionUnavailable(e);
  }

  const row = rows[0];
  if (!row) return null;

  // Best-effort activity stamp; never let it fail the request.
  void db().update(schema.sessions)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.sessions.id, row.sessionId))
    .catch(() => {});

  return row;
});

/**
 * The signed-in user, or null. Never throws: when the session cannot be
 * looked up this answers signed out, which is the right call on the billing
 * routes and the account gate, where the alternative is a 500 on the money
 * path. Anything that can say "try again" instead reads lookupSession.
 */
export const currentUser = (): Promise<SessionUser | null> =>
  lookupSession().catch(() => null);

/*
 * SLIDING EXPIRY. A device that keeps coming back should never find itself
 * signed out on the 181st day. Once a session is thirty days into its life,
 * the next visit pushes its expiry out by the full term again and re-issues
 * the same cookie with the new date. Called from a route handler (cookies can
 * only be set there), which /api/me is, and every page load calls that.
 */
const RENEW_AFTER_DAYS = 30;
export async function renewSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return;
  /* The row this request has already fetched; no second lookup of it. */
  const current = await lookupSession().catch(() => null);
  if (!current) return;
  const left = current.expiresAt.getTime() - Date.now();
  if (left > (SESSION_DAYS - RENEW_AFTER_DAYS) * 86_400_000) return;

  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db().update(schema.sessions).set({ expiresAt }).where(eq(schema.sessions.id, current.sessionId));
  jar.set(COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
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
    ip: requestIp(h),
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

  /*
   * ONE TRANSACTION from the burn to the session row. The code is single
   * use, so it is consumed here -- and when the account or session insert
   * after it failed, the code was already gone: the reader saw "something
   * went wrong", retried the same digits, and was told the code was not
   * right. Rolled back together, the same code works on the retry. The
   * cookie is set after the commit, so it never names a session that was
   * not written.
   */
  const h = await headers();
  const minted = await db().transaction(async (tx) => {
    await tx.update(schema.loginTokens)
      .set({ consumedAt: now })
      .where(eq(schema.loginTokens.id, token.id));

    const existing = await tx.select().from(schema.users)
      .where(eq(schema.users.email, email)).limit(1);

    let user = existing[0];
    if (!user) {
      const created = await tx.insert(schema.users).values({
        email,
        emailVerifiedAt: now,
        signupIp: requestIp(h),
        signupUserAgent: h.get('user-agent')?.slice(0, 500) ?? null,
      }).returning();
      user = created[0];
    } else if (!user.emailVerifiedAt) {
      await tx.update(schema.users)
        .set({ emailVerifiedAt: now })
        .where(eq(schema.users.id, user.id));
    }

    const session = await insertSession(user.id, tx);
    return { user, ...session };
  });

  await setSessionCookie(minted.token, minted.expiresAt);
  return {
    id: minted.user.id, email: minted.user.email,
    stripeCustomerId: minted.user.stripeCustomerId, deviceId: minted.deviceId,
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
