'use client';

import Link from 'next/link';
import { useEffect } from 'react';

/*
 * Route-level error boundary.
 *
 * Deliberately shows no stack trace and no error text from the exception. A
 * production stack trace tells an attacker about the code and tells the person
 * reading it nothing they can act on. The digest is shown because it is the one
 * thing that lets support correlate a report with a server log line.
 *
 * The reassurance about billing is not filler. This boundary can be hit at any
 * point, including just after checkout, and "did that charge me twice?" is the
 * first thing someone thinks when a payment flow breaks.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[app] unhandled error', error);
  }, [error]);

  return (
    <main id="main" className="mx-auto max-w-lg px-6 py-32 text-center">
      <p className="legend text-warn">Something broke</p>
      <h1 className="mt-4 text-[1.8rem] font-semibold tracking-[-0.02em]">
        That didn&rsquo;t work
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed text-muted">
        Something went wrong on our side. Your video was never uploaded, and if you have a
        subscription nothing has been charged or used up.
      </p>

      <div className="mt-9 flex flex-wrap justify-center gap-3">
        <button
          onClick={reset}
          className="rounded-xl bg-accent px-6 py-3 text-[14px] font-medium text-white transition hover:bg-accent-soft"
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded-xl border border-line px-6 py-3 text-[14px] text-muted transition hover:border-dim hover:text-text"
        >
          Back home
        </Link>
      </div>

      {error.digest && (
        <p className="tabular mt-10 text-[11.5px] text-dim">
          Reference: {error.digest}
        </p>
      )}
    </main>
  );
}
