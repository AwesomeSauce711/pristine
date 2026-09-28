import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Privacy — Pristine' };

export default function Privacy() {
  return (
    <main id="main" className="mx-auto max-w-2xl px-6 py-16 text-muted">
      <Link href="/" className="text-text hover:text-accent-soft">← Pristine</Link>
      <h1 className="mt-12 text-4xl font-semibold text-text">Privacy</h1>
      <p className="mt-6 leading-relaxed">The video tool runs in your browser. Your selected file and its video and audio are not uploaded to us. The file scan, changes, and download happen on your device.</p>
      <p className="mt-5 leading-relaxed">This site does not require an account, collect email addresses, process payments, or use analytics. Your hosting provider may process basic request logs to serve the website. If you choose to visit GitHub or Buy Me a Coffee, those services have their own privacy policies.</p>
    </main>
  );
}
