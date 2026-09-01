'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import Nav from '@/components/Nav';

/*
 * Sign in with an emailed code. No passwords.
 *
 * There is nothing here worth the support burden and breach risk of storing
 * passwords: an account represents control of an email address and a
 * subscription, and a short-lived code proves exactly that.
 *
 * The UI never reveals whether an address already has an account — the server
 * responds identically either way, and so does this. Telling an anonymous
 * visitor which emails are registered is an enumeration oracle that helps
 * nobody who owns the address.
 */

function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') ?? '/app';

  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [devCode, setDevCode] = useState('');

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/auth/request-code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? 'Could not send a code. Please try again.');
        return;
      }
      if (data.devCode) setDevCode(data.devCode);
      setStep('code');
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/auth/verify-code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, code }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? 'That code did not work.');
        return;
      }
      router.push(next);
      router.refresh();
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md px-6 py-24">
      <h1 className="text-[1.7rem] font-semibold tracking-[-0.02em]">
        {step === 'email' ? 'Sign in' : 'Check your email'}
      </h1>
      <p className="mt-3 text-[14.5px] leading-relaxed text-muted">
        {step === 'email'
          ? 'We will email you a six-digit code. No password to remember.'
          : <>We sent a code to <span className="text-text">{email}</span>. It expires in ten minutes.</>}
      </p>

      {step === 'email' ? (
        <form onSubmit={requestCode} className="mt-8 space-y-4">
          <input
            type="email"
            required
            autoFocus
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="w-full rounded-xl border border-line bg-panel px-4 py-3.5 text-[15px]
                       outline-none transition placeholder:text-dim focus:border-accent"
          />
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-xl bg-accent px-5 py-3.5 text-[15px] font-medium text-white
                       transition hover:bg-accent-soft disabled:opacity-40"
          >
            {busy ? 'Sending…' : 'Email me a code'}
          </button>
        </form>
      ) : (
        <form onSubmit={verify} className="mt-8 space-y-4">
          {/*
            * maxLength is deliberately NOT 6. It truncates the RAW pasted string
            * before onChange can see it, so a code copied as "1 2 6 3 3 8"
            * arrived as "1 2 6 " and was stripped to three digits — exactly how
            * this presented: half the code pasted, the rest typed by hand. The
            * length limit belongs after the non-digits are removed, not before.
            */}
          <input
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={24}
            required
            autoFocus
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            className="tabular w-full rounded-xl border border-line bg-panel px-4 py-3.5
                       text-center text-[24px] tracking-[0.4em] outline-none transition
                       placeholder:text-dim focus:border-accent"
          />
          <button
            type="submit"
            disabled={busy || code.length < 6}
            className="w-full rounded-xl bg-accent px-5 py-3.5 text-[15px] font-medium text-white
                       transition hover:bg-accent-soft disabled:opacity-40"
          >
            {busy ? 'Checking…' : 'Sign in'}
          </button>
          <button
            type="button"
            onClick={() => { setStep('email'); setCode(''); setError(''); setDevCode(''); }}
            className="w-full py-2 text-[13.5px] text-dim transition hover:text-muted"
          >
            Use a different email
          </button>
        </form>
      )}

      {devCode && (
        <p className="mt-5 rounded-lg border border-warn/30 bg-warn/5 px-4 py-3 text-[13px] text-muted">
          Development only — no email provider is configured yet, so the code is{' '}
          <span className="tabular text-text">{devCode}</span>.
        </p>
      )}

      {error && (
        <p className="mt-5 rounded-lg border border-bad/30 bg-bad/5 px-4 py-3 text-[13.5px] text-text">
          {error}
        </p>
      )}

      <p className="mt-8 text-[12.5px] leading-relaxed text-dim">
        By continuing you agree to our{' '}
        <Link href="/legal/terms" className="underline hover:text-muted">Terms</Link> and{' '}
        <Link href="/legal/privacy" className="underline hover:text-muted">Privacy Policy</Link>.
      </p>
    </div>
  );
}

export default function SignInPage() {
  return (
    <>
      <Nav />
      <main id="main">
        <Suspense fallback={null}>
          <SignInForm />
        </Suspense>
      </main>
    </>
  );
}
