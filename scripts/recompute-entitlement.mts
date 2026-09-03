/*
 * Recompute one user's entitlement row from their subscription rows.
 *
 *   npx tsx --conditions=react-server --env-file-if-exists=.env.local scripts/recompute-entitlement.mts <email>
 *
 * Reads nothing from Stripe: it applies the rules the webhook applies, to the
 * rows already synced. For repairing a row after a rule change.
 */
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { recomputeEntitlement } from '../src/lib/billing/sync';
import { normaliseEmail } from '../src/lib/auth';

const email = process.argv[2];
if (!email) {
  console.error('usage: recompute-entitlement.mts <email>');
  process.exit(2);
}
const users = await db().select().from(schema.users)
  .where(eq(schema.users.email, normaliseEmail(email))).limit(1);
if (!users[0]) {
  console.error('no such user');
  process.exit(1);
}
const row = async () => (await db().select().from(schema.entitlements)
  .where(eq(schema.entitlements.userId, users[0].id)).limit(1))[0];
const pick = (r: Awaited<ReturnType<typeof row>>) => r && {
  state: r.state, tier: r.tier, inTrial: r.inTrial, until: r.accessUntil?.toISOString(),
  source: r.sourceSubscriptionId, revokedAt: r.revokedAt?.toISOString() ?? null, reason: r.revokedReason,
};
console.log('before', pick(await row()));
await recomputeEntitlement(users[0].id);
console.log('after ', pick(await row()));
process.exit(0);
