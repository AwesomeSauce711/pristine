import type { Metadata } from 'next';
import { COMPANY } from '@/lib/company';

export const metadata: Metadata = { title: 'Privacy Policy' };

/*
 * DRAFT. Reviewed by no lawyer.
 *
 * The unusual thing about this policy is how little there is to disclose, and
 * that is worth being precise about rather than vague: the architecture means
 * customer video genuinely never reaches us. Being specific about what a
 * "file index" contains is more honest, and more persuasive, than the usual
 * "we take your privacy seriously".
 */
export default function Privacy() {
  return (
    <>
      <h1>Privacy Policy</h1>

      <p>
        This explains what {COMPANY.legalName} collects when you use{' '}
        {COMPANY.tradingName}, and what we do with it.
      </p>

      <h2>Your videos are not uploaded</h2>
      <p>
        This is the most important thing here, so it comes first. When you drop a video in, it is
        read <strong>in your browser</strong>. Analysis and the preview happen on your device.
      </p>
      <p>
        When you download a patched file, we receive only the file&rsquo;s <strong>index</strong> —
        the small metadata structure describing how the file is laid out. It contains track
        durations, sample sizes and byte offsets. It contains <strong>no picture and no
        sound</strong>. It is typically a fraction of one percent of the file.
      </p>
      <p>
        We do not store that index. It is held in memory long enough to patch it, and discarded.
        We keep only a record that a patch happened: its size, a hash, timing, and whether it
        succeeded — which is what enforces fair-use limits and lets us investigate failures.
      </p>

      <h2>What we do collect</h2>
      <ul>
        <li><strong>Your email address</strong>, so you can sign in and we can send receipts and
          service notices.</li>
        <li><strong>Sign-in and session records</strong> — hashed session tokens, IP address, and
          browser user agent — to keep your account secure and let you sign out everywhere.</li>
        <li><strong>Subscription and payment records</strong> from Stripe: plan, status, renewal
          dates and invoices. Your card details stay with Stripe — we do not receive or store
          them, not even the last four digits.</li>
        <li><strong>Your agreement to the subscription terms</strong>: the exact wording shown to
          you, with a timestamp, IP address and user agent. We are required to be able to
          demonstrate this, and it protects you as much as us.</li>
        <li><strong>Usage records</strong>: which patches you ran and when.</li>
      </ul>

      <h2>What we never collect</h2>
      <ul>
        <li>Your video, its picture, or its audio.</li>
        <li>Your card number. Payments are handled by Stripe; we never see it.</li>
        <li>A password. There isn&rsquo;t one.</li>
        <li>Advertising or cross-site tracking identifiers.</li>
      </ul>

      <h2>Who we share with</h2>
      <p>
        Only the providers needed to run the service — payment processing (Stripe), hosting, the
        database, and email delivery — and only what each needs. We do not sell personal data, and
        we do not share it for advertising. We may disclose data where the law requires it.
      </p>

      <h2>How long we keep it</h2>
      <p>
        Account and subscription records are kept while your account exists and afterwards for as
        long as tax and accounting law requires. Sessions expire after 30 days. Usage records are
        kept for 12 months. Consent records are kept for as long as a payment could be disputed.
      </p>

      <h2>Your rights</h2>
      <p>
        You can ask for a copy of your data, ask us to correct it, or ask us to delete your
        account. Depending on where you live you may also object to certain processing or ask for
        it to be restricted. Email{' '}
        <a href={`mailto:${COMPANY.privacyEmail}`}>{COMPANY.privacyEmail}</a> and we will respond
        within 30 days. Deleting your account does not remove records we must keep for tax
        purposes or to defend a payment dispute.
      </p>

      <h2>Cookies</h2>
      <p>
        Two cookies, both essential. One keeps you signed in. The other exists only while you are
        paying, so that when you return from the payment page we can tell it was the same browser
        that started. Neither is used for tracking or advertising, and we run no analytics, so
        there is no banner to click.
      </p>

      <h2>Contact</h2>
      <p>
        <a href={`mailto:${COMPANY.privacyEmail}`}>{COMPANY.privacyEmail}</a>
        {COMPANY.address !== 'TO BE COMPLETED' && <> · {COMPANY.address}</>}
      </p>
    </>
  );
}
