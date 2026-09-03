'use client';

import { useEffect, useState } from 'react';

/*
 * What the UI may assume about the reader: signed in or not, subscribed or
 * not. FOR DISPLAY ONLY -- /api/patch decides for real on every call. Fetched
 * once on mount and again when the tab regains focus, because signing in and
 * paying both happen in this tab and coming back to it should show it.
 */
export interface Me {
  /** null until the first answer arrives, so the UI can avoid a flash. */
  signedIn: boolean | null;
  /** May download right now: a live plan with allowance, or a bought download. */
  entitled: boolean;
  /** A live subscription, whether or not there is allowance left today. */
  hasPlan: boolean;
  /** The plan's id when there is one. */
  tier: string | null;
}

export function useMe(): Me {
  const [me, setMe] = useState<Me>({ signedIn: null, entitled: false, hasPlan: false, tier: null });
  useEffect(() => {
    let live = true;
    const check = () => fetch('/api/me', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: { signedIn?: boolean; entitled?: boolean; hasPlan?: boolean; tier?: string | null }) => {
        if (live) {
          setMe({
            signedIn: !!d.signedIn,
            entitled: !!(d.entitled || d.hasPlan),
            hasPlan: !!d.hasPlan,
            tier: d.tier ?? null,
          });
        }
      })
      .catch(() => { /* leave the signed-out default */ });
    void check();
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    return () => { live = false; window.removeEventListener('focus', onFocus); };
  }, []);
  return me;
}
