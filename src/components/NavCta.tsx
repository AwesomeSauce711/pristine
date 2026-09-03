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
export default function NavCta({ tryFree = true }: { tryFree?: boolean }) {
  const { signedIn, entitled } = useMe();

  const classes =
    'ml-1 pill pill-primary pill-sm';

  /* A subscriber's one action is to upload; the account is a link away. */
  if (entitled) {
    return <Link href="/app" className={classes}>Upload</Link>;
  }
  if (signedIn) {
    return <Link href="/account" className={classes}>Account</Link>;
  }
  return (
    <>
      <Link href="/sign-in" className="nav-link hidden sm:inline-flex">Sign in</Link>
      {tryFree && <Link href="/app" className={classes}>Try free</Link>}
    </>
  );
}
