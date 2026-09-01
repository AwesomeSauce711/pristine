'use client';

import { useEffect, useState } from 'react';

/*
 * The customer-facing half of the kill switch.
 *
 * WHY THIS FETCHES INSTEAD OF RENDERING ON THE SERVER
 * It lives in the root layout, and a server component that reads the database
 * there would force every page in the site to render dynamically — losing the
 * static prerendering of the marketing pages for a banner that is invisible on
 * every normal day. Fetching keeps those pages static and costs one small
 * request. The trade is a brief moment before it appears, which is acceptable
 * for a notice and would not be for a paywall.
 *
 * This is display only. Selling is stopped server-side in the checkout route;
 * nothing here is load-bearing, so a reader with JS disabled sees a working site
 * rather than a broken one.
 *
 * When it does render it is deliberately plain. Someone who paid for this needs
 * to know it is not working, and dressing that up reads as evasion. Saying it
 * first is also the cheapest dispute prevention there is: a customer who was
 * told emails you instead of their bank.
 */

interface State {
  status: 'ok' | 'degraded' | 'broken';
  note: string | null;
}

const DEFAULT_NOTE = {
  degraded:
    'We are investigating reports that uploads are being re-encoded. New subscriptions are '
    + 'paused while we check. Existing subscriptions are unaffected.',
  broken:
    'TikTok has changed how uploads are processed and the patch is not currently having any '
    + 'effect. New subscriptions are paused and we have stopped billing. Existing customers do '
    + 'not need to do anything.',
};

export default function StatusBanner() {
  const [state, setState] = useState<State | null>(null);

  useEffect(() => {
    let live = true;
    fetch('/api/status', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: State) => { if (live) setState(d); })
      .catch(() => { /* a banner that cannot load is not worth an error */ });
    return () => { live = false; };
  }, []);

  if (!state || state.status === 'ok') return null;
  const broken = state.status === 'broken';

  return (
    <div
      role="status"
      className={`border-b px-5 py-3 text-center text-[13.5px] leading-relaxed ${
        broken ? 'border-bad/30 bg-bad/10 text-bad' : 'border-warn/30 bg-warn/10 text-warn'
      }`}
    >
      <strong className="font-medium">
        {broken ? 'Not working right now.' : 'Something may be wrong.'}
      </strong>{' '}
      {state.note ?? (broken ? DEFAULT_NOTE.broken : DEFAULT_NOTE.degraded)}
    </div>
  );
}
