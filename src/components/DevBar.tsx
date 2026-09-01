'use client';

import { useCallback, useEffect, useState } from 'react';

/*
 * A development-only bar for exercising the paid flow without Stripe.
 *
 * It renders nothing unless the server says the unlock is available, and the
 * server only says that when NODE_ENV is not production AND
 * PRISTINE_DEV_UNLOCK=1. So in a real deployment this component mounts, asks
 * once, and returns null forever.
 *
 * Deliberately loud — amber, fixed, and labelled as a simulation. A quiet dev
 * affordance is one you forget is switched on.
 *
 * It does NOT fake entitlement in the browser. It sets a cookie that the real
 * `resolveAccess` recognises, so every request still goes through the genuine
 * server-side check and the same `/api/patch` code path a paying customer hits.
 * The only thing being stubbed is where the subscription came from.
 */

interface Me {
  entitled: boolean;
  state: string;
  tier: string | null;
  dailyRemaining: number;
  devUnlockAvailable: boolean;
}

export default function DevBar() {
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/me', { cache: 'no-store' });
      setMe(await res.json());
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  if (!me?.devUnlockAvailable) return null;

  async function toggle() {
    setBusy(true);
    try {
      await fetch('/api/dev/unlock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lock: me?.entitled === true }),
      });
      await refresh();
      // The server components on this page render from entitlement too.
      window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  /*
   * Bottom-RIGHT and collapsible, not centred. Centred at the bottom it sat
   * directly on top of the preview mockups — the one thing on the page anyone
   * actually wants to look at.
   */
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        aria-label="Open developer controls"
        className="fixed bottom-4 right-4 z-[120] flex h-9 items-center gap-2 rounded-full
                   border border-warn/40 bg-[#1a1508] px-3 text-[11px] text-warn
                   transition hover:brightness-125"
      >
        <span className={`h-1.5 w-1.5 rounded-full ${me.entitled ? 'bg-good' : 'bg-dim'}`} />
        dev
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-[120] w-[248px] rounded-xl border
                    border-warn/40 bg-[#1a1508] px-4 py-3 shadow-xl">
      <div className="flex items-start justify-between gap-2">
        <span className="legend text-[9px] leading-relaxed text-warn">
          Dev mode<br />Stripe not wired
        </span>
        <button
          onClick={() => setOpen(false)}
          aria-label="Hide developer controls"
          className="-mr-1 -mt-1 px-1.5 text-[16px] leading-none text-dim transition hover:text-muted"
        >
          ×
        </button>
      </div>

      <p className="tabular mt-2.5 text-[11.5px] leading-relaxed text-dim">
        {me.entitled
          ? <>entitled · <span className="text-good">{me.state}</span> · {me.tier}<br />{me.dailyRemaining} patches left today</>
          : <>not entitled · <span className="text-muted">{me.state}</span></>}
      </p>

      <button
        onClick={toggle}
        disabled={busy}
        className="mt-3 w-full rounded-lg bg-warn px-3 py-2 text-[12px] font-medium text-black
                   transition hover:brightness-110 disabled:opacity-40"
      >
        {busy ? '…' : me.entitled ? 'Lock again' : 'Simulate subscription'}
      </button>
    </div>
  );
}
