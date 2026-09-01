import type { Metadata } from 'next';
import { COMPANY } from '@/lib/company';
import { PLANS, money } from '@/lib/plans';

export const metadata: Metadata = { title: 'Refund Policy' };

/*
 * DRAFT. Reviewed by no lawyer.
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
 */
export default function Refunds() {
  return (
    <>
      <h1>Refund Policy</h1>

      <p>
        Short version: if it did not work for you, tell us and we will refund you. We would much
        rather do that than have you argue with your bank.
      </p>

      <h2>Your first charge</h2>
      <p>
        If you are unhappy for any reason, email us within <strong>72 hours</strong> of your first
        charge and we will refund it in full. You do not need to justify it.
      </p>

      <h2>If it does not work</h2>
      <p>
        If the service fails to do what it says — the patched file is rejected, or the platform
        re-encodes it anyway — we will refund the current period, whenever that happens. Send us
        the file name and roughly when you tried; we can usually see what went wrong from our
        records.
      </p>

      <h2>If the method stops working</h2>
      <p>
        The service depends on how a third-party platform processes uploads, which is outside our
        control. If that changes and the service stops working, we will{' '}
        <strong>stop billing everyone and refund the current period</strong> without waiting to be
        asked. We will not keep charging a subscription for something that has stopped working.
      </p>

      <h2>Renewals</h2>
      <p>
        Renewals are refundable within <strong>7 days</strong> if you have not used any patches in
        that period. If you have used it, cancel instead — you keep access until the end of the
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
