import 'server-only';

import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { db, schema } from '@/db';
import { stripe } from '@/lib/billing/stripe';
import { COMPANY } from '@/lib/company';

/*
 * dispute-evidence.ts — assemble the response to a chargeback.
 *
 * WHY THIS IS AUTOMATED AT ALL
 * A dispute costs $15 whether you win or lose, and the ratio counts against you
 * either way, so the money recovered is rarely the point. What matters is that
 * responding at all is a signal to the card networks, and that the evidence for a
 * digital product is dull, specific, and entirely already in the database — the
 * exact consent text with its hash, the sign-in trail, and a log of every file
 * they patched. Assembling that by hand at the deadline, weeks later, is how it
 * ends up not happening.
 *
 * WHY IT SAVES A DRAFT INSTEAD OF SUBMITTING
 * Submitting is final: Stripe will not let you revise evidence afterwards. But
 * evidence saved WITHOUT `submit` can be edited right up to the deadline, and
 * Stripe submits whatever is there automatically when the deadline arrives. So
 * saving a draft the moment the dispute opens is strictly better than
 * auto-submitting — the facts are captured while they are fresh, nothing is lost
 * if nobody looks, and a human can still add context that no script would know
 * (an email thread, a refund already offered). Submitting instantly would throw
 * that option away to save one command.
 *
 * WHAT IS DELIBERATELY NOT CLAIMED
 * Only facts that can be pointed at a row. No characterisation of the customer,
 * no speculation about intent. A dispute response that overreaches is worse than
 * a short one, because the reviewer is checking whether your account is worth the
 * trouble.
 */

export interface AssembledEvidence {
  disputeId: string;
  userId: string | null;
  fields: Record<string, string>;
  /** Facts that could not be found, so a human knows what is thin. */
  gaps: string[];
}

const iso = (d: Date | null | undefined): string =>
  d ? d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'unknown';

/**
 * Build the evidence for one dispute. Read-only — it does not touch Stripe.
 *
 * Exported separately from the submit path so it can be inspected, tested, and
 * printed without any risk of sending something half-formed to Stripe.
 */
export async function assembleEvidence(disputeId: string): Promise<AssembledEvidence | null> {
  const rows = await db().select().from(schema.disputes)
    .where(eq(schema.disputes.stripeDisputeId, disputeId)).limit(1);
  const dispute = rows[0];
  if (!dispute) return null;

  const gaps: string[] = [];
  const userId = dispute.userId;

  if (!userId) {
    gaps.push('The charge could not be matched to an account, so no usage or consent record is included.');
    return {
      disputeId,
      userId: null,
      fields: {
        product_description: PRODUCT_DESCRIPTION,
        refund_policy_disclosure: REFUND_DISCLOSURE,
        cancellation_policy_disclosure: CANCELLATION_DISCLOSURE,
        uncategorized_text:
          'This charge could not be matched to an account in our records. '
          + `Support: ${COMPANY.supportEmail}`,
      },
      gaps,
    };
  }

  const [user] = await db().select().from(schema.users)
    .where(eq(schema.users.id, userId)).limit(1);

  /* ---- the consent record: the strongest single item -------------------- */

  const [consent] = await db().select().from(schema.consents)
    .where(eq(schema.consents.userId, userId))
    .orderBy(desc(schema.consents.createdAt)).limit(1);

  if (!consent) gaps.push('No consent record found — this is the strongest evidence and its absence is worth investigating.');

  /* ---- usage: did they actually use what they are disputing? ------------ */

  const since = new Date(dispute.openedAt.getTime() - 400 * 86_400_000);
  const jobs = await db().select().from(schema.patchJobs)
    .where(and(
      eq(schema.patchJobs.userId, userId),
      gte(schema.patchJobs.createdAt, since),
      lte(schema.patchJobs.createdAt, dispute.openedAt),
    ))
    .orderBy(desc(schema.patchJobs.createdAt)).limit(200);

  const completed = jobs.filter((j) => j.status === 'completed');
  if (!completed.length) gaps.push('No completed patches before the dispute — the "never used it" argument is available to them.');

  /* ---- sign-in trail ---------------------------------------------------- */

  const sessions = await db().select().from(schema.sessions)
    .where(eq(schema.sessions.userId, userId))
    .orderBy(desc(schema.sessions.createdAt)).limit(20);

  /*
   * access_activity_log is the field Stripe names specifically for digital
   * goods: server logs showing the customer accessed or downloaded what they
   * bought. This is the one that does the work.
   */
  const activity: string[] = [];
  activity.push(`Account: ${user?.email ?? 'unknown'} (id ${userId})`);
  activity.push(`Email verified: ${iso(user?.emailVerifiedAt)}`);
  activity.push('');
  activity.push(`SIGN-INS (${sessions.length} most recent)`);
  for (const s of sessions.slice(0, 10)) {
    activity.push(`  ${iso(s.createdAt)}  ip ${s.ip ?? 'unknown'}  ${(s.userAgent ?? '').slice(0, 90)}`);
  }
  activity.push('');
  activity.push(`FILES PROCESSED: ${completed.length} completed before the dispute was opened`);
  for (const j of completed.slice(0, 40)) {
    activity.push(
      `  ${iso(j.createdAt)}  ip ${j.ip ?? 'unknown'}  ` +
      `output ${j.outputLen ? (j.outputLen / 1_048_576).toFixed(1) + ' MB' : 'n/a'}  ` +
      `source fingerprint ${j.moovSha256.slice(0, 16)}`,
    );
  }
  if (completed.length > 40) activity.push(`  … and ${completed.length - 40} more`);

  const fields: Record<string, string> = {
    product_description: PRODUCT_DESCRIPTION,
    refund_policy_disclosure: REFUND_DISCLOSURE,
    cancellation_policy_disclosure: CANCELLATION_DISCLOSURE,
    access_activity_log: clamp(activity.join('\n')),
  };

  if (user?.email) fields.customer_email_address = user.email;
  if (consent?.ip) fields.customer_purchase_ip = consent.ip;

  if (consent) {
    /*
     * The disclosure text is stored verbatim with a SHA-256 taken at the moment
     * it was shown. Quoting the hash alongside it is what makes this a record
     * rather than an assertion — it demonstrates the text has not been edited
     * since, which is the obvious challenge to any "we told them" claim.
     */
    fields.uncategorized_text = clamp([
      'The customer agreed to the following terms before any payment details were taken.',
      'This text is stored verbatim at the moment of consent, with a SHA-256 taken then:',
      '',
      `  "${consent.disclosureText}"`,
      '',
      `  shown at    ${iso(consent.createdAt)}`,
      `  from IP     ${consent.ip ?? 'unknown'}`,
      `  user agent  ${(consent.userAgent ?? 'unknown').slice(0, 200)}`,
      `  page        ${consent.pageUrl ?? 'unknown'}`,
      `  sha256      ${consent.disclosureSha256}`,
      `  checkbox    ${consent.checkboxChecked ? 'ticked by the customer (not pre-ticked)' : 'NOT RECORDED'}`,
      '',
      'Cancellation is self-serve from Account → Billing at any time, in the same',
      'number of steps it took to subscribe, with no email or phone call required.',
      `Support is available at ${COMPANY.supportEmail} and requests are answered.`,
    ].join('\n'));
  }

  return { disputeId, userId, fields, gaps };
}

/**
 * Save the assembled evidence against the dispute in Stripe.
 *
 * `submit` defaults to false, which stores it as a draft that can still be
 * edited and that Stripe submits automatically at the deadline. Pass true only
 * when a human has read it.
 */
export async function saveEvidence(disputeId: string, submit = false): Promise<AssembledEvidence | null> {
  const assembled = await assembleEvidence(disputeId);
  if (!assembled) return null;

  await stripe().disputes.update(disputeId, {
    evidence: assembled.fields,
    ...(submit ? { submit: true } : {}),
  });

  if (submit) {
    await db().update(schema.disputes)
      .set({ evidenceSubmittedAt: new Date() })
      .where(eq(schema.disputes.stripeDisputeId, disputeId));
  }

  return assembled;
}

/* --------------------------------------------------------------- constants */

/** Stripe caps each evidence field at 20,000 characters. */
function clamp(s: string): string {
  return s.length <= 20_000 ? s : s.slice(0, 19_900) + '\n… truncated';
}

const PRODUCT_DESCRIPTION =
  `${COMPANY.tradingName} is a subscription web tool that modifies the metadata of a video file `
  + 'the customer already has, so that when they upload it themselves it is not re-compressed. '
  + 'The video is processed in the customer\'s own browser and is never uploaded to us. Access is '
  + 'immediate on subscribing and the service is used through a web browser with no download or '
  + 'installation.';

const REFUND_DISCLOSURE =
  'The refund policy is published at '
  + `${COMPANY.origin}/legal/refunds and is linked from the checkout page and the footer of every `
  + 'page. Refunds are given on request through the support address; no reason is required.';

const CANCELLATION_DISCLOSURE =
  'Cancellation is self-serve at any time from Account → Billing, using the Stripe Customer '
  + 'Portal, in no more steps than it took to subscribe. No email, phone call, or conversation is '
  + 'required. Cancelling takes effect at the end of the period already paid for, and access '
  + 'continues until then. This is stated in the terms shown next to the card field before payment '
  + 'details are taken, and at '
  + `${COMPANY.origin}/legal/terms`;
