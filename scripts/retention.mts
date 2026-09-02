/*
 * retention.mts — delete what we said we would delete.
 *
 * The privacy policy states "Usage records are kept for 12 months" and
 * "Sessions expire after 30 days". Both were true as intentions and false as
 * facts: nothing deleted a patch_jobs row, ever, and expired sessions stayed in
 * the table indefinitely.
 *
 * A retention promise with no job behind it is the same class of problem as a
 * Terms page promising a control nobody implemented. It is also the easier one
 * to get right, because it is a scheduled DELETE.
 *
 *   npm run retention           show what is over its stated life
 *   npm run retention -- --yes  delete it
 */

import { and, isNull, lt, sql } from 'drizzle-orm';
import { db, schema } from '../src/db';

const confirmed = process.argv.includes('--yes');
const ago = (days: number) => new Date(Date.now() - days * 86_400_000);

const USAGE_DAYS = 365;    // "Usage records are kept for 12 months"
const SESSION_DAYS = 90;   // expire at 30; kept a little longer for abuse review
const TOKEN_DAYS = 30;     // sign-in codes are useless within minutes

const oldJobs = await db().select().from(schema.patchJobs)
  .where(lt(schema.patchJobs.createdAt, ago(USAGE_DAYS)));
const oldSessions = await db().select().from(schema.sessions)
  .where(lt(schema.sessions.expiresAt, ago(SESSION_DAYS)));
const oldTokens = await db().select().from(schema.loginTokens)
  .where(lt(schema.loginTokens.expiresAt, ago(TOKEN_DAYS)));
const staleClaims = await db().select().from(schema.pendingCheckouts)
  .where(and(isNull(schema.pendingCheckouts.userId),
    sql`${schema.pendingCheckouts.expiresAt} < now() - interval '7 days'`));

console.log('\n  over their stated retention:\n');
console.log(`    patch_jobs         ${oldJobs.length}\tolder than ${USAGE_DAYS} days`);
console.log(`    sessions           ${oldSessions.length}\texpired over ${SESSION_DAYS} days ago`);
console.log(`    login_tokens       ${oldTokens.length}\texpired over ${TOKEN_DAYS} days ago`);
console.log(`    pending_checkouts  ${staleClaims.length}\tabandoned, never claimed`);

const total = oldJobs.length + oldSessions.length + oldTokens.length + staleClaims.length;
if (!total) { console.log('\n  Nothing to delete.\n'); process.exit(0); }
if (!confirmed) { console.log('\n  Dry run. Re-run with --yes.\n'); process.exit(0); }

await db().delete(schema.patchJobs).where(lt(schema.patchJobs.createdAt, ago(USAGE_DAYS)));
await db().delete(schema.sessions).where(lt(schema.sessions.expiresAt, ago(SESSION_DAYS)));
await db().delete(schema.loginTokens).where(lt(schema.loginTokens.expiresAt, ago(TOKEN_DAYS)));
await db().delete(schema.pendingCheckouts)
  .where(and(isNull(schema.pendingCheckouts.userId),
    sql`${schema.pendingCheckouts.expiresAt} < now() - interval '7 days'`));

console.log(`\n  Deleted ${total} row(s).\n`);
process.exit(0);
