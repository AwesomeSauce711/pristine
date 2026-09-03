import type { Metadata } from 'next';
import { COMPANY } from '@/lib/company';
import { PLANS, PLAN_ORDER, money } from '@/lib/plans';
import { REFILL_AMOUNT_CENTS } from '@/lib/billing/stripe';

export const metadata: Metadata = { title: 'Terms of Service' };

/*
 * Reviewed by no lawyer; written to the rules that apply to a subscription
 * sold online to consumers.
 *
 * The clauses here exist because specific rules require them — automatic
 * renewal disclosure and easy cancellation (US ROSCA and state ARLs), a clear
 * description of what is sold, the EU/UK right of withdrawal and how it is
 * waived for a service that starts at once, and an honest statement that the
 * service depends on a third party's behaviour. That last one is unusual to
 * volunteer and is here on purpose: charging a subscription for something
 * that could stop working, without saying so, is the kind of omission that
 * turns into an enforcement problem as well as a refund queue.
 *
 * WHAT HAPPENS WHEN THE METHOD BREAKS
 * Subscriptions are not stopped. The commitment is to say so at once, restore
 * the service as fast as possible, keep everyone's access so it resumes on its
 * own, and credit the time lost once an interruption has run past fourteen
 * days. Cancelling the book on the first bad day would mean re-selling every
 * customer after the fix; the credit is what keeps the promise honest in the
 * meantime. Nothing in these pages describes how the service works.
 */
export default function Terms() {
  return (
    <>
      <h1>Terms of Service</h1>

      <p>
        These terms are between you and <strong>{COMPANY.legalName}</strong> (&ldquo;we&rdquo;,
        &ldquo;us&rdquo;), who operate {COMPANY.tradingName} (the &ldquo;service&rdquo;). By using
        the service you agree to them. Our <a href="/legal/privacy">privacy policy</a> and{' '}
        <a href="/legal/refunds">refund policy</a> form part of these terms.
      </p>

      <h2>What the service does</h2>
      <p>
        {COMPANY.tradingName} prepares a version of an MP4 file you provide that video platforms
        are more likely to serve without re-encoding it. It does{' '}
        <strong>not</strong> re-encode, upscale, or otherwise alter the picture: the video frames
        in the file you download are identical to the ones in the file you supplied.
      </p>
      <p>
        Reading and previewing a file happens entirely in your browser. When you download a
        finished file, only a small amount of technical metadata about the file — typically well
        under a megabyte, and never the picture or the sound — is sent to our servers.{' '}
        <strong>Your video itself is never uploaded.</strong>
      </p>
      <p>
        Reading and previewing a file is free and needs no account. A subscription is needed to
        download finished files.
      </p>

      <h2>What we do not promise</h2>
      <p>
        The service works because of how a third-party platform currently processes uploads. That
        behaviour is outside our control and <strong>may change or stop working at any time,
        without notice</strong>. We do not guarantee any particular quality, resolution, frame
        rate, reach, engagement, or outcome. We are not affiliated with, endorsed by, or
        connected to any video platform, and we do not guarantee that a platform will accept any
        particular file.
      </p>

      <h2>If a platform change stops it working</h2>
      <p>
        If a platform change stops the service having its intended effect, this is what we do:
      </p>
      <ul>
        <li><strong>We tell you at once</strong>, with a notice on the site and an email to every
          subscriber, and we keep you updated until it is resolved.</li>
        <li><strong>We restore it as quickly as we can.</strong> Finding what changed and shipping
          a fix is our first priority and the whole of our work until it is done.</li>
        <li><strong>Your subscription and access continue</strong> in the meantime, so the service
          resumes for you automatically the moment it is back — there is nothing to re-buy and
          nothing to do.</li>
        <li><strong>Time lost is credited.</strong> If the service is unavailable for more than{' '}
          <strong>14 consecutive days</strong>, we add the time lost beyond that to your current
          period at no charge. Our <a href="/legal/refunds">refund policy</a> also lets you ask for
          a refund of the current period instead.</li>
        <li><strong>You can cancel at any time</strong>, as always, from Account → Billing.</li>
        <li>If we conclude that the service cannot be restored, we will end all subscriptions
          ourselves and refund any unused time on a pro-rata basis. This is the only case in which
          we cancel a subscription for you.</li>
      </ul>
      <p>
        This is also why we do not sell lifetime access: it would be selling
        &ldquo;forever&rdquo; for something we do not control.
      </p>

      <h2>Eligibility and your account</h2>
      <p>
        You must be old enough to enter a binding contract where you live (18 in most places),
        and you may use the service only for yourself or a business you are authorised to bind.
        You need an account to download finished files. Sign-in is by a code sent to your email
        address, so keep access to that address secure; anything done from a signed-in session is
        treated as done by you. Tell us promptly if you believe your account has been used without
        your permission.
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
              Fair-use limit: {p.dailyPatchCap} files per day.
            </li>
          );
        })}
      </ul>
      <p>
        Before we take any card details you will be shown the exact amount, how often you will be
        charged, and the exact date of your first charge, and you will be asked to agree to these
        terms. Charges appear on your statement as <strong>{COMPANY.statementDescriptor}</strong>.
        Prices are in US dollars and include any tax we are required to collect unless the checkout
        page says otherwise; where tax is added it is shown before you pay.
      </p>
      <p>
        <strong>You can cancel at any time</strong> from Account → Billing, in the same place and
        with no more effort than it took to subscribe. No email, phone call, or conversation is
        required. Cancelling takes effect at the end of the period you have already paid for, and
        you keep access until then. We do not refund part-periods except as set out in the{' '}
        <a href="/legal/refunds">refund policy</a>.
      </p>
      <p>
        <strong>Free trials</strong> are limited to one per person. We may decline a free trial,
        or offer the plan without one, where we identify that a trial has already been used
        &mdash; for example by the same account, the same payment method, or the same person.
        During a trial you have the same daily limit as the plan you are trying. We send a
        reminder before a trial converts to a paid plan. If you are not offered a trial you can
        still subscribe at the normal price.
      </p>
      <p>
        <strong>Daily limit and top-ups.</strong> Each plan&rsquo;s daily limit resets 24 hours
        after your first download of the day; the exact time is shown in your account. If you
        reach it, you can top the day up for <strong>{money(REFILL_AMOUNT_CENTS)}</strong> as many
        times as you like. A top-up is a one-off charge for that day, not a subscription: it does
        not renew, and it is refundable only if you have not used it.
      </p>
      <p>
        <strong>Price changes.</strong> We may change a plan&rsquo;s price. A change never applies
        to a period you have already paid for. We will email you at least 30 days before a new
        price takes effect on your subscription, and you may cancel before then if you do not
        accept it. Continuing past that date means you accept the new price.
      </p>
      <p>
        <strong>Failed payments.</strong> If a renewal payment fails we will retry it and let you
        know. Access may be suspended while a renewal remains unpaid and is restored when it is
        paid. If it stays unpaid the subscription ends.
      </p>

      <h2>Your right to withdraw</h2>
      <p>
        If you live in the EU, the UK or another place with a statutory cooling-off period, you
        normally have 14 days to withdraw from a contract for a digital service. Because the
        service is available to you immediately, by subscribing you ask us to start providing it
        at once and acknowledge that you lose the right to withdraw in respect of the period that
        has begun. Our <a href="/legal/refunds">refund policy</a> is more generous than this in
        practice: any first charge is refundable in full within 72 hours, no reason required.
      </p>

      <h2>Your content</h2>
      <p>
        You keep every right to the videos you use with the service. You give us only what is
        needed to provide it: permission to read your file in your browser and to process the
        small amount of technical metadata described above. We claim no rights in your content,
        we do not receive the picture or sound, and we do not use anything about your files for
        any other purpose. You are responsible for what you process, including holding the rights
        to it.
      </p>

      <h2>Acceptable use</h2>
      <p>
        Do not use the service to process material you do not have the rights to, to break the
        law, or to attack, overload, scrape, or reverse-engineer our systems, or to work out or
        reproduce how the service achieves its result. Do not use automated tools to access the
        service, and do not resell or share account access. The fair-use limits above exist so
        that one account cannot degrade the service for everyone; they are enforced automatically.
        We may suspend or close an account that breaches this section, or one with an unresolved
        payment dispute, and where we do so because of a breach no refund is due.
      </p>

      <h2>Our property</h2>
      <p>
        The service, its software, its name and its design belong to us or our licensors and are
        protected by intellectual-property law. These terms give you a personal, non-exclusive,
        non-transferable licence to use the service while you are subscribed, and nothing more.
      </p>

      <h2>Refunds</h2>
      <p>
        See our <a href="/legal/refunds">refund policy</a>, which forms part of these terms.
      </p>

      <h2>Liability</h2>
      <p>
        The service is provided as-is and as-available. To the extent the law allows, we exclude
        all warranties not stated in these terms, we are not liable for indirect or consequential
        loss, loss of profit, revenue, audience or data, and our total liability to you for any
        claim is limited to the amount you paid us in the three months before the claim arose.
        Nothing here limits liability that cannot lawfully be limited — including for death,
        personal injury, or fraud — and if you are a consumer you keep every right your local law
        gives you.
      </p>

      <h2>Ending the agreement</h2>
      <p>
        You can end it by cancelling your subscription and, if you wish, asking us to delete your
        account. We can end it by giving you 30 days&rsquo; notice, in which case we refund any
        unused time, or at once if you materially breach these terms. Sections that by their
        nature should survive — your content, our property, liability, and disputes — survive the
        end of the agreement.
      </p>

      <h2>Changes to these terms</h2>
      <p>
        We may update these terms. If a change materially affects you we will give at least 14
        days&rsquo; notice by email before it takes effect, and you may cancel before then if you
        do not accept it. Continuing to use the service after the change takes effect means you
        accept it. The date at the foot of this page is the date of the last change.
      </p>

      <h2>Disputes and governing law</h2>
      <p>
        If you have a problem, email us first: nearly everything is settled in one reply. These
        terms are governed by the laws of{' '}
        {COMPANY.country !== 'TO BE COMPLETED' ? COMPANY.country : 'our country of establishment'}
        , and the courts there have jurisdiction, except that if you are a consumer you may also
        rely on the mandatory consumer laws, and bring a claim in the courts, of the place where
        you live. If any part of these terms is found unenforceable the rest still applies. These
        terms are the entire agreement between us about the service.
      </p>

      <h2>Contact</h2>
      <p>
        <a href={`mailto:${COMPANY.supportEmail}`}>{COMPANY.supportEmail}</a>
        {COMPANY.address !== 'TO BE COMPLETED' && <> · {COMPANY.address}</>}
      </p>
    </>
  );
}
