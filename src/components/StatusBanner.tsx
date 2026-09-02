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

/*
 * The wording matches the Terms and the refund policy exactly: subscriptions
 * and access continue, the fix is the priority, time lost past fourteen days
 * is credited. Nothing here promises to stop billing.
 */
const DEFAULT_NOTE = {
  degraded:
    'We are looking into reports that some uploads are being re-encoded. Everything else is '
    + 'running as normal, and we will post an update here as soon as we know more.',
  broken:
    'TikTok has changed how uploads are processed and Pristine is temporarily not having its '
    + 'intended effect. We are on it and will have it back up and running as soon as possible. '
    + 'Your subscription and access continue and resume automatically when it is restored; any '
    + 'time lost beyond 14 days is added to your plan. New subscriptions are paused until then.',
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
        {broken ? 'Temporarily not working — a fix is in progress.' : 'We are checking something.'}
      </strong>{' '}
      {state.note ?? (broken ? DEFAULT_NOTE.broken : DEFAULT_NOTE.degraded)}
    </div>
  );
}
