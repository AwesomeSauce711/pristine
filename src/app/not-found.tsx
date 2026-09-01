import Link from 'next/link';
import Nav from '@/components/Nav';

export default function NotFound() {
  return (
    <>
      <Nav />
      <main id="main" className="mx-auto max-w-lg px-6 py-32 text-center">
        <p className="legend">404</p>
        <h1 className="mt-4 text-[1.8rem] font-semibold tracking-[-0.02em]">
          There&rsquo;s nothing here
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted">
          That page doesn&rsquo;t exist, or it moved.
        </p>
        <div className="mt-9 flex flex-wrap justify-center gap-3">
          <Link
            href="/app"
            className="rounded-xl bg-accent px-6 py-3 text-[14px] font-medium text-white transition hover:bg-accent-soft"
          >
            Open the tool
          </Link>
          <Link
            href="/"
            className="rounded-xl border border-line px-6 py-3 text-[14px] text-muted transition hover:border-dim hover:text-text"
          >
            Back home
          </Link>
        </div>
      </main>
    </>
  );
}
