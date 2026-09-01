/*
 * reset-test-data.mts — clear sandbox data before going live.
 *
 * WHY THIS IS NEEDED
 * The database is shared between the sandbox and live Stripe accounts. Rows
 * written while testing point at Stripe objects that exist only in the sandbox,
 * so once the live key is in place any sync or webhook touching them fails
 * against an object Stripe says does not exist. Leaving them also means the
 * first real customer lands in a table already full of fictional subscriptions.
 *
 * WHY IT REFUSES RATHER THAN ASKS NICELY
 * This deletes accounts. If even one subscription looks like it came from live
 * mode, the script stops without touching anything — the cost of wrongly
 * deleting a paying customer is unbounded, and the cost of refusing is that
 * someone reads a message and deletes the row by hand.
 *
 *   npm run db:reset-test           show what would be deleted
 *   npm run db:reset-test -- --yes  actually delete it
 */

import { db, schema } from '../src/db';

const CONFIRM = process.argv.includes('--yes');

/*
 * Every Stripe id embeds the account it belongs to. A live subscription and a
 * sandbox one are therefore distinguishable without asking Stripe, which
 * matters because the key in the environment may already be the live one.
 */
const SANDBOX_MARKER = 'RSQqaEYYDA';

const subs = await db().select().from(schema.subscriptions);
const foreign = subs.filter((s) => !s.stripeSubscriptionId.includes(SANDBOX_MARKER));

console.log('');
if (foreign.length) {
  console.error('  REFUSING TO DELETE.\n');
  console.error(`  ${foreign.length} subscription(s) do not carry the sandbox marker, so they may be`);
  console.error('  real customers:\n');
  for (const s of foreign) console.error(`    ${s.stripeSubscriptionId}  ${s.status}`);
  console.error('\n  Nothing has been changed. Remove them by hand if you are certain.\n');
  process.exit(1);
}

const counts: Record<string, number> = {};
const tables = [
  ['pending_checkouts', schema.pendingCheckouts],
  ['stripe_events', schema.stripeEvents],
  ['patch_jobs', schema.patchJobs],
  ['invoices', schema.invoices],
  ['disputes', schema.disputes],
  ['trial_grants', schema.trialGrants],
  ['consents', schema.consents],
  ['entitlements', schema.entitlements],
  ['subscriptions', schema.subscriptions],
  ['sessions', schema.sessions],
  ['login_tokens', schema.loginTokens],
  ['users', schema.users],
] as const;

for (const [name, table] of tables) {
  const rows = await db().select().from(table);
  counts[name] = rows.length;
}

const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(`  ${subs.length} subscription(s), all sandbox. ${total} rows in scope:\n`);
for (const [k, v] of Object.entries(counts)) if (v) console.log(`    ${k.padEnd(18)} ${v}`);

if (!CONFIRM) {
  console.log('\n  Dry run. Re-run with --yes to delete.\n');
  process.exit(0);
}

// Children first; the foreign keys would mostly cascade, but relying on cascade
// order to be correct is how you find out it is not.
for (const [name, table] of tables) {
  await db().delete(table);
  console.log(`  cleared ${name}`);
}

console.log('\n  Done. The database is empty and ready for the first real customer.\n');
process.exit(0);
