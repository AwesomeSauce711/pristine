import 'server-only';

import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';

/*
 * method-status.ts — the kill switch.
 *
 * WHY THIS EXISTS
 * The product works because of how TikTok processes uploads. TikTok can change
 * that whenever they like, with no notice, and the first sign will be customers
 * reporting compressed uploads. Selling a subscription to something that is
 * confirmed not to work is what turns into refunds and disputes (Stripe acts on
 * accounts above roughly 0.75% disputes), so the ability to stop selling has to
 * be faster than a deploy.
 *
 * THE THREE STATES, AND WHY THE MIDDLE ONE EXISTS
 *   ok        Normal.
 *   degraded  Something is wrong but not proven broken — one report, an
 *             unconfirmed change, a canary that failed once. Say so on the
 *             site; keep selling and keep everyone working. A hunch should
 *             cost nothing, which is why this state changes nothing but the
 *             banner.
 *   broken    Confirmed not working. Stop taking NEW money and say so; the
 *             book is left exactly as it is. Subscriptions are never paused or
 *             cancelled by the switch: the Terms promise a fast fix, continued
 *             access that resumes on its own, and a credit of time lost past
 *             fourteen days. Pausing collection is a separate, deliberate
 *             command in scripts/method-status.mts for the case where a fix is
 *             not coming.
 *
 * WHY IT NEVER FAILS CLOSED
 * A database blip must not take the shop offline. If the flag cannot be read the
 * answer is 'ok', because the cost of wrongly believing things are fine for
 * thirty seconds is far lower than the cost of a transient error blocking every
 * checkout on the site. The flag is a deliberate human action, not a health
 * check — the canary informs the human, it does not flip the switch.
 */

export type MethodStatus = 'ok' | 'degraded' | 'broken';

export const METHOD_STATUS_KEY = 'method_status';

export interface MethodState {
  status: MethodStatus;
  /** Shown to customers verbatim when set. Keep it plain and specific. */
  note: string | null;
}

const OK: MethodState = { status: 'ok', note: null };

/*
 * Cached briefly. This is read on most page renders and on every checkout, and
 * a flag that changes a few times a year does not need a query each time. Thirty
 * seconds is short enough that flipping the switch feels immediate and long
 * enough that the query disappears from the profile.
 *
 * Per-instance, so on serverless the worst case is one stale instance for thirty
 * seconds, which is acceptable for stopping sales.
 */
let cache: { at: number; state: MethodState } | null = null;
const TTL_MS = 30_000;

export async function methodStatus(): Promise<MethodState> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.state;

  try {
    const rows = await db().select()
      .from(schema.settings)
      .where(eq(schema.settings.key, METHOD_STATUS_KEY))
      .limit(1);

    const raw = rows[0]?.value;
    const status: MethodStatus =
      raw === 'degraded' || raw === 'broken' ? raw : 'ok';

    const state: MethodState = { status, note: rows[0]?.note ?? null };
    cache = { at: Date.now(), state };
    return state;
  } catch {
    // Never let an unreadable flag close the shop. See the note above.
    return OK;
  }
}

/** Whether new subscriptions may be sold right now: only a confirmed break closes the shop. */
export async function sellingIsOpen(): Promise<boolean> {
  return (await methodStatus()).status !== 'broken';
}

/** Drop the cache, so a change made by the script is visible immediately. */
export function forgetMethodStatus(): void {
  cache = null;
}
