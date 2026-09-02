/*
 * subject-request.mts — honour an access or erasure request.
 *
 * WHY THIS EXISTS
 * The privacy policy promises: "You can ask for a copy of your data, ask us to
 * correct it, or ask us to delete your account... we will respond within 30
 * days." Handling those by hand is legally fine; being UNABLE to handle them is
 * not, and a promise with no mechanism behind it is the same failure as the
 * Terms that once claimed one trial per payment method while nothing enforced
 * it. Thirty days is not long when the answer involves writing SQL under
 * pressure against production.
 *
 *   npm run subject -- export you@example.com
 *   npm run subject -- delete you@example.com
 *   npm run subject -- delete you@example.com --yes
 *
 * WHAT DELETION DELIBERATELY LEAVES BEHIND
 * Consent records and paid invoices are retained, and the policy says so:
 * "Deleting your account does not remove records we must keep for tax purposes
 * or to defend a payment dispute." Erasure rights are not absolute — GDPR
 * Article 17(3) preserves data needed for a legal obligation or for legal
 * claims, and a chargeback can arrive months after an account is gone. Those
 * rows are unlinked from the user instead, so they stop being personal data
 * about an identifiable person while remaining usable as evidence.
 *
 * Stripe is a separate controller for its own records. Deleting here does not
 * delete there; the customer object has to be handled in the Stripe dashboard,
 * and the script says so rather than implying otherwise.
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { normaliseEmail } from '../src/lib/auth';

const [, , action, rawEmail] = process.argv;
const confirmed = process.argv.includes('--yes');

if (!action || !rawEmail || !['export', 'delete'].includes(action)) {
  console.error('\n  npm run subject -- export <email>\n  npm run subject -- delete <email> [--yes]\n');
  process.exit(1);
}

const email = normaliseEmail(rawEmail);
const users = await db().select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
const user = users[0];

if (!user) {
  console.log(`\n  No account for ${email}.`);
  console.log('  That is itself a valid answer to an access request — say so plainly.\n');
  process.exit(0);
}

const uid = user.id;

const [sessions, subs, ents, consents, invoices, jobs, trials, disputes, pending] =
  await Promise.all([
    db().select().from(schema.sessions).where(eq(schema.sessions.userId, uid)),
    db().select().from(schema.subscriptions).where(eq(schema.subscriptions.userId, uid)),
    db().select().from(schema.entitlements).where(eq(schema.entitlements.userId, uid)),
    db().select().from(schema.consents).where(eq(schema.consents.userId, uid)),
    db().select().from(schema.invoices).where(eq(schema.invoices.userId, uid)),
    db().select().from(schema.patchJobs).where(eq(schema.patchJobs.userId, uid)),
    db().select().from(schema.trialGrants).where(eq(schema.trialGrants.userId, uid)),
    db().select().from(schema.disputes).where(eq(schema.disputes.userId, uid)),
    db().select().from(schema.pendingCheckouts).where(eq(schema.pendingCheckouts.userId, uid)),
  ]);

if (action === 'export') {
  /*
   * Session token hashes are omitted. They are credentials, not information
   * about the person, and mailing them to an address that may not be under the
   * requester's control any more would be its own breach.
   */
  const payload = {
    generatedAt: new Date().toISOString(),
    account: {
      email: user.email,
      createdAt: user.createdAt,
      emailVerifiedAt: user.emailVerifiedAt,
      signupIp: user.signupIp,
      stripeCustomerId: user.stripeCustomerId,
    },
    signIns: sessions.map((x) => ({
      createdAt: x.createdAt, lastUsedAt: x.lastUsedAt, ip: x.ip, userAgent: x.userAgent,
      revokedAt: x.revokedAt,
    })),
    subscriptions: subs.map((x) => ({
      plan: x.priceId, status: x.status, currentPeriodEnd: x.currentPeriodEnd,
      firstPaidAt: x.firstPaidAt, canceledAt: x.canceledAt,
    })),
    entitlements: ents,
    agreements: consents.map((x) => ({
      shownAt: x.createdAt, text: x.disclosureText, sha256: x.disclosureSha256,
      ip: x.ip, userAgent: x.userAgent,
    })),
    payments: invoices,
    usage: jobs.map((x) => ({
      at: x.createdAt, status: x.status, ip: x.ip, outputBytes: x.outputLen,
    })),
    trials, disputes,
    pendingCheckouts: pending.map((x) => ({ createdAt: x.createdAt, plan: x.plan })),
  };
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

/* ------------------------------------------------------------------ delete */

console.log(`\n  Erasure request for ${email}\n`);
console.log(`  DELETE   sessions            ${sessions.length}`);
console.log(`  DELETE   subscriptions       ${subs.length}`);
console.log(`  DELETE   entitlements        ${ents.length}`);
console.log(`  DELETE   patch_jobs          ${jobs.length}`);
console.log(`  DELETE   trial_grants        ${trials.length}`);
console.log(`  DELETE   pending_checkouts   ${pending.length}`);
console.log(`  DELETE   users               1`);
console.log('');
console.log(`  UNLINK   consents            ${consents.length}   kept as dispute evidence, user detached`);
console.log(`  UNLINK   invoices            ${invoices.length}   kept for tax, user detached`);
console.log(`  UNLINK   disputes            ${disputes.length}   kept to defend a claim, user detached`);

if (!confirmed) {
  console.log('\n  Dry run. Re-run with --yes to carry it out.\n');
  process.exit(0);
}

// Detach first: the user row is about to go, and these must survive it.
await db().update(schema.consents).set({ userId: null }).where(eq(schema.consents.userId, uid));
await db().update(schema.invoices).set({ userId: null }).where(eq(schema.invoices.userId, uid));
await db().update(schema.disputes).set({ userId: null }).where(eq(schema.disputes.userId, uid));

await db().delete(schema.pendingCheckouts).where(eq(schema.pendingCheckouts.userId, uid));
await db().delete(schema.trialGrants).where(eq(schema.trialGrants.userId, uid));
await db().delete(schema.patchJobs).where(eq(schema.patchJobs.userId, uid));
await db().delete(schema.entitlements).where(eq(schema.entitlements.userId, uid));
await db().delete(schema.subscriptions).where(eq(schema.subscriptions.userId, uid));
await db().delete(schema.sessions).where(eq(schema.sessions.userId, uid));
await db().delete(schema.loginTokens).where(eq(schema.loginTokens.email, email));
await db().delete(schema.users).where(eq(schema.users.id, uid));

console.log('\n  Done.\n');
console.log('  STILL TO DO BY HAND — this script does not touch Stripe:');
console.log(`    1. Cancel any live subscription for ${email}, or they keep being charged.`);
console.log('    2. Delete the Customer in the Stripe dashboard if they asked for that too.');
console.log('       Stripe is a separate controller and keeps its own records for its own');
console.log('       legal obligations; say so in your reply rather than implying otherwise.\n');
process.exit(0);
