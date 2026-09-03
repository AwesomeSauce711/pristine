'use client';

import Link from 'next/link';
import { useMe } from '@/lib/use-me';

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
/*
 * Two buttons, two jobs.
 *
 *   account  the top-right corner: who you are. "Sign in" when signed out
 *            (sign-up is the same door -- an emailed code creates the account),
 *            "Account" when signed in. Never an invitation to upload.
 *   upload   the hero and the scroll dock: what you came to do. "Try free"
 *            for a stranger, "Upload" for a subscriber. Both go to the tool.
 */
export default function NavCta({ mode = 'upload' }: { mode?: 'account' | 'upload' }) {
  const { signedIn, entitled } = useMe();

  const classes =
    'ml-1 pill pill-primary pill-sm';

  if (mode === 'account') {
    return signedIn
      ? <Link href="/account" className={classes}>Account</Link>
      : <Link href="/sign-in" className={classes}>Sign in</Link>;
  }
  return <Link href="/app" className={classes}>{entitled ? 'Upload' : 'Try free'}</Link>;
}
