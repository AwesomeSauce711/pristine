import Link from 'next/link';
import PageShell from '@/components/PageShell';

export default function NotFound() {
  return (
    <>
      <PageShell className="max-w-lg text-center">
        <p className="legend">404</p>
        <h1 className="title-3d mt-4 text-[1.8rem]">
          There&rsquo;s nothing here
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted">
          That page doesn&rsquo;t exist, or it moved.
        </p>
        <div className="mt-9 flex flex-wrap justify-center gap-3">
          <Link
            href="/app"
            className="pill pill-primary"
          >
            Open the tool
          </Link>
          <Link
            href="/"
            className="pill pill-ghost"
          >
            Back home
          </Link>
        </div>
      </PageShell>
    </>
  );
}
