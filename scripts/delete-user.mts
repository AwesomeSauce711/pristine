/*
 * Delete one account by email, with everything that hangs off it (sessions,
 * subscriptions, entitlement, trial grant; invoices and disputes keep their
 * rows with the user reference cleared). For removing a test account.
 *
 *   npx tsx --conditions=react-server --env-file-if-exists=.env.local scripts/delete-user.mts <email> --yes
 */
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { normaliseEmail } from '../src/lib/auth';

const email = process.argv[2];
const yes = process.argv.includes('--yes');
if (!email) { console.error('usage: delete-user.mts <email> --yes'); process.exit(2); }
const users = await db().select().from(schema.users).where(eq(schema.users.email, normaliseEmail(email))).limit(1);
if (!users[0]) { console.error('no such user'); process.exit(1); }
const subs = await db().select({ id: schema.subscriptions.stripeSubscriptionId, status: schema.subscriptions.status })
  .from(schema.subscriptions).where(eq(schema.subscriptions.userId, users[0].id));
console.log('user', users[0].id, 'subscriptions', subs);
if (subs.some((s) => s.id.startsWith('sub_') && !/test/i.test(process.env.STRIPE_SECRET_KEY ?? ''))) {
  console.error('refusing: the configured Stripe key is not a test key');
  process.exit(1);
}
if (!yes) { console.log('dry run; pass --yes to delete'); process.exit(0); }
await db().delete(schema.users).where(eq(schema.users.id, users[0].id));
console.log('deleted');
process.exit(0);
