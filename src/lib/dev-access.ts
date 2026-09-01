import 'server-only';

/*
 * dev-access.ts — a one-click unlock, for development only.
 *
 * WHY THIS EXISTS
 * The paywall is real and denies by default, which is correct but means the
 * whole second half of the product — download, quota display, account state —
 * is unreachable until Stripe and a database are configured. This makes the
 * finished flow inspectable before any of that exists.
 *
 * WHY IT CANNOT LEAK INTO PRODUCTION
 * Three independent guards, all of which must pass:
 *
 *   1. `NODE_ENV !== 'production'`. A production build fails this outright, and
 *      it is set by the framework rather than by configuration, so it cannot be
 *      switched on by an environment mistake.
 *   2. `PRISTINE_DEV_UNLOCK=1` must be set explicitly. Absent by default,
 *      absent from `.env.example`'s production section, and named so that
 *      finding it in a deployed environment is obviously wrong.
 *   3. The caller must hold the unlock cookie, which only the dev-only route
 *      can set — and that route applies guards 1 and 2 again before setting it.
 *
 * Any one of the three failing denies. The failure mode of getting this wrong
 * is giving the product away, so it is deliberately over-guarded rather than
 * clever.
 *
 * It also short-circuits BEFORE any database call, so the entire flow works
 * with no Postgres at all.
 */

export const DEV_UNLOCK_COOKIE = 'pristine_dev_unlock';

/** Is the dev unlock mechanism available at all in this process? */
export function devUnlockAvailable(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.PRISTINE_DEV_UNLOCK === '1';
}

/**
 * A synthetic user for the unlocked session.
 *
 * The id is a fixed, obviously-fake UUID rather than a random one, so anything
 * that does reach a database while unlocked is easy to spot and delete.
 */
export const DEV_USER = {
  id: '00000000-0000-4000-8000-00000000dev0',
  email: 'dev@localhost',
  stripeCustomerId: null as string | null,
  deviceId: 'devdevdevdevdev0' as string | null,
};
