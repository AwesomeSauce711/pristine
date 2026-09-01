/*
 * disputes.mts — read and act on chargebacks.
 *
 *   npm run disputes                 list open disputes and their deadlines
 *   npm run disputes -- <id>         print the assembled evidence for review
 *   npm run disputes -- <id> submit  submit it (final — Stripe allows no revision)
 *
 * The draft is written automatically when the dispute opens, so this exists to
 * READ it before the deadline, not to create it. Stripe submits whatever draft
 * is present when the deadline passes, so doing nothing is a valid outcome —
 * this is the chance to add something a script could not know.
 */

import { desc, isNull } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { assembleEvidence, saveEvidence } from '../src/lib/billing/dispute-evidence';

const [, , id, action] = process.argv;

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const days = (d: Date | null) =>
  d ? Math.round((d.getTime() - Date.now()) / 86_400_000) : null;

if (!id) {
  const rows = await db().select().from(schema.disputes)
    .where(isNull(schema.disputes.closedAt))
    .orderBy(desc(schema.disputes.openedAt));

  if (!rows.length) {
    console.log('\n  No open disputes.\n');
    process.exit(0);
  }

  console.log(`\n  ${rows.length} open dispute(s)\n`);
  for (const d of rows) {
    const left = days(d.evidenceDueBy);
    console.log(`  ${d.stripeDisputeId}`);
    console.log(`    ${money(d.amountCents)}  ${d.reason ?? 'no reason given'}  status ${d.status}`);
    console.log(`    opened ${d.openedAt.toISOString().slice(0, 10)}` +
      (left === null ? '' : `  evidence due in ${left} day(s)`) +
      (d.evidenceSubmittedAt ? '  [SUBMITTED]' : '  [draft saved, not submitted]'));
    console.log('');
  }
  console.log('  npm run disputes -- <id>         to read the evidence');
  console.log('  npm run disputes -- <id> submit  to submit it\n');
  process.exit(0);
}

if (action === 'submit') {
  const result = await saveEvidence(id, true);
  if (!result) { console.error(`\n  No dispute ${id} in the database.\n`); process.exit(1); }
  console.log(`\n  Submitted evidence for ${id}. Stripe will not accept revisions.\n`);
  process.exit(0);
}

const e = await assembleEvidence(id);
if (!e) { console.error(`\n  No dispute ${id} in the database.\n`); process.exit(1); }

console.log(`\n  EVIDENCE FOR ${id}\n`);
for (const [k, v] of Object.entries(e.fields)) {
  console.log(`  ── ${k} ${'─'.repeat(Math.max(0, 60 - k.length))}`);
  console.log(v.split('\n').map((l) => `  ${l}`).join('\n'));
  console.log('');
}

if (e.gaps.length) {
  console.log('  WEAKNESSES IN THIS RESPONSE');
  for (const g of e.gaps) console.log(`    - ${g}`);
  console.log('');
}

console.log('  This is a DRAFT. Stripe submits it automatically at the deadline.');
console.log(`  To submit now:  npm run disputes -- ${id} submit\n`);
process.exit(0);
