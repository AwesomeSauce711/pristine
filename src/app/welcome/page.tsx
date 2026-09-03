'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import PageShell from '@/components/PageShell';
import Plate3D from '@/components/Plate3D';

/*
 * The three outcomes of a checkout that do NOT go straight back to the tool.
 *
 * A successful, fully-resolved payment never reaches this page at all —
 * /api/billing/claim redirects to /app?resume=1, where the file the user
 * stashed is restored and the download starts on its own. Landing here means
 * something needs saying:
 *
 *   code     the email already had an account. The subscription is attached to
 *            it, but paying is not proof of controlling an address, so a code is
 *            required before anyone is signed in. This is the anti-takeover rule
 *            and it is the whole reason this page still exists.
 *   pending  Stripe has not marked the session complete yet, or the webhook is
 *            still in flight. Poll our own state rather than believing the URL.
 *   error    something failed. The webhook is authoritative and will have done
 *            the work, so the honest instruction is to sign in.
 */

type State = 'code' | 'pending' | 'error' | 'unknown';

function Welcome() {
  const params = useSearchParams();
  const state = (params.get('state') ?? 'unknown') as State;
  const email = params.get('email') ?? '';
  const [entitled, setEntitled] = useState(false);

  const check = useCallback(async () => {
    try {
      const res = await fetch('/api/me', { cache: 'no-store' });
      const data = await res.json();
      return Boolean(data.entitled);
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    if (state !== 'pending') return;
    let cancelled = false;
    let attempts = 0;
    const tick = async () => {
      if (cancelled) return;
      if (await check()) { if (!cancelled) setEntitled(true); return; }
      if (++attempts < 12) setTimeout(tick, 1500);
    };
    void tick();
    return () => { cancelled = true; };
  }, [state, check]);

  return (
    <>
      <PageShell className="max-w-lg">
        <Plate3D depth={10} tilt={1.5} className="p-7 md:p-9">
        {state === 'code' && (
          <>
            <h1 className="title-3d text-[1.7rem]">
              Payment received — one more step
            </h1>
            <p className="mt-4 text-[15px] leading-relaxed text-muted">
              {email ? <><span className="text-text">{email}</span> already has</> : 'That email already has'}{' '}
              an account here, and your plan has been added to it.
            </p>
            <p className="mt-4 text-[14px] leading-relaxed text-muted">
              We have emailed a sign-in code. We ask for it because paying proves you own a card,
              not that you own this address — and we are not willing to hand over an existing
              account on the strength of the first one.
            </p>
            {/* A code has just been sent to this address, so the sign-in page
                is asked to open at the code step for it rather than at the
                email step, which would ask for a second code. The address is
                already in this page's URL, so nothing new is exposed. */}
            <Link
              href={`/sign-in?next=%2Fapp&sent=1${email ? `&email=${encodeURIComponent(email)}` : ''}`}
              className="pill pill-primary mt-8 w-full"
            >
              Enter the code
            </Link>
          </>
        )}

        {state === 'pending' && (
          <>
            <h1 className="title-3d text-[1.7rem]">
              {entitled ? 'You’re all set' : 'Finishing up…'}
            </h1>
            <p className="mt-4 text-[15px] leading-relaxed text-muted">
              {entitled
                ? 'Your plan is active.'
                : 'Stripe is confirming the payment. This usually takes a second or two.'}
            </p>
            <Link
              href="/app"
              className="pill pill-primary mt-8 w-full"
            >
              Back to the tool
            </Link>
          </>
        )}

        {(state === 'error' || state === 'unknown') && (
          <>
            <h1 className="title-3d text-[1.7rem]">
              Sign in to pick up where you left off
            </h1>
            <p className="mt-4 text-[15px] leading-relaxed text-muted">
              If you have just paid, your plan is on the account for the email you used at
              checkout — nothing is lost. Sign in with that address and it will be there.
            </p>
            <Link
              href="/sign-in?next=%2Fapp"
              className="pill pill-primary mt-8 w-full"
            >
              Sign in
            </Link>
          </>
        )}
        </Plate3D>
      </PageShell>
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Welcome />
    </Suspense>
  );
}
