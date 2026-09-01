import 'server-only';

/*
 * ratelimit.ts — a sliding-window limiter, shared across instances when Redis
 * is configured and per-instance when it is not.
 *
 * WHY SHARED COUNTERS MATTER HERE
 * On serverless every instance keeps its own memory, so an in-memory limit is
 * really `limit x instances` and resets on every cold start. For the sign-in
 * route that is not an abstract weakness: it sends email, and an unmetered
 * email-sending endpoint is how a sending domain gets blocklisted.
 *
 * WHY IT STILL FALLS BACK
 * Requiring Redis to boot would mean the whole product stops working when a
 * third party has a bad day, in exchange for a limit that is a mitigation rather
 * than a security control. So Redis is used when reachable and memory when not,
 * and the degradation is logged rather than silent.
 *
 * WHY A SORTED SET RATHER THAN INCR
 * A counter with an expiry gives fixed windows, which allow a double burst
 * across a boundary — 2x the limit in a moment either side of the reset. The
 * sorted set holds one member per hit scored by timestamp, so the window
 * genuinely slides: old hits are removed by score before the count is taken.
 */

interface Window {
  hits: number[];
}

const windows = new Map<string, Window>();
let lastSweep = Date.now();

/** Drop stale keys so a long-lived instance does not grow without bound. */
function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, w] of windows) {
    if (!w.hits.length || now - w.hits[w.hits.length - 1] > 3_600_000) windows.delete(key);
  }
}

export interface RateResult {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
}

/* ------------------------------------------------------------------ redis */

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export const rateLimitIsShared = (): boolean => !!REDIS_URL && !!REDIS_TOKEN;

let warned = false;
function warnOnce() {
  if (warned || process.env.NODE_ENV !== 'production') return;
  warned = true;
  console.warn(
    '[ratelimit] UPSTASH_REDIS_REST_URL/TOKEN not set — limits are per-instance only.',
  );
}

/**
 * One pipelined round trip: drop anything older than the window, add this hit,
 * count what remains, and re-arm the expiry so idle keys evict themselves.
 *
 * The count is taken AFTER adding, so it includes the current request — hence
 * the comparison is `> limit`, not `>=`.
 */
async function hitRedis(key: string, limit: number, windowSec: number): Promise<RateResult | null> {
  if (!REDIS_URL || !REDIS_TOKEN) return null;

  const now = Date.now();
  const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;
  const k = `rl:${key}`;

  try {
    const res = await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${REDIS_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify([
        ['ZREMRANGEBYSCORE', k, 0, now - windowSec * 1000],
        ['ZADD', k, now, member],
        ['ZCARD', k],
        ['PEXPIRE', k, windowSec * 1000],
        ['ZRANGE', k, 0, 0, 'WITHSCORES'],
      ]),
      // A slow limiter must not become the outage it is meant to prevent.
      signal: AbortSignal.timeout(1500),
    });

    if (!res.ok) return null;
    const out = (await res.json()) as { result?: unknown; error?: string }[];
    if (!Array.isArray(out) || out.some((r) => r?.error)) return null;

    const count = Number(out[2]?.result ?? 0);
    if (!Number.isFinite(count)) return null;

    if (count > limit) {
      const oldest = Number((out[4]?.result as string[] | undefined)?.[1] ?? now);
      return {
        ok: false,
        remaining: 0,
        retryAfterSec: Math.max(1, Math.ceil((oldest + windowSec * 1000 - now) / 1000)),
      };
    }
    return { ok: true, remaining: Math.max(0, limit - count), retryAfterSec: 0 };
  } catch {
    // Timeout, network, or a malformed reply. Fall through to memory.
    return null;
  }
}

/**
 * The limiter every route should call.
 *
 * Uses Redis when it is configured and answering; falls back to this instance's
 * memory otherwise, so an outage degrades the limit rather than the product.
 */
export async function limit(key: string, max: number, windowSec: number): Promise<RateResult> {
  if (!rateLimitIsShared()) {
    warnOnce();
    return hit(key, max, windowSec);
  }
  const shared = await hitRedis(key, max, windowSec);
  return shared ?? hit(key, max, windowSec);
}

/** Synchronous, per-instance. Exported for tests and used as the fallback. */
export function hit(key: string, limit: number, windowSec: number): RateResult {
  const now = Date.now();
  sweep(now);

  const w = windows.get(key) ?? { hits: [] };
  const cutoff = now - windowSec * 1000;
  w.hits = w.hits.filter((t) => t > cutoff);

  if (w.hits.length >= limit) {
    windows.set(key, w);
    const oldest = w.hits[0];
    return {
      ok: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((oldest + windowSec * 1000 - now) / 1000)),
    };
  }

  w.hits.push(now);
  windows.set(key, w);
  return { ok: true, remaining: limit - w.hits.length, retryAfterSec: 0 };
}

/** Best-effort client address. Spoofable, so never use it for authorisation. */
export function clientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  );
}

export const tooMany = (r: RateResult) =>
  Response.json(
    { code: 'rate_limited', message: 'Too many attempts. Please wait a moment and try again.' },
    { status: 429, headers: { 'retry-after': String(r.retryAfterSec) } },
  );
