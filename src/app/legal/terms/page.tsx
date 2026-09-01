import type { Metadata } from 'next';
import { COMPANY } from '@/lib/company';
import { PLANS, PLAN_ORDER, money } from '@/lib/plans';

export const metadata: Metadata = { title: 'Terms of Service' };

/*
 * DRAFT. Reviewed by no lawyer.
 *
 * The clauses here exist because specific rules require them — automatic
 * renewal disclosure and easy cancellation (US ROSCA and state ARLs), a clear
 * description of what is sold, and an honest statement that the service depends
 * on a third party's behaviour. That last one is unusual to volunteer and is
 * here on purpose: charging a subscription for something that could stop
 * working, without saying so, is the kind of omission that turns into an
 * enforcement problem as well as a refund queue.
 */
export default function Terms() {
  return (
    <>
      <h1>Terms of Service</h1>

      <p>
        These terms are between you and <strong>{COMPANY.legalName}</strong> (&ldquo;we&rdquo;,
        &ldquo;us&rdquo;), who operate {COMPANY.tradingName}. By using the service you agree to
        them.
      </p>

      <h2>What the service does</h2>
      <p>
        {COMPANY.tradingName} modifies the container metadata of an MP4 file you provide, so that
        video platforms are more likely to serve it without re-encoding it. It does{' '}
        <strong>not</strong> re-encode, upscale, or otherwise alter the picture: the video frames
        in the file you download are identical to the ones in the file you supplied.
      </p>
      <p>
        Reading and previewing a file happens entirely in your browser. When you download a
        patched file, only the file&rsquo;s index — a small metadata structure, typically well
        under a megabyte — is sent to our servers. <strong>Your video itself is never
        uploaded.</strong>
      </p>

      <h2>What we do not promise</h2>
      <p>
        The service works because of how a third-party platform currently processes uploads. That
        behaviour is outside our control and <strong>may change or stop working at any time,
        without notice</strong>. We do not guarantee any particular quality, resolution, frame
        rate, reach, engagement, or outcome. We are not affiliated with, endorsed by, or
        connected to any video platform.
      </p>
      <p>
        If the service stops working we will stop charging for it and tell you. This is also why
        we do not sell lifetime access.
      </p>

      <h2>Your account</h2>
      <p>
        You need an account to download patched files. Keep access to your email address secure,
        since sign-in codes are sent there. You must be old enough to enter a contract where you
        live, and you are responsible for what you upload — including holding the rights to it.
      </p>

      <h2>Subscriptions, renewal and cancellation</h2>
      <p>
        Plans are subscriptions that <strong>renew automatically</strong> until cancelled:
      </p>
      <ul>
        {PLAN_ORDER.map((id) => {
          const p = PLANS[id];
          return (
            <li key={id}>
              <strong>{p.name}</strong> — {money(p.amount)} per {p.interval}, renewing every{' '}
              {p.interval}
              {p.trialDays > 0
                ? `, after a ${p.trialDays}-day free trial. Your card is charged at the end of the trial unless you cancel first.`
                : '. This plan has no free trial.'}{' '}
              Fair-use limit: {p.dailyPatchCap} patched files per day.
            </li>
          );
        })}
      </ul>
      <p>
        Before we take any card details you will be shown the exact amount, how often you will be
        charged, and the exact date of your first charge. Charges appear on your statement as{' '}
        <strong>{COMPANY.statementDescriptor}</strong>.
      </p>
      <p>
        <strong>You can cancel at any time</strong> from Account → Billing, in the same place and
        with no more effort than it took to subscribe. No email, phone call, or conversation is
        required. Cancelling takes effect at the end of the period you have already paid for, and
        you keep access until then. Free trials are limited to one per person. We may decline a
        free trial, or offer the plan without one, where we identify that a trial has already
        been used &mdash; for example by the same account, the same payment method, or the same
        person. During a trial you can patch up to 10 files per day and 25 in total; paid plans
        have higher limits. If you are not offered a trial you can still subscribe at the normal
        price.
      </p>

      <h2>Acceptable use</h2>
      <p>
        Do not use the service to process material you do not have the rights to, to break the
        law, or to attack, overload or reverse-engineer our systems. Do not resell or share
        account access. We may suspend an account that does these things, or one with an
        unresolved payment dispute.
      </p>

      <h2>Refunds</h2>
      <p>
        See our <a href="/legal/refunds">refund policy</a>, which forms part of these terms.
      </p>

      <h2>Liability</h2>
      <p>
        The service is provided as-is. To the extent the law allows, our total liability to you is
        limited to the amount you paid us in the three months before the claim. Nothing here
        limits liability that cannot lawfully be limited, and if you are a consumer you keep every
        right your local law gives you.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms. If a change materially affects you we will give reasonable
        notice by email before it takes effect, and you may cancel if you do not accept it.
      </p>

      <h2>Contact</h2>
      <p>
        <a href={`mailto:${COMPANY.supportEmail}`}>{COMPANY.supportEmail}</a>
        {COMPANY.country !== 'TO BE COMPLETED' && <> · Governed by the laws of {COMPANY.country}.</>}
      </p>
    </>
  );
}
