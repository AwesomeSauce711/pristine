/*
 * annual-renewal-notices.mts — the one renewal notice the law requires.
 *
 *   npm run renewal:notices          (daily, from the cron service; see docs/canary-on-railway.md)
 *   npm run renewal:notices -- --dry (show who would be emailed, send nothing)
 *
 * A subscription with a term of a year or more must be told, 15 to 45 days
 * before it renews, that it will renew, when, for how much, and how to
 * cancel. This emails each Annual subscriber once per term, 15 to 31 days
 * out, and records the term it was sent for so a rerun -- or a run every
 * hour -- sends nothing twice. Weekly and Monthly get no reminder.
 */
import { and, eq, gt, lt, or, isNull, ne } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { planForPriceId } from '../src/lib/billing/stripe';
import { sendAnnualRenewalNotice } from '../src/lib/email';
import { PLANS } from '../src/lib/plans';

const dry = process.argv.includes('--dry');
const now = Date.now();
const soonest = new Date(now + 15 * 86_400_000);
const latest = new Date(now + 31 * 86_400_000);

const due = await db().select({
  id: schema.subscriptions.stripeSubscriptionId,
  userId: schema.subscriptions.userId,
  priceId: schema.subscriptions.priceId,
  periodEnd: schema.subscriptions.currentPeriodEnd,
  noticeFor: schema.subscriptions.renewalNoticeFor,
  email: schema.users.email,
})
  .from(schema.subscriptions)
  .innerJoin(schema.users, eq(schema.users.id, schema.subscriptions.userId))
  .where(and(
    eq(schema.subscriptions.status, 'active'),
    eq(schema.subscriptions.cancelAtPeriodEnd, false),
    gt(schema.subscriptions.currentPeriodEnd, soonest),
    lt(schema.subscriptions.currentPeriodEnd, latest),
    or(isNull(schema.subscriptions.renewalNoticeFor), ne(schema.subscriptions.renewalNoticeFor, schema.subscriptions.currentPeriodEnd)),
  ));

let sent = 0;
for (const s of due) {
  const plan = planForPriceId(s.priceId);
  if (plan !== 'year' || !s.periodEnd) continue;
  if (dry) { console.log(`would email ${s.email} for ${s.id}, renews ${s.periodEnd.toISOString()}`); continue; }
  await sendAnnualRenewalNotice(s.email, { planName: PLANS.year.name, amountCents: PLANS.year.amount, renewsOn: s.periodEnd });
  await db().update(schema.subscriptions)
    .set({ renewalNoticeFor: s.periodEnd })
    .where(eq(schema.subscriptions.stripeSubscriptionId, s.id));
  sent++;
  console.log(`notice sent for ${s.id}, renews ${s.periodEnd.toISOString()}`);
}
console.log(`${dry ? 'dry run: ' : ''}${due.length} in the window, ${sent} sent`);
process.exit(0);
