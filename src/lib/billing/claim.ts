import 'server-only';

import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db, schema } from '@/db';
import { createSession, issueLoginCode, normaliseEmail } from '@/lib/auth';
import { stripe } from '@/lib/billing/stripe';
import { syncSubscription } from '@/lib/billing/sync';

/*
 * claim.ts — turning a completed anonymous checkout into an account.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * Stripe does not verify that the buyer controls the email address it collects.
 * So "take customer_details.email, find-or-create the user, sign them in" is a
 * complete account takeover for the price of one subscription: type a victim's
 * address into Checkout, pay, receive a session cookie for their account.
 *
 * The claim nonce does not help with that. It proves the same BROWSER started
 * and finished the checkout — not that the person controls the address. Those
 * are different facts and only one of them is an authentication.
 *
 * Therefore:
 *
 *   email had NO account   ->  sign in immediately. Safe because the account is
 *                              born from this payment; there is nothing to steal.
 *
 *   email HAD an account   ->  attach the subscription (the money really is
 *                              theirs) but do NOT mint a session. Send a code.
 *                              redeemLoginCode stays the only thing in this
 *                              codebase that proves control of an address, and
 *                              it stays the only gate onto an existing account.
 *
 * SINGLE USE IS ENFORCED BY THE DATABASE. The claim is a conditional UPDATE
 * with `claimed_at IS NULL` in the WHERE clause, so two racing requests cannot
 * both succeed — a read-then-write would let them.
 */

/*
 * The `__Host-` prefix is enforced by the browser: it refuses the cookie unless
 * it is Secure, path=/, and carries no Domain attribute — so it cannot be set
 * by a subdomain or scoped to a path where it might leak. The session cookie
 * already uses it, and localhost counts as a secure context, so this works in
 * development too.
 */
export const CLAIM_COOKIE = '__Host-pristine_claim';

/** Stripe sessions expire in 30 minutes; the claim outlives that by a margin. */
export const CLAIM_TTL_MS = 45 * 60 * 1000;

export type ClaimOutcome =
  | { status: 'signed_in'; email: string }
  | { status: 'needs_code'; email: string }
  | { status: 'already_signed_in' }
  | { status: 'pending' }
  | { status: 'none' };

/**
 * Find the user for an email, or create one, letting the unique index arbitrate.
 *
 * `emailVerifiedAt` is deliberately NOT set. Stripe collected the address; it
 * did not prove anyone reads it. Marking it verified here would quietly promote
 * an unproven address to a trusted one everywhere else in the system.
 */
export async function findOrCreateUserByEmail(
  rawEmail: string,
  signupIp: string | null,
): Promise<{ id: string; email: string; wasNew: boolean }> {
  const email = normaliseEmail(rawEmail);

  const existing = await db().select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (existing[0]) return { ...existing[0], wasNew: false };

  const inserted = await db().insert(schema.users)
    .values({ email, signupIp })
    .onConflictDoNothing()
    .returning({ id: schema.users.id, email: schema.users.email });

  if (inserted[0]) return { ...inserted[0], wasNew: true };

  // Lost the insert race; the row exists now.
  const again = await db().select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users).where(eq(schema.users.email, email)).limit(1);
  return { ...again[0], wasNew: false };
}

/**
 * Resolve a pending checkout to a user, creating the account if needed.
 *
 * Called by the webhook (authoritative) and again by the claim if the webhook
 * has not landed yet. Idempotent: whichever runs second sees the row already
 * resolved and returns it.
 */
export async function resolvePendingCheckout(
  stripeSessionId: string,
  email: string | null | undefined,
  ip: string | null,
): Promise<{ userId: string; emailWasNew: boolean } | null> {
  const rows = await db().select().from(schema.pendingCheckouts)
    .where(eq(schema.pendingCheckouts.stripeSessionId, stripeSessionId)).limit(1);
  const pending = rows[0];
  if (!pending) return null;

  if (pending.userId) {
    return { userId: pending.userId, emailWasNew: pending.emailWasNew ?? false };
  }
  if (!email) return null;

  const user = await findOrCreateUserByEmail(email, ip);

  await db().update(schema.pendingCheckouts)
    .set({ userId: user.id, emailWasNew: user.wasNew })
    .where(eq(schema.pendingCheckouts.id, pending.id));

  // The consent record is the evidence in a chargeback. An orphaned one, with
  // no user attached, is worth considerably less.
  if (pending.consentId) {
    await db().update(schema.consents)
      .set({ userId: user.id })
      .where(eq(schema.consents.id, pending.consentId));
  }

  return { userId: user.id, emailWasNew: user.wasNew };
}

/**
 * Redeem the claim cookie. Returns what /welcome should tell the user.
 *
 * `alreadySignedIn` short-circuits the whole thing: a signed-in buyer is already
 * authenticated and nothing here should touch their session.
 */
export async function claimCheckout(
  nonce: string | undefined,
  alreadySignedIn: boolean,
  ip: string | null,
): Promise<ClaimOutcome> {
  if (!nonce) return { status: alreadySignedIn ? 'already_signed_in' : 'none' };

  const nonceHash = await sha256Hex(nonce);

  /*
   * Claim and mark in one statement. `claimed_at IS NULL` in the WHERE is what
   * makes this single-use under concurrency; checking first and updating after
   * would let two requests both pass the check.
   */
  const claimed = await db().update(schema.pendingCheckouts)
    .set({ claimedAt: new Date() })
    .where(and(
      eq(schema.pendingCheckouts.nonceHash, nonceHash),
      isNull(schema.pendingCheckouts.claimedAt),
      gt(schema.pendingCheckouts.expiresAt, new Date()),
    ))
    .returning();

  const pending = claimed[0];
  if (!pending) return { status: alreadySignedIn ? 'already_signed_in' : 'none' };

  // Retrieve by the STORED id, never one supplied by the caller.
  const session = await stripe().checkout.sessions.retrieve(pending.stripeSessionId);
  if (session.status !== 'complete') {
    // Paid later, or abandoned. Release the claim so a genuine return can use it.
    await db().update(schema.pendingCheckouts)
      .set({ claimedAt: null })
      .where(eq(schema.pendingCheckouts.id, pending.id));
    return { status: 'pending' };
  }

  const resolved = await resolvePendingCheckout(
    pending.stripeSessionId,
    session.customer_details?.email,
    ip,
  );
  if (!resolved) return { status: 'pending' };

  const subId = typeof session.subscription === 'string'
    ? session.subscription
    : session.subscription?.id;
  if (subId) {
    // Do not let a slow or failed sync lose the sign-in; the webhook will retry.
    try { await syncSubscription(subId, new Date()); } catch { /* webhook covers it */ }
  }

  const email = session.customer_details?.email ?? '';

  if (alreadySignedIn) return { status: 'already_signed_in' };

  if (resolved.emailWasNew) {
    await createSession(resolved.userId);
    return { status: 'signed_in', email };
  }

  /*
   * The address already had an account. The subscription is attached above —
   * they did pay for it — but signing them in here would mean anyone who knows
   * an address can buy their way into it.
   */
  await issueLoginCode(email);
  return { status: 'needs_code', email };
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Rows nobody came back for. Called opportunistically, never on a hot path. */
export async function sweepExpiredClaims(): Promise<void> {
  await db().delete(schema.pendingCheckouts)
    .where(and(
      isNull(schema.pendingCheckouts.userId),
      sql`${schema.pendingCheckouts.expiresAt} < now() - interval '7 days'`,
    ));
}
