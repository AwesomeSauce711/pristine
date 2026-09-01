'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Manage-billing and sign-out buttons.
 *
 * Billing management goes to Stripe's Customer Portal rather than a flow we
 * wrote. Cancellation has to be at least as easy as signing up, and a
 * home-grown cancel flow is exactly where retention dark patterns appear.
 */
export default function BillingActions({ signOutOnly = false }: { signOutOnly?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<'portal' | 'signout' | null>(null);
  const [error, setError] = useState('');

  async function openPortal() {
    setBusy('portal');
    setError('');
    try {
      const res = await fetch('/api/billing/portal', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? 'Could not open billing.');
        return;
      }
      window.location.href = data.url;
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  async function doSignOut() {
    setBusy('signout');
    await fetch('/api/auth/sign-out', { method: 'POST' }).catch(() => {});
    router.push('/');
    router.refresh();
  }

  if (signOutOnly) {
    return (
      <button
        onClick={doSignOut}
        disabled={busy === 'signout'}
        className="mt-8 rounded-xl border border-line px-5 py-2.5 text-[13.5px] text-muted
                   transition hover:border-dim hover:text-text disabled:opacity-40"
      >
        {busy === 'signout' ? 'Signing out…' : 'Sign out'}
      </button>
    );
  }

  return (
    <div className="mt-7">
      <button
        onClick={openPortal}
        disabled={busy === 'portal'}
        className="rounded-xl border border-line px-5 py-3 text-[14px] font-medium text-text
                   transition hover:border-dim disabled:opacity-40"
      >
        {busy === 'portal' ? 'Opening…' : 'Manage billing, update card, or cancel'}
      </button>
      {error && (
        <p className="mt-3 rounded-lg border border-bad/30 bg-bad/5 px-4 py-2.5 text-[13px] text-text">
          {error}
        </p>
      )}
    </div>
  );
}
