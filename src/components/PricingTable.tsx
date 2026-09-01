'use client';

import { useState } from 'react';
import { PLANS, PLAN_ORDER, annualSavingPct, disclosure, money, type PlanId } from '@/lib/plans';

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
  const [chosen, setChosen] = useState<PlanId | null>(null);

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
              <div className="mt-6 flex items-baseline gap-2">
                <span className={`tabular text-[2.1rem] font-semibold leading-none tracking-[-0.03em] ${
                  featured ? 'text-accent-soft' : 'text-text'
                }`}>
                  {p.dailyPatchCap}
                </span>
                <span className="text-[13.5px] leading-tight text-muted">
                  {p.dailyPatchCap === 1 ? 'video' : 'videos'}<br />per day
                </span>
              </div>

              <p className="mt-4 text-[12.5px] leading-relaxed text-dim">
                {p.periodPatchCap.toLocaleString()} per {p.interval} in total.
              </p>

              <div className="mt-7 border-t border-line-soft pt-6">
                <button
                  onClick={() => setChosen(p.id)}
                  className={[
                    'block w-full rounded-xl px-5 py-3 text-center text-[14px] font-medium transition',
                    featured
                      ? 'bg-accent text-white hover:bg-accent-soft'
                      : 'border border-line text-text hover:border-dim',
                  ].join(' ')}
                >
                  {cta}
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

      <div className="mt-8 rounded-panel border border-line-soft bg-panel/40 px-6 py-5">
        <div className="legend mb-3 text-[9px] text-dim">Every plan includes</div>
        <ul className="grid gap-2.5 text-[13.5px] text-muted sm:grid-cols-3">
          <li className="flex gap-2.5"><Tick /> Full quality, never re-encoded</li>
          <li className="flex gap-2.5"><Tick /> Up to 4K and 60fps</li>
          <li className="flex gap-2.5"><Tick /> Your video never leaves your device</li>
        </ul>
      </div>

      <p className="mx-auto mt-8 max-w-2xl text-center text-[12.5px] leading-relaxed text-dim">
        All plans are subscriptions that renew automatically until cancelled. You will see the
        exact amount and the exact date of your first charge before entering any card details.
        Cancel in two clicks from Account → Billing.
      </p>

      {chosen && (
        <ConsentDialog plan={chosen} onClose={() => setChosen(null)} />
      )}
    </>
  );
}

function ConsentDialog({
  plan, onClose,
}: { plan: PlanId; onClose: () => void }) {
  const p = PLANS[plan];
  const firstChargeAt = new Date(Date.now() + p.trialDays * 86_400_000);
  const text = disclosure(p, firstChargeAt);

  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function go() {
    /*
     * The button used to be `disabled` until the box was ticked. A disabled
     * control dispatches no click event, so the first press was a genuine silent
     * no-op with nothing but 40% opacity to explain it — a second, smaller
     * "click it twice". The consent gate is unchanged and still mandatory; only
     * the feedback is.
     */
    if (!agreed) {
      setError('Please tick the box above to confirm the subscription terms.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan, consented: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? 'Checkout could not be started. Please try again.');
        return;
      }
      window.location.href = data.url;
    } catch {
      setError('Checkout is temporarily unavailable. Please try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center overflow-y-auto bg-black/75 p-6 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Confirm the ${p.name} plan`}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-panel border border-line bg-panel p-8"
      >
        <h2 className="text-[1.2rem] font-semibold tracking-[-0.01em]">
          {p.name} — {money(p.amount)}/{p.interval}
        </h2>

        {/* The disclosure, adjacent to the control that starts billing. */}
        <p className="mt-5 rounded-xl border border-line bg-bg-soft px-5 py-4 text-[13.5px] leading-relaxed text-text">
          {text}
        </p>

        {/*
          * No sign-in step. This branch used to divert anyone without an account
          * to /sign-in?next=/pricing — which lost the chosen plan on the way
          * back, because it lived in component state, so the user returned to a
          * bare pricing page and had to pick the same plan again. That was the
          * whole of "I got the code and then back to the loop".
          *
          * Stripe collects the email during checkout and the account is created
          * from it. What that does NOT do is prove the buyer controls the
          * address, so paying only signs someone in when the email had no
          * account already; see lib/billing/claim.ts.
          */}
        <p className="mt-5 text-[13px] leading-relaxed text-dim">
          No account needed first — you will enter your email on the next screen and we will set
          one up from it.
        </p>

        <>
          <label className="mt-6 flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
              />
              <span className="text-[13px] leading-relaxed text-muted">
                I understand this is a subscription that renews automatically at{' '}
                <span className="text-text">{money(p.amount)} per {p.interval}</span> until I
                cancel, and that I can cancel any time from Account → Billing.
              </span>
            </label>

            {error && (
              <p className="mt-4 rounded-lg border border-bad/30 bg-bad/5 px-4 py-3 text-[13px] text-text">
                {error}
              </p>
            )}

            <button
              onClick={go}
              disabled={busy}
              className="mt-6 w-full rounded-xl bg-accent px-5 py-3.5 text-[15px] font-medium text-white
                         transition hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? 'Opening secure checkout…' : 'Continue to payment'}
            </button>
        </>

        <button
          onClick={onClose}
          className="mt-3 w-full rounded-xl px-5 py-2.5 text-[13.5px] text-dim transition hover:text-muted"
        >
          Cancel
        </button>

        <p className="mt-5 text-center text-[11.5px] text-dim">
          Payments are handled by Stripe. We never see your card details.
        </p>
      </div>
    </div>
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
