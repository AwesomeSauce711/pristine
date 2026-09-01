'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

/*
 * The one part of the nav that depends on who is looking.
 *
 * WHY IT FETCHES RATHER THAN READING THE SESSION ON THE SERVER
 * Nav renders inside the root layout, so a server-side session read would force
 * every page — landing, pricing, legal — to render dynamically and lose its
 * prerendering. Fetching keeps them static at the cost of one small request and
 * a brief moment on the default label.
 *
 * WHY THE DEFAULT IS THE SIGNED-OUT LABEL
 * Most visitors are signed out, so that is the correct thing to show while the
 * answer is unknown. Showing "Account" first and correcting to "Try free" would
 * flash the wrong state at exactly the people the button is aimed at.
 *
 * Display only. Every page it links to enforces its own access server-side.
 */
export default function NavCta() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    const check = () => fetch('/api/me', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: { signedIn?: boolean }) => { if (live) setSignedIn(!!d.signedIn); })
      .catch(() => { /* leave it on the signed-out default */ });

    void check();
    // Signing in happens in this tab; coming back to it should reflect that.
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    return () => { live = false; window.removeEventListener('focus', onFocus); };
  }, []);

  const classes =
    'ml-1 rounded-lg bg-accent px-4 py-2 text-[14px] font-medium text-white transition ' +
    'hover:bg-accent-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft';

  if (signedIn) {
    return <Link href="/account" className={classes}>Account</Link>;
  }
  return <Link href="/app" className={classes}>Try free</Link>;
}
