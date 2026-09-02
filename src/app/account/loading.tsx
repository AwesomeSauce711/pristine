import PageShell from '@/components/PageShell';

/*
 * Shown the instant Account is clicked, before the server has answered.
 *
 * /account is the one page that has to ask the database who is looking, so it
 * cannot be prerendered. Without this file a click did nothing visible until
 * that whole round-trip finished -- a couple of seconds of a page that looked
 * ignored. With it, Next prefetches this shell when the link comes into view
 * and swaps it in immediately on the click; the real content streams over it.
 * Same shell, same widths, same heading position, so nothing jumps.
 */
export default function AccountLoading() {
  return (
    <PageShell className="max-w-3xl">
      <h1 className="title-3d text-[1.9rem]">Account</h1>
      <div aria-hidden="true" className="mt-3 h-4 w-56 animate-pulse rounded bg-white/10" />
      <section className="plate plate-face mt-10 rounded-panel p-7" aria-busy="true" aria-label="Loading your account">
        <div className="legend">Subscription</div>
        <div aria-hidden="true" className="mt-4 space-y-3">
          <div className="h-5 w-40 animate-pulse rounded bg-white/10" />
          <div className="h-4 w-72 max-w-full animate-pulse rounded bg-white/[0.07]" />
          <div className="h-4 w-60 max-w-full animate-pulse rounded bg-white/[0.07]" />
          <div className="mt-6 h-11 w-52 animate-pulse rounded-full bg-white/[0.08]" />
        </div>
      </section>
    </PageShell>
  );
}
