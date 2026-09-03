import type { Metadata } from 'next';
import { COMPANY } from '@/lib/company';

export const metadata: Metadata = { title: 'Privacy Policy' };

/*
 * Reviewed by no lawyer; written to what GDPR, the UK GDPR and the CCPA ask a
 * policy to say.
 *
 * The unusual thing about this policy is how little there is to disclose, and
 * that is worth being precise about rather than vague: the architecture means
 * customer video genuinely never reaches us. Being specific about what does
 * reach us — and what never does — is more honest, and more persuasive, than
 * the usual "we take your privacy seriously". Nothing here describes how the
 * service achieves its result.
 *
 * Every retention figure quoted here has a job behind it (scripts/retention.mts)
 * and the session length is the one in src/lib/auth.ts. Change those together.
 */
export default function Privacy() {
  return (
    <>
      <h1>Privacy Policy</h1>

      <p>
        This explains what {COMPANY.legalName} (&ldquo;we&rdquo;, &ldquo;us&rdquo;) collects when
        you use {COMPANY.tradingName}, why, and what we do with it. We are the controller of the
        personal data described here.
      </p>

      <h2>Your videos are not uploaded</h2>
      <p>
        This is the most important thing here, so it comes first. When you drop a video in, it is
        read <strong>in your browser</strong>. Analysis and the preview happen on your device.
      </p>
      <p>
        When you download a finished file, we receive only a small amount of{' '}
        <strong>technical metadata</strong> describing how the file is laid out. It contains{' '}
        <strong>no picture and no sound</strong>. It is typically a fraction of one percent of
        the file.
      </p>
      <p>
        We do not store that metadata. It is held in memory long enough to do the work, and
        discarded. We keep only a record that a download happened: its size, a hash, timing, and
        whether it succeeded — which is what enforces fair-use limits and lets us investigate
        failures.
      </p>

      <h2>What we do collect</h2>
      <ul>
        <li><strong>Your email address</strong>, so you can sign in and we can send receipts,
          service notices.</li>
        <li><strong>Sign-in and session records</strong> — hashed session tokens, IP address, and
          browser user agent — to keep your account secure and let you sign out everywhere.</li>
        <li><strong>Subscription and payment records</strong> from Stripe: plan, status, renewal
          dates and invoices. Your card details stay with Stripe — we do not receive or store
          them, not even the last four digits.</li>
        <li><strong>Your agreement to the subscription terms</strong>: the exact wording shown to
          you, with a timestamp, IP address and user agent. We are required to be able to
          demonstrate this, and it protects you as much as us.</li>
        <li><strong>Usage records</strong>: which downloads you made and when.</li>
        <li><strong>Support correspondence</strong>, if you email us.</li>
      </ul>

      <h2>What we never collect</h2>
      <ul>
        <li>Your video, its picture, or its audio.</li>
        <li>Your card number. Payments are handled by Stripe; we never see it.</li>
        <li>A password. There isn&rsquo;t one.</li>
        <li>Advertising or cross-site tracking identifiers. We run no analytics and no ad
          pixels.</li>
      </ul>

      <h2>Why we use it</h2>
      <p>
        We use your data to provide the service and your account (performance of our contract
        with you); to bill you, keep records, and answer legal requests (our legal obligations);
        and to keep the service secure, enforce fair-use limits, prevent trial abuse and defend
        payment disputes (our legitimate interests, which do not override yours). We send service
        emails — sign-in codes, receipts, notices that affect your subscription
        — because the service cannot run without them. We do not send marketing email.
      </p>

      <h2>Who we share with</h2>
      <p>
        Only the providers needed to run the service — payment processing (Stripe), hosting, the
        database, and email delivery — and only what each needs, under contracts that restrict
        them to acting on our instructions. We do not sell personal data, we do not share it for
        advertising, and we have never done either. We may disclose data where the law requires
        it, or to protect our rights or someone&rsquo;s safety.
      </p>

      <h2>Where it is stored</h2>
      <p>
        Our providers may store data in the United States and other countries. Where data leaves
        the EU or UK we rely on the recognised safeguards for those transfers, such as standard
        contractual clauses and, for US providers, the EU–US Data Privacy Framework where they
        are certified under it.
      </p>

      <h2>How long we keep it</h2>
      <p>
        Account and subscription records are kept while your account exists and afterwards for as
        long as tax and accounting law requires. Signed-in sessions last six months, or until you
        sign out. Usage records are kept for 12 months. Consent records are kept for as long as a
        payment could be disputed. Sign-in codes expire within minutes and are deleted soon after.
      </p>

      <h2>Security</h2>
      <p>
        Everything travels over TLS. Session tokens are stored hashed, so a copy of our database
        cannot be used to sign in as you. There are no passwords to leak. Card details never reach
        us at all. No system is perfectly secure, and if a breach ever affects your data we will
        tell you and the relevant authority as the law requires.
      </p>

      <h2>Your rights</h2>
      <p>
        You can ask for a copy of your data, ask us to correct it, or ask us to delete your
        account. Depending on where you live you may also object to certain processing, ask for
        it to be restricted, or ask for it in a portable form. Email{' '}
        <a href={`mailto:${COMPANY.privacyEmail}`}>{COMPANY.privacyEmail}</a> from the address on
        your account and we will respond within 30 days, free of charge. Deleting your account does
        not remove records we must keep for tax purposes or to defend a payment dispute. If you are
        in the EU or UK you also have the right to complain to your data-protection authority.
      </p>
      <p>
        If you are a California resident: we do not sell or share personal information as those
        terms are defined in the CCPA, and the rights above are the rights that law gives you. We
        do not discriminate against anyone for exercising them.
      </p>

      <h2>Children</h2>
      <p>
        The service is for people old enough to enter a contract where they live. It is not
        directed at children, and we do not knowingly collect data from anyone under 16. If you
        believe a child has given us data, email us and we will delete it.
      </p>

      <h2>Cookies</h2>
      <p>
        Two cookies, both essential. One keeps you signed in. The other exists only while you are
        paying, so that when you return from the payment page we can tell it was the same browser
        that started. Neither is used for tracking or advertising, and we run no analytics, so
        there is no banner to click. Stripe sets its own cookies on its payment pages, under its
        own policy.
      </p>

      <h2>Changes to this policy</h2>
      <p>
        If we change this policy in a way that matters to you we will email you before the change
        takes effect. The date at the foot of this page is the date of the last change.
      </p>

      <h2>Contact</h2>
      <p>
        <a href={`mailto:${COMPANY.privacyEmail}`}>{COMPANY.privacyEmail}</a>
        {COMPANY.address !== 'TO BE COMPLETED' && <> · {COMPANY.address}</>}
      </p>
    </>
  );
}
