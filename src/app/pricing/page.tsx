import type { Metadata } from 'next';
import Nav from '@/components/Nav';
import PricingTable from '@/components/PricingTable';
import { currentUser } from '@/lib/auth';

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'Weekly, monthly and annual plans. See your own video patched before you pay for anything.',
};

export default async function PricingPage() {
  const user = await currentUser();

  return (
    <>
      <Nav />
      <main id="main" className="mx-auto max-w-6xl px-6 py-20">
        <div className="mb-14 text-center">
          <h1 className="text-[clamp(2rem,4vw,2.9rem)] font-semibold tracking-[-0.025em]">
            Pay only for the download
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-muted">
            Uploading, analysing and previewing your video is free and needs no account. A plan
            is only needed when you want the patched file itself.
          </p>
        </div>

        <PricingTable interactive signedIn={!!user} />

        <section className="mx-auto mt-24 max-w-2xl">
          <h2 className="text-[1.3rem] font-semibold tracking-[-0.01em]">Before you subscribe</h2>
          <dl className="mt-7 space-y-7">
            {[
              {
                q: 'What exactly am I agreeing to?',
                a: 'A subscription that renews automatically until you cancel. Before any card details are taken you will see the exact amount, how often it is charged, and the exact date of the first charge.',
              },
              {
                q: 'How do I cancel?',
                a: 'Account → Billing, two clicks, no email required and nobody to talk to. Cancelling takes effect at the end of the period you have already paid for, so you keep what you paid for.',
              },
              {
                q: 'Why does the weekly plan have no free trial?',
                a: 'A seven-day trial on a seven-day plan is a free period that could be repeated indefinitely, which we would end up pricing into everyone else’s plan. Monthly and annual both include the trial.',
              },
              {
                q: 'What if it stops working?',
                a: 'This depends on how TikTok processes uploads, which is outside our control and could change. If it stops working we stop billing and tell you — that is also why there is no lifetime plan.',
              },
            ].map((f) => (
              <div key={f.q} className="border-b border-line-soft pb-7 last:border-0">
                <dt className="text-[15px] font-medium">{f.q}</dt>
                <dd className="mt-2 text-[14px] leading-relaxed text-muted">{f.a}</dd>
              </div>
            ))}
          </dl>
        </section>
      </main>
    </>
  );
}
