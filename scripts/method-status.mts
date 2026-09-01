/*
 * method-status.mts — flip the kill switch.
 *
 *   npm run method:status                        show the current state
 *   npm run method:status -- degraded "reason"   stop new sales, keep subscribers working
 *   npm run method:status -- broken "reason"     as above, and offer to pause all billing
 *   npm run method:status -- ok                  back to normal (and resume billing)
 *
 * WHY PAUSE RATHER THAN CANCEL
 * `pause_collection` with behavior 'void' stops invoices being created without
 * ending anyone's subscription. Cancelling instead would destroy the book: every
 * customer would have to be re-sold, and the ones who would have waited a week
 * for a fix are gone. Pausing is reversible in one command; cancelling is not
 * reversible at all.
 *
 * WHY THE STRIPE HALF IS INTERACTIVE
 * Pausing collection across the whole book is not something to do by accident,
 * and it is the one action here that touches money. It asks first, prints the
 * count, and does nothing without a typed confirmation.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import Stripe from 'stripe';
import { db, schema } from '../src/db';
import { METHOD_STATUS_KEY, type MethodStatus } from '../src/lib/method-status';

const VALID: MethodStatus[] = ['ok', 'degraded', 'broken'];

const [, , rawStatus, rawNote] = process.argv;

async function show() {
  const rows = await db().select().from(schema.settings);
  const row = rows.find((r) => r.key === METHOD_STATUS_KEY);
  const status = (row?.value as MethodStatus) ?? 'ok';
  console.log(`\n  method status : ${status.toUpperCase()}`);
  if (row?.note) console.log(`  note          : ${row.note}`);
  if (row?.updatedAt) console.log(`  changed       : ${row.updatedAt.toISOString()}`);
  console.log(`\n  selling is ${status === 'ok' ? 'OPEN' : 'PAUSED'}\n`);
}

async function confirm(question: string): Promise<boolean> {
  /*
   * With no terminal attached there is nobody to answer, and waiting forever is
   * the worst of the three options — it looks like a hang and leaves the flag
   * half-applied. Declining is safe in both directions: the site has already
   * stopped selling, and billing is left exactly as it was.
   */
  if (!stdin.isTTY) {
    console.log(`${question} (no terminal attached — skipping; run this from a shell to confirm)`);
    return false;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(`${question} type "yes" to continue: `);
  rl.close();
  return answer.trim().toLowerCase() === 'yes';
}

/** Pause or resume collection on every subscription that is still live. */
async function setCollection(pause: boolean) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.log('\n  STRIPE_SECRET_KEY is not set — skipping the billing half.');
    console.log('  The site has stopped selling, but existing subscriptions will still be charged.\n');
    return;
  }
  const stripe = new Stripe(key);

  const subs: Stripe.Subscription[] = [];
  for await (const s of stripe.subscriptions.list({ status: 'all', limit: 100 })) {
    if (s.status === 'active' || s.status === 'trialing' || s.status === 'past_due') subs.push(s);
  }

  if (!subs.length) {
    console.log('\n  no live subscriptions to change.\n');
    return;
  }

  const live = key.startsWith('sk_test_') ? 'TEST' : 'LIVE';
  console.log(`\n  ${live} mode: ${subs.length} live subscription(s) would be ${pause ? 'PAUSED' : 'RESUMED'}.`);
  if (!(await confirm(pause ? '  Stop billing all of them?' : '  Start billing all of them again?'))) {
    console.log('  left alone.\n');
    return;
  }

  let done = 0;
  for (const s of subs) {
    try {
      await stripe.subscriptions.update(s.id, {
        // 'void' means invoices for the paused period are never owed. 'keep_as_draft'
        // would quietly accumulate a bill to hand someone the day it resumes,
        // which is precisely the surprise charge that becomes a dispute.
        pause_collection: pause ? { behavior: 'void' } : null,
      });
      done++;
    } catch (e) {
      console.error(`  ! ${s.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`  ${done}/${subs.length} updated.\n`);
}

if (!rawStatus) {
  await show();
  process.exit(0);
}

if (!VALID.includes(rawStatus as MethodStatus)) {
  console.error(`\n  Unknown status "${rawStatus}". Use one of: ${VALID.join(', ')}\n`);
  process.exit(1);
}

const status = rawStatus as MethodStatus;
const note = rawNote?.trim() || null;

await db().insert(schema.settings)
  .values({ key: METHOD_STATUS_KEY, value: status, note, updatedAt: new Date() })
  .onConflictDoUpdate({
    target: schema.settings.key,
    set: { value: status, note, updatedAt: new Date() },
  });

console.log(`\n  method status set to ${status.toUpperCase()}`);
if (note) console.log(`  note: ${note}`);
console.log(status === 'ok'
  ? '  new subscriptions are open again.'
  : '  new subscriptions are now refused; existing customers keep working.');

if (status === 'broken') await setCollection(true);
if (status === 'ok') await setCollection(false);

process.exit(0);
