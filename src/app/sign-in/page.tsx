'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import PageShell from '@/components/PageShell';
import Plate3D from '@/components/Plate3D';

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
  /* Only a path on this site. A full URL here would be an open redirect: a
   * crafted link that signs someone in and then sends them anywhere. A
   * backslash counts as a slash to the URL parser ("/\evil.com" resolves to
   * https://evil.com/), and the router hard-navigates to a foreign origin, so
   * a second slash of either kind is refused. */
  const rawNext = params.get('next') ?? '/app';
  const next = /^\/(?![/\\])/.test(rawNext) ? rawNext : '/app';
  /* Sent here by the Download button: the file is stashed and waiting. */
  const forDownload = next.includes('intent=download');

  /* Sent here by the welcome page after a purchase landed on an existing
   * account: a code is already on its way to `email`, so this opens at the
   * code step rather than asking for a second one. Anyone can craft these
   * two params; the code step keeps "Use a different email" for that. */
  const sentTo = params.get('sent') === '1' ? (params.get('email') ?? '').trim() : '';
  const [step, setStep] = useState<'email' | 'code'>(sentTo ? 'code' : 'email');
  const [email, setEmail] = useState(sentTo);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [devCode, setDevCode] = useState('');
  const submitting = useRef(false);

  /* The address this device signed in with last time, offered again. An
   * address is not a secret, and typing it on a phone is the slowest step. */
  useEffect(() => {
    let last = '';
    try { last = localStorage.getItem('pristine:email') ?? ''; } catch { /* storage off */ }
    if (!last) return;
    const t = setTimeout(() => setEmail((cur) => cur || last), 0);
    return () => clearTimeout(t);
  }, []);

  async function requestCode(e?: React.FormEvent) {
    e?.preventDefault();
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
      try { localStorage.setItem('pristine:email', email); } catch { /* storage off */ }
      if (data.devCode) setDevCode(data.devCode);
      setStep('code');
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function verify(e?: React.FormEvent) {
    e?.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
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
      submitting.current = false;
      setBusy(false);
    }
  }

  /* Six digits typed or pasted: go, without a second tap. */
  useEffect(() => {
    if (step !== 'code' || code.length !== 6 || busy) return;
    const t = setTimeout(() => { void verify(); }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, step]);

  return (
    <Plate3D depth={10} tilt={1.5} className="w-full p-8 md:p-11">
      <h1 className="title-3d text-[2rem] md:text-[2.3rem]">
        {step === 'email' ? (forDownload ? 'Sign in to download' : 'Sign in') : 'Check your email'}
      </h1>
      <p className="mt-3 text-[15.5px] leading-relaxed text-muted">
        {step === 'email'
          ? (forDownload
              ? 'Your video is waiting. We email you a six-digit code; then you pick a plan and the download starts on its own.'
              : 'No password to remember. We email you a six-digit code, and this device stays signed in.')
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
            className="field py-4 text-[17px]"
          />
          <button
            type="submit"
            disabled={busy}
            className="pill pill-primary min-h-[52px] w-full text-[12.5px] disabled:opacity-40"
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
            className="field tabular py-4 text-center text-[30px] tracking-[0.4em]"
          />
          <button
            type="submit"
            disabled={busy || code.length < 6}
            className="pill pill-primary min-h-[52px] w-full text-[12.5px] disabled:opacity-40"
          >
            {busy ? 'Checking…' : 'Sign in'}
          </button>
          {/* Codes get lost in spam and junk; asking again is the same request. */}
          <button
            type="button"
            disabled={busy}
            onClick={() => { setCode(''); setError(''); void requestCode(); }}
            className="w-full py-2 text-[13.5px] text-dim transition hover:text-muted disabled:opacity-40"
          >
            Send a new code
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
    </Plate3D>
  );
}

export default function SignInPage() {
  return (
    <>
      {/* Centred in the viewport, not hung from the top: this is the one page
          that is nothing but the form. */}
      <PageShell className="flex min-h-[100svh] max-w-lg items-center">
        <Suspense fallback={null}>
          <SignInForm />
        </Suspense>
      </PageShell>
    </>
  );
}
