import 'server-only';

import { cookies } from 'next/headers';
import { and, count, eq, gt, isNull, sql } from 'drizzle-orm';
import { db, schema } from '@/db';
import { currentUser, type SessionUser } from '@/lib/auth';
import { DEV_UNLOCK_COOKIE, DEV_USER, devUnlockAvailable } from '@/lib/dev-access';
import { PLANS } from '@/lib/plans';

/*
 * entitlement.ts — "is this request allowed to patch a file, right now?"
 *
 * THE RULE: this is the only place that answers that question, it runs on the
 * server, and nothing the browser sends can influence it. The client keeps a
 * copy of the answer to decide what to render; that copy is never trusted for
 * access.
 *
 * WHY THIS READS A LOCAL ROW AND NEVER CALLS STRIPE
 * Entitlement is computed at WRITE time by the webhook handler and denormalised
 * into one row per user. Two consequences worth having:
 *
 *   1. If Stripe is down, paying customers are unaffected. Checking entitlement
 *      by calling their API would make their outage our outage.
 *   2. The money endpoint stays a single indexed read.
 *
 * `users.blocked_at` is deliberately NOT consulted here. Blocking a user must
 * also write `entitlements.revoked_at` in the same transaction — see the dispute
 * handler — so that this one query stays authoritative and cannot drift out of
 * step with a second source of truth.
 */

export type Denial =
  | 'not_signed_in'
  | 'no_subscription'
  | 'expired'
  | 'revoked'
  | 'daily_quota'
  | 'period_quota';

export interface Access {
  ok: boolean;
  denial?: Denial;
  user?: SessionUser;
  state: string;
  accessUntil: Date | null;
  tier: string | null;
  /** Remaining patches in the rolling 24h window. */
  dailyRemaining: number;
  /** The plan's own cap, so the UI can say what a refill adds. */
  dailyCap?: number;
  /** Extra patches bought in the last 24 hours. */
  refillsToday?: number;
  /** Remaining patches in the current billing period. */
  periodRemaining: number;
  /** When the daily window frees up again. */
  resetsAt: Date | null;
}

const DENIED = (denial: Denial): Access => ({
  ok: false,
  denial,
  state: 'none',
  accessUntil: null,
  tier: null,
  dailyRemaining: 0,
  periodRemaining: 0,
  resetsAt: null,
});

/**
 * Resolve access for the current request.
 *
 * Quotas are counted here rather than trusted from a counter column, because a
 * counter can drift and a drifted counter either gives the product away or
 * locks out a customer. Counting rows is exact, and the index on
 * `(user_id, created_at)` makes it cheap.
 */
/*
 * Anything that can run a select: the database handle, or a transaction, so
 * the patch route can re-count the quota INSIDE the lock it holds while it
 * reserves a credit -- on the same connection, which is what makes the
 * count and the reservation one atomic step.
 */
type DbReader = Pick<ReturnType<typeof db>, 'select'>;

export async function resolveAccess(exec: DbReader = db()): Promise<Access> {
  /*
   * Development unlock, checked first so the whole flow works with no database
   * and no Stripe. Guarded three ways in dev-access.ts and impossible in a
   * production build — see the note there.
   */
  if (devUnlockAvailable()) {
    const jar = await cookies();
    if (jar.get(DEV_UNLOCK_COOKIE)?.value === '1') {
      const plan = PLANS.month;
      return {
        ok: true,
        user: DEV_USER,
        state: 'active',
        accessUntil: new Date(Date.now() + 30 * 86_400_000),
        tier: 'month',
        dailyRemaining: plan.dailyPatchCap,
        periodRemaining: plan.periodPatchCap,
        resetsAt: null,
      };
    }
  }

  const user = await currentUser();
  if (!user) return DENIED('not_signed_in');

  const rows = await exec
    .select()
    .from(schema.entitlements)
    .where(and(
      eq(schema.entitlements.userId, user.id),
      isNull(schema.entitlements.revokedAt),
      gt(schema.entitlements.accessUntil, new Date()),
    ))
    .limit(1);

  const ent = rows[0];
  if (!ent) {
    // Distinguish "never subscribed" from "was revoked", because the two need
    // very different messages: one is a sales page, the other is support.
    const any = await exec.select({ state: schema.entitlements.state })
      .from(schema.entitlements)
      .where(eq(schema.entitlements.userId, user.id)).limit(1);
    if (any[0]?.state === 'revoked') return { ...DENIED('revoked'), user };
    if (any[0]) return { ...DENIED('expired'), user };
    return { ...DENIED('no_subscription'), user };
  }

  const since = new Date(Date.now() - 86_400_000);
  const [daily] = await exec.select({ n: count() }).from(schema.patchJobs)
    .where(and(
      eq(schema.patchJobs.userId, user.id),
      eq(schema.patchJobs.countsAgainstQuota, true),
      gt(schema.patchJobs.createdAt, since),
    ));

  const [period] = await exec.select({ n: count() }).from(schema.patchJobs)
    .where(and(
      eq(schema.patchJobs.userId, user.id),
      eq(schema.patchJobs.countsAgainstQuota, true),
      ent.periodStartedAt
        ? gt(schema.patchJobs.createdAt, ent.periodStartedAt)
        : sql`true`,
    ));

  /*
   * Refills. Each one adds the plan's daily cap for 24 hours from purchase,
   * and the same again to the period, so a customer who has bought one is
   * never stopped by the period cap for having used the day's.
   */
  const [refillDay] = await exec.select({ n: sql<number>`coalesce(sum(${schema.patchRefills.count}), 0)` })
    .from(schema.patchRefills)
    .where(and(
      eq(schema.patchRefills.userId, user.id),
      sql`${schema.patchRefills.revokedAt} is null`,
      gt(schema.patchRefills.createdAt, since),
    ));
  const [refillPeriod] = await exec.select({ n: sql<number>`coalesce(sum(${schema.patchRefills.count}), 0)` })
    .from(schema.patchRefills)
    .where(and(
      eq(schema.patchRefills.userId, user.id),
      sql`${schema.patchRefills.revokedAt} is null`,
      ent.periodStartedAt ? gt(schema.patchRefills.createdAt, ent.periodStartedAt) : sql`true`,
    ));

  /* The window is rolling: the day's allowance comes back 24 hours after the
   * earliest patch still inside it. That instant is the reset the UI counts
   * down to; with nothing used there is nothing to reset. */
  const [first] = await exec.select({ at: sql<string | null>`min(${schema.patchJobs.createdAt})` })
    .from(schema.patchJobs)
    .where(and(
      eq(schema.patchJobs.userId, user.id),
      eq(schema.patchJobs.countsAgainstQuota, true),
      gt(schema.patchJobs.createdAt, since),
    ));
  const resetsAt = first?.at ? new Date(new Date(first.at).getTime() + 86_400_000) : null;

  const dailyRemaining = remainingWithRefills(ent.dailyPatchCap, Number(daily?.n ?? 0), Number(refillDay?.n ?? 0));
  const periodRemaining = remainingWithRefills(ent.periodPatchCap, Number(period?.n ?? 0), Number(refillPeriod?.n ?? 0));

  const base: Access = {
    ok: true,
    user,
    state: ent.state,
    accessUntil: ent.accessUntil,
    tier: ent.tier,
    dailyRemaining,
    periodRemaining,
    dailyCap: ent.dailyPatchCap,
    refillsToday: Number(refillDay?.n ?? 0),
    resetsAt,
  };

  if (dailyRemaining <= 0) return { ...base, ok: false, denial: 'daily_quota' };
  if (periodRemaining <= 0) return { ...base, ok: false, denial: 'period_quota' };
  return base;
}

/** Human-facing reason, safe to show as-is. */
/**
 * What is left of an allowance once refills are counted. Pure, and pinned by
 * scripts/verify-refill.mts: a refill adds exactly the cap it was bought
 * against, never goes negative, and never subtracts.
 */
export function remainingWithRefills(cap: number, used: number, refills: number): number {
  return Math.max(0, cap + Math.max(0, refills) - Math.max(0, used));
}

export function denialMessage(d: Denial): string {
  switch (d) {
    case 'not_signed_in':
      return 'Sign in to download your patched file.';
    case 'no_subscription':
      return 'A subscription is needed to download patched files.';
    case 'expired':
      return 'Your subscription has ended. Renew to keep downloading.';
    case 'revoked':
      return 'There is a payment problem on this account. Please contact support.';
    case 'daily_quota':
      return "You've used today's allowance. It comes back 24 hours after your earliest patch today.";
    case 'period_quota':
      return "You've used every patch in this billing period.";
  }
}

/** HTTP status for a denial. 402 means "pay"; 429 means "wait". */
export const denialStatus = (d: Denial): number =>
  d === 'not_signed_in' ? 401
    : d === 'daily_quota' || d === 'period_quota' ? 429
      : 402;
