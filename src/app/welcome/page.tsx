'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import Nav from '@/components/Nav';

/*
 * Where Stripe sends people after checkout.
 *
 * The webhook is what actually grants access, and it usually lands before the
 * browser finishes redirecting. This page therefore waits for OUR OWN state to
 * say the subscription is live, rather than believing the redirect — the URL is
 * something the browser supplies and proves nothing.
 *
 * If polling does not resolve quickly, it falls back to an explicit reconcile
 * using the session id, which is validated server-side against the signed-in
 * user. A customer who has paid must never be left looking at a paywall, and
 * "wait and refresh" is not an acceptable answer at the moment money changed
 * hands.
 */

type Phase = 'checking' | 'ready' | 'slow' | 'failed';

function Welcome() {
  const params = useSearchParams();
  const sessionId = params.get('session_id');
  const [phase, setPhase] = useState<Phase>('checking');

  const check = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch('/api/me', { cache: 'no-store' });
      const data = await res.json();
      return Boolean(data.entitled);
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;

    const tick = async () => {
      if (cancelled) return;
      if (await check()) {
        if (!cancelled) setPhase('ready');
        return;
      }
      attempts += 1;

      // ~12 seconds of patience before trying the explicit reconcile.
      if (attempts < 8) {
        setTimeout(tick, 1500);
        return;
      }

      try {
        await fetch('/api/billing/sync', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        });
        if (await check()) {
          if (!cancelled) setPhase('ready');
          return;
        }
      } catch {
        /* fall through */
      }
      if (!cancelled) setPhase(attempts > 12 ? 'failed' : 'slow');
      if (attempts <= 12) setTimeout(tick, 2500);
    };

    void tick();
    return () => { cancelled = true; };
  }, [check, sessionId]);

  return (
    <div className="mx-auto max-w-lg px-6 py-28 text-center">
      {phase === 'ready' ? (
        <>
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-good/10">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" className="text-good" aria-hidden="true">
              <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <h1 className="mt-7 text-[1.8rem] font-semibold tracking-[-0.02em]">You&rsquo;re all set</h1>
          <p className="mt-3 text-[15px] leading-relaxed text-muted">
            Your plan is active. Downloads are unlocked — go and patch something.
          </p>
          <Link
            href="/app"
            className="mt-8 inline-block rounded-xl bg-accent px-7 py-3.5 text-[15px] font-medium text-white transition hover:bg-accent-soft"
          >
            Open the tool
          </Link>
          <p className="mt-6 text-[13px] text-dim">
            A receipt is on its way by email. Manage or cancel any time from{' '}
            <Link href="/account" className="underline hover:text-muted">Account</Link>.
          </p>
        </>
      ) : phase === 'failed' ? (
        <>
          <h1 className="text-[1.6rem] font-semibold tracking-[-0.02em]">
            Your payment went through
          </h1>
          <p className="mt-3 text-[15px] leading-relaxed text-muted">
            We just haven&rsquo;t finished confirming it on our side. This clears itself within a
            few minutes — nothing has gone wrong with your payment and you will not be charged
            twice.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <button
              onClick={() => window.location.reload()}
              className="rounded-xl bg-accent px-6 py-3 text-[14px] font-medium text-white transition hover:bg-accent-soft"
            >
              Check again
            </button>
            <Link
              href="/account"
              className="rounded-xl border border-line px-6 py-3 text-[14px] text-muted transition hover:border-dim hover:text-text"
            >
              Go to account
            </Link>
          </div>
        </>
      ) : (
        <>
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-line border-t-accent" />
          <h1 className="mt-7 text-[1.5rem] font-semibold tracking-[-0.02em]">
            Confirming your subscription…
          </h1>
          <p className="mt-3 text-[14.5px] leading-relaxed text-muted">
            {phase === 'slow'
              ? 'Taking a little longer than usual. Your payment is safe — we are just waiting on confirmation.'
              : 'This usually takes a second or two.'}
          </p>
        </>
      )}
    </div>
  );
}

export default function WelcomePage() {
  return (
    <>
      <Nav />
      <main id="main">
        <Suspense fallback={null}>
          <Welcome />
        </Suspense>
      </main>
    </>
  );
}
