import type { Metadata } from 'next';
import Plate3D from '@/components/Plate3D';
import PricingTable from '@/components/PricingTable';
import SceneNav from '@/components/SceneNav';
import FieldBackdrop from '@/components/fx/FieldBackdrop';
import SceneSection from '@/components/fx/SceneSection';
import Starfield from '@/components/fx/Starfield';

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'Weekly, monthly and annual plans. See your own video served in full quality before you pay for anything.',
};

/*
 * The pricing page, in the same scenery as the rest of the site: the galaxy,
 * the rising field of likes and comments behind the plans, the floating nav
 * and dock instead of a bar, and the three cards each more alive than the
 * last (PricingTable). The questions underneath are slabs that rise in one
 * after another. Every word is the word it was.
 */
const QUESTIONS = [
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
    a: 'This depends on how TikTok processes uploads, which is outside our control and could change. If it stops working we tell you straight away and get it back up as soon as possible; your subscription and access continue and resume automatically, any time lost beyond 14 days is added to your plan, and you can cancel whenever you like. That is also why there is no lifetime plan.',
  },
  {
    q: 'What if I need more than my daily allowance?',
    a: 'Every plan has a daily number of downloads, and it resets 24 hours after your first download of the day. If you reach it, you can top the day up for $0.99 — a one-off payment, as many times as you like, nothing recurring.',
  },
];

export default async function PricingPage() {

  return (
    <>
      <Starfield density={0.7} />
      <div className="relative z-[1] min-h-[100svh] overflow-x-clip">
        <SceneNav variant="app" />
        <FieldBackdrop />

        <main id="main" className="mx-auto max-w-6xl px-6 pt-28 pb-20 md:pt-32 md:pb-24">
          <div className="mb-14 text-center">
            <h1 className="title-3d text-[clamp(2rem,4vw,2.9rem)] leading-[1.05]">
              Pay only for the download
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-muted">
              Uploading, analysing and previewing your video is free and needs no account. A plan
              is only needed when you want the finished file itself.
            </p>
          </div>

          <SceneSection>
            <PricingTable />
          </SceneSection>

          <SceneSection className="mx-auto mt-24 max-w-2xl">
            <h2 className="title-3d text-[1.3rem]">Before you subscribe</h2>
            <div className="mt-7 space-y-4">
              {QUESTIONS.map((f, i) => (
                <Plate3D key={f.q} depth={8} tilt={1.5} delay={i * 90} className="px-6 py-5">
                  <h3 className="text-[15px] font-medium">{f.q}</h3>
                  <p className="mt-2 text-[14px] leading-relaxed text-muted">{f.a}</p>
                </Plate3D>
              ))}
            </div>
          </SceneSection>
        </main>
      </div>
    </>
  );
}
