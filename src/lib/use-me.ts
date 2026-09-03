'use client';

import { useEffect, useState } from 'react';

/*
 * What the UI may assume about the reader: signed in or not, subscribed or
 * not. FOR DISPLAY ONLY -- /api/patch decides for real on every call. Fetched
 * once on mount and again when the tab regains focus, because signing in and
 * paying both happen in this tab and coming back to it should show it.
 */
export interface Me {
  /** null until the first answer arrives. */
  signedIn: boolean | null;
  entitled: boolean;
}

export function useMe(): Me {
  const [me, setMe] = useState<Me>({ signedIn: null, entitled: false });
  useEffect(() => {
    let live = true;
    const check = () => fetch('/api/me', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: { signedIn?: boolean; entitled?: boolean }) => {
        if (live) setMe({ signedIn: !!d.signedIn, entitled: !!d.entitled });
      })
      .catch(() => { /* leave the signed-out default */ });
    void check();
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    return () => { live = false; window.removeEventListener('focus', onFocus); };
  }, []);
  return me;
}
