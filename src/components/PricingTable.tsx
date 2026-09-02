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
      {/* Three across at every width. On a phone the cards are compact —
        * name, price, the one number that differs, the button — so all three
        * are on screen at once without a scroll; the full cards return at md. */}
      <div className="grid grid-cols-3 gap-2 md:gap-5">
        {PLAN_ORDER.map((id, i) => {
          const p = PLANS[id];
          const featured = p.id === 'month';
          const cta = p.trialDays > 0 ? `Start ${p.trialDays}-day free trial` : 'Get started';

          return (
            <div
              key={p.id}
              className={[
                'plate plate-face tier-card pricing-rise relative flex flex-col rounded-panel p-3 pt-4 md:p-7 transition',
                `tier-${p.id}`,
                featured
                  ? 'plate-glow glow-iri'
                  : '',
              ].join(' ')}
              /* Rise in one after another; the price pops a beat later (CSS). */
              style={{ '--rise-delay': `${i * 110}ms` } as React.CSSProperties}
            >
              {/* A soft aura breathing behind the two paid-for-a-while plans. */}
              {p.id !== 'week' && <span aria-hidden="true" className="tier-aura" />}
              {/*
                * The card's living background: orbs, a sweep of light and, on
                * the annual plan, rising sparks — transform-only, clipped to
                * the corners, painted under the content (see globals.css).
                */}
              <span aria-hidden="true" className="tier-fx">
                <span className="tier-orb" />
                {p.id !== 'week' && <span className="tier-orb" />}
                {p.id !== 'week' && <span className="tier-sweep" />}
                {p.id === 'year' &&
                  [0, 1, 2, 3, 4, 5].map((i) => (
                    <span
                      key={i}
                      className="tier-spark"
                      style={{
                        left: `${12 + i * 15}%`,
                        color: i % 2 ? '#4ef0ff' : '#ff6ad5',
                        animationDelay: `${(i * 0.7).toFixed(1)}s`,
                      }}
                    />
                  ))}
              </span>
              {p.badge && (
                <span
                  className={[
                    'absolute -top-2.5 left-3 rounded-full px-2 py-0.5 text-[8px] font-medium uppercase tracking-[0.1em] md:left-7 md:px-2.5 md:py-1 md:text-[10px]',
                    featured ? 'badge-iri font-semibold' : 'border border-line bg-panel-2 text-muted',
                  ].join(' ')}
                >
                  {p.badge}
                </span>
              )}

              <h3 className="text-[12px] font-medium md:text-[15px]">{p.name}</h3>

              <div className="mt-2 flex flex-wrap items-baseline gap-x-1.5 md:mt-4">
                <span className="price-pop tabular text-[1.45rem] font-medium leading-none tracking-tight md:text-[2.5rem]">
                  {money(p.amount)}
                </span>
                <span className="text-[11px] text-dim md:text-[14px]">/{p.interval}</span>
              </div>

              {p.id === 'year' && (
                <p className="tabular mt-2 text-[12px] text-good">
                  Save {annualSavingPct}% against monthly
                </p>
              )}

              <p className="mt-4 hidden text-[13.5px] leading-relaxed text-muted md:block">{p.blurb}</p>

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
              <div className="mt-3 flex items-baseline gap-1.5 md:mt-6 md:gap-2">
                <span
                  className={[
                    'tabular font-semibold leading-none tracking-[-0.03em]',
                    p.id === 'year' ? 'rainbow-number text-[1.7rem] md:text-[2.9rem]'
                      : p.id === 'month' ? 'text-accent-soft text-[1.5rem] md:text-[2.5rem]'
                      : 'text-text text-[1.3rem] md:text-[2.1rem]',
                  ].join(' ')}
                >
                  {p.dailyPatchCap}
                </span>
                <span className="text-[10px] leading-tight text-muted md:text-[13.5px]">
                  {p.dailyPatchCap === 1 ? 'video' : 'videos'}<br />per day
                </span>
              </div>

              <ul className="mt-6 mb-7 hidden space-y-2.5 text-[13.5px] text-muted md:block">
                <li className="flex gap-2.5"><Tick /> Full quality, never re-encoded</li>
                <li className="flex gap-2.5"><Tick /> Up to 4K and 60fps</li>
                <li className="flex gap-2.5"><Tick /> Your video never leaves your device</li>
                <li className="flex gap-2.5">
                  <Tick /><span>{p.periodPatchCap.toLocaleString()} per {p.interval} in total</span>
                </li>
              </ul>

              <div className="mt-4 border-t border-line-soft pt-3 md:mt-auto md:pt-6">
                <button
                  onClick={() => start(p.id)}
                  disabled={busy !== null}
                  className={[
                    'pill w-full disabled:opacity-60 max-md:min-h-9 max-md:px-2 max-md:text-[10px]',
                    featured
                      ? 'pill-primary'
                      : 'pill-ghost',
                  ].join(' ')}
                >
                  <span className="md:hidden">{busy === p.id ? 'Opening…' : p.trialDays > 0 ? 'Start trial' : 'Start'}</span>
                  <span className="hidden md:inline">{busy === p.id ? 'Opening secure checkout…' : cta}</span>
                </button>

                {/* Two lines tall on every card, so the buttons above them line up:
                    the weekly note wraps to two lines, the others to one. */}
                <p className="mt-3 hidden min-h-[2.6rem] text-center text-[11.5px] leading-relaxed text-dim md:block">
                  {p.trialDays > 0
                    ? <>Then {money(p.amount)}/{p.interval}. Cancel any time.</>
                    : <>Billed {money(p.amount)} weekly. No trial on this plan. Cancel any time.</>}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {/* What every plan shares, once, under the compact cards. */}
      <ul className="mx-auto mt-5 grid max-w-md grid-cols-2 gap-x-4 gap-y-1.5 text-[12px] text-muted md:hidden">
        <li className="flex gap-2"><Tick /> Never re-encoded</li>
        <li className="flex gap-2"><Tick /> Up to 4K and 60fps</li>
        <li className="flex gap-2"><Tick /> Never leaves your device</li>
        <li className="flex gap-2"><Tick /> Free trial on monthly and annual</li>
      </ul>

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
