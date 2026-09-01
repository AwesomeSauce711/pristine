'use client';

import { useState } from 'react';
import { PLANS, PLAN_ORDER, annualSavingPct, money, type PlanId } from '@/lib/plans';

/*
 * The pricing ladder, and the consent step in front of Stripe.
 *
 * Trial terms are on the card itself, not only at checkout. Someone comparing
 * plans should be able to see that the weekly plan has no trial without
 * clicking through to find out. It costs nothing here and removes a whole class
 * of "I didn't realise" support mail and chargebacks.
 *
 * The consent dialog is a legal requirement rather than a design flourish. US
 * ROSCA and state automatic-renewal laws require the price, the frequency, the
 * exact first-charge date and the cancellation method to be disclosed clearly
 * and conspicuously BEFORE billing details are taken — which means before the
 * redirect to Stripe, not on Stripe's page. The checkbox starts unchecked
 * because a pre-checked one is prohibited under California's ARL.
 */

/*
 * There is no `interactive` prop any more, and its absence is the fix for
 * "I have to click start free trial twice".
 *
 * It used to default to false, in which mode the CTA was a <Link href="/pricing">
 * carrying the SAME label as the real button. The homepage rendered that dead
 * version, and every route in — the nav, the hero, and the tool's paywall —
 * pointed at the homepage. So click one navigated to a page showing an
 * identical card with an identical button, and click two finally opened the
 * dialog. The first click was never a button.
 *
 * `signedIn` is gone too: with anonymous checkout everybody gets the same
 * disclosure, the same checkbox and the same payment control.
 */
export default function PricingTable() {
  const [busy, setBusy] = useState<PlanId | null>(null);
  const [error, setError] = useState('');

  /*
   * Straight to Stripe. There used to be a modal here that repeated the price,
   * the renewal terms and the cancellation route, with its own checkbox, before
   * redirecting — and then Stripe's page said all of it again.
   *
   * The disclosure has not been dropped. It is passed as `custom_text.submit`
   * and renders directly above Stripe's Subscribe button, which is a better
   * place for it than a screen two clicks earlier: the law asks for it adjacent
   * to the control that starts billing, and that control is Stripe's, not ours.
   * The verbatim text and its hash are still written to `consents` before the
   * session exists, so the evidence record is unchanged.
   */
  async function start(plan: PlanId) {
    setBusy(plan);
    setError('');
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan, consented: true }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        setError(data.message ?? 'Checkout could not be started. Please try again.');
        setBusy(null);
        return;
      }
      window.location.href = data.url;
    } catch {
      setError('Checkout could not be started. Please check your connection.');
      setBusy(null);
    }
  }

  return (
    <>
      <div className="grid gap-5 md:grid-cols-3">
        {PLAN_ORDER.map((id) => {
          const p = PLANS[id];
          const featured = p.id === 'month';
          const cta = p.trialDays > 0 ? `Start ${p.trialDays}-day free trial` : 'Get started';

          return (
            <div
              key={p.id}
              className={[
                'relative flex flex-col rounded-panel border p-7 transition',
                featured
                  ? 'border-accent/45 bg-panel shadow-[0_0_0_1px_rgba(124,92,255,0.12),0_24px_60px_-32px_rgba(124,92,255,0.5)]'
                  : 'border-line bg-panel/60 hover:border-dim',
              ].join(' ')}
            >
              {p.badge && (
                <span
                  className={[
                    'absolute -top-2.5 left-7 rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.1em]',
                    featured ? 'bg-accent text-white' : 'border border-line bg-panel-2 text-muted',
                  ].join(' ')}
                >
                  {p.badge}
                </span>
              )}

              <h3 className="text-[15px] font-medium">{p.name}</h3>

              <div className="mt-4 flex items-baseline gap-1.5">
                <span className="tabular text-[2.5rem] font-medium leading-none tracking-tight">
                  {money(p.amount)}
                </span>
                <span className="text-[14px] text-dim">/{p.interval}</span>
              </div>

              {p.id === 'year' && (
                <p className="tabular mt-2 text-[12px] text-good">
                  Save {annualSavingPct}% against monthly
                </p>
              )}

              <p className="mt-4 text-[13.5px] leading-relaxed text-muted">{p.blurb}</p>

              {/*
                * The one number that differs between plans, given the weight that
                * implies. The previous version listed it as the third of four
                * bullets, three of which were identical on every card — which is
                * a layout that tells someone the plans are the same and the
                * cheapest is therefore correct. What every plan shares is stated
                * once, under the grid, where repeating it cannot flatten the
                * comparison.
                */}
              {/*
                * The number gets more emphatic as the plan does: plain, accent,
                * then animated. It is the only thing that actually differs
                * between the tiers, so it is the only thing that escalates.
                */}
              <div className="mt-6 flex items-baseline gap-2">
                <span
                  className={[
                    'tabular font-semibold leading-none tracking-[-0.03em]',
                    p.id === 'year' ? 'rainbow-number text-[2.9rem]'
                      : p.id === 'month' ? 'text-accent-soft text-[2.5rem]'
                      : 'text-text text-[2.1rem]',
                  ].join(' ')}
                >
                  {p.dailyPatchCap}
                </span>
                <span className="text-[13.5px] leading-tight text-muted">
                  {p.dailyPatchCap === 1 ? 'video' : 'videos'}<br />per day
                </span>
              </div>

              <ul className="mt-6 space-y-2.5 text-[13.5px] text-muted">
                <li className="flex gap-2.5"><Tick /> Full quality, never re-encoded</li>
                <li className="flex gap-2.5"><Tick /> Up to 4K and 60fps</li>
                <li className="flex gap-2.5"><Tick /> Your video never leaves your device</li>
                <li className="flex gap-2.5">
                  <Tick /><span>{p.periodPatchCap.toLocaleString()} per {p.interval} in total</span>
                </li>
              </ul>

              <div className="mt-7 border-t border-line-soft pt-6">
                <button
                  onClick={() => start(p.id)}
                  disabled={busy !== null}
                  className={[
                    'block w-full rounded-xl px-5 py-3 text-center text-[14px] font-medium transition',
                    featured
                      ? 'bg-accent text-white hover:bg-accent-soft'
                      : 'border border-line text-text hover:border-dim',
                  ].join(' ')}
                >
                  {busy === p.id ? 'Opening secure checkout…' : cta}
                </button>

                <p className="mt-3 text-center text-[11.5px] leading-relaxed text-dim">
                  {p.trialDays > 0
                    ? <>Then {money(p.amount)}/{p.interval}. Cancel any time.</>
                    : <>Billed {money(p.amount)} weekly. No trial on this plan. Cancel any time.</>}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {error && (
        <p className="mx-auto mt-6 max-w-md rounded-lg border border-bad/30 bg-bad/5 px-4 py-3 text-center text-[13px] text-text">
          {error}
        </p>
      )}

      <p className="mx-auto mt-8 max-w-2xl text-center text-[12.5px] leading-relaxed text-dim">
        All plans are subscriptions that renew automatically until cancelled. You will see the
        exact amount and the exact date of your first charge before entering any card details.
        Cancel in two clicks from Account → Billing.
      </p>


    </>
  );
}

function Tick() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none"
         className="mt-[3px] shrink-0 text-accent" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
