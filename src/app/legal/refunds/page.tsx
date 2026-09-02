import type { Metadata } from 'next';
import { COMPANY } from '@/lib/company';
import { PLANS, money } from '@/lib/plans';

export const metadata: Metadata = { title: 'Refund Policy' };

/*
 * Reviewed by no lawyer.
 *
 * The generous first-charge refund is a commercial decision, not kindness. A
 * disputed charge costs the $15 dispute fee whether or not it is won, plus a
 * hit to the dispute ratio that Stripe acts on above roughly 0.75%. Refunding
 * an unhappy customer on the spot is strictly cheaper than arguing, and the
 * ratio damage is what actually threatens the business.
 *
 * Saying so plainly on the page also removes the reason to file a dispute in
 * the first place: people go to their bank when they believe the merchant will
 * not help.
 *
 * WHEN THE METHOD BREAKS
 * Subscriptions are not stopped and nothing is refunded unasked. The promise is
 * a fast fix, continued access so it resumes on its own, a credit of the time
 * lost once an interruption has run past fourteen days, and a refund of the
 * current period on request from that point. That is enough to keep a bank or
 * Stripe on our side of a dispute, and it keeps the book intact for the fix.
 */
export default function Refunds() {
  return (
    <>
      <h1>Refund Policy</h1>

      <p>
        Short version: if it did not work for you, tell us and we will put it right — and where
        we cannot, we will refund you. We would much rather do that than have you argue with your
        bank.
      </p>

      <h2>Your first charge</h2>
      <p>
        If you are unhappy for any reason, email us within <strong>72 hours</strong> of your first
        charge and we will refund it in full. You do not need to justify it. This includes the
        first charge after a free trial, so a forgotten trial is never a lost week or month.
      </p>

      <h2>If it does not work for your file</h2>
      <p>
        If the service fails to do what it says for a file — the finished file is rejected, or the
        platform re-encodes it anyway — send us the file name and roughly when you tried; we can
        usually see what went wrong from our records and fix it. If we cannot make it work for you
        within a few days, we will refund the current period.
      </p>

      <h2>If a platform change stops it working</h2>
      <p>
        The service depends on how a third-party platform processes uploads, which is outside our
        control. If that changes and the service stops having its intended effect, we tell every
        subscriber at once and getting it back up and running becomes our first priority. Your
        subscription and your access continue in the meantime, so the service resumes for you
        automatically the moment it is restored.
      </p>
      <ul>
        <li>If the service is unavailable for more than <strong>14 consecutive days</strong>, we
          add the time lost beyond that to your current period at no charge — automatically, you
          do not need to ask.</li>
        <li>From that point you may instead ask for a <strong>refund of the current period</strong>,
          and we will give it.</li>
        <li>If we conclude that the service cannot be restored, we end all subscriptions ourselves
          and refund any unused time on a pro-rata basis, without waiting to be asked.</li>
        <li>You can cancel at any time regardless, from Account → Billing, and keep access until
          the end of the period you have paid for.</li>
      </ul>

      <h2>Renewals</h2>
      <p>
        Renewals are refundable within <strong>7 days</strong> if you have not downloaded any files
        in that period. If you have used it, cancel instead — you keep access until the end of the
        period you paid for, and you will not be charged again.
      </p>
      <p>
        We send a reminder before your free trial converts, and before each weekly renewal, so a
        charge should never be a surprise. If one is, tell us.
      </p>

      <h2>The weekly plan</h2>
      <p>
        The {PLANS.week.name} plan is {money(PLANS.week.amount)} and renews every week. It has no
        free trial, and it is the plan most likely to be forgotten about, so the 72-hour refund
        above applies to it in full.
      </p>

      <h2>What is not refunded</h2>
      <p>
        Time you have already had access to, outside the cases above; periods after a cancellation
        has taken effect; and charges on an account closed for a breach of our terms. Where a
        refund is due, we refund the charge in full — we never deduct a fee.
      </p>

      <h2>How to ask</h2>
      <p>
        Email <a href={`mailto:${COMPANY.supportEmail}`}>{COMPANY.supportEmail}</a> from the
        address on your account. We aim to reply within one business day. Refunds return to the
        original payment method and usually appear within 5–10 business days, depending on your
        bank.
      </p>

      <h2>Before contacting your bank</h2>
      <p>
        Please email us first. A chargeback costs us a fee whatever the outcome, takes months to
        resolve, and automatically suspends the account — whereas a refund we issue ourselves
        takes about a minute. If you do not recognise a charge, it will appear as{' '}
        <strong>{COMPANY.statementDescriptor}</strong>.
      </p>
    </>
  );
}
