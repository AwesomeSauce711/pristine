import Link from 'next/link';
import CompareSlider from '@/components/CompareSlider';
import Nav from '@/components/Nav';
import PricingTable from '@/components/PricingTable';
import Reveal from '@/components/Reveal';

/*
 * The landing page.
 *
 * Every number on this page is measured, and the two clips in the comparison
 * are what TikTok actually served. That is a deliberate constraint: the whole
 * product is "your video arrives the way you made it", and a page that
 * exaggerates to sell that is undercutting its own claim. Where something is a
 * simulation it says so.
 */

const FAQ: { q: string; a: React.ReactNode }[] = [
  {
    q: 'Does my video get uploaded to your servers?',
    a: (
      <>
        No, and this is the part worth understanding. Pristine reads only your file&rsquo;s{' '}
        <span className="tabular text-text">index</span> — typically 30–150&nbsp;KB even for a
        200&nbsp;MB video — and sends just that. The video itself never leaves your device; the
        finished file is assembled in your browser. Tools that upload the whole file cannot say
        this.
      </>
    ),
  },
  {
    q: 'Does it re-encode or upscale my video?',
    a: (
      <>
        Neither. Not one pixel is touched — the picture that comes out is bit-identical to the
        picture that went in, and you can verify that yourself with any tool that hashes a video
        stream. It is not an AI upscaler and will not invent detail your export did not have.
      </>
    ),
  },
  {
    q: 'How is this different from just exporting at higher quality?',
    a: (
      <>
        Export settings change what you send. They do not change what TikTok does with it. Our
        paired test uploaded the same footage twice, minutes apart, from the same account — one
        patched, one not. The unpatched one came back at 720p and 30fps regardless of how good
        the upload was.
      </>
    ),
  },
  {
    q: 'Will this keep working?',
    a: (
      <>
        This works because of how TikTok&rsquo;s ingest sizes its own work, and TikTok can
        change that whenever they like. We will not pretend otherwise — which is why there is no
        lifetime plan; selling you &ldquo;forever&rdquo; for something we do not control would be
        dishonest.
        {' '}
        What we do commit to: finding what changed and shipping a fix is the entire job, and it
        is what we spend our time on. This method was found by measuring what TikTok actually
        serves, and the same work finds the next one. Until it is working again we stop billing
        and tell you plainly — you will hear it from us before you notice it yourself.
      </>
    ),
  },
  {
    q: 'Is this against TikTok’s rules?',
    a: (
      <>
        Pristine does not touch your account, log you in, automate anything, or interact with
        TikTok at all. It hands you a valid MP4 that you upload yourself in the normal way. It
        is your file, made in a way their pipeline handles better.
      </>
    ),
  },
];

export default function Home() {
  return (
    <>
      <Nav />

      <main id="main">
        {/* ---------------------------------------------------------- hero */}
        <section className="relative overflow-hidden">
          <div className="aurora" />
          <div className="relative z-10 mx-auto max-w-6xl px-6 pt-16 pb-16 sm:pt-24 sm:pb-20 md:pt-36">
            <div className="grid items-center gap-14 md:grid-cols-[1.05fr_0.95fr]">
              <div className="rise">
                <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-line
                                bg-panel/70 px-3 py-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-good" />
                  <span className="legend text-[10px] text-muted">
                    Measured, not claimed
                  </span>
                </div>

                <h1 className="text-[clamp(2.6rem,6vw,4.4rem)] font-semibold leading-[1.02] tracking-[-0.03em]">
                  TikTok compresses
                  <br />
                  your video.
                  <br />
                  <span className="text-accent-soft">Pristine stops it.</span>
                </h1>

                <p className="mt-7 max-w-[34rem] text-[1.075rem] leading-relaxed text-muted">
                  Upload normally and TikTok re-encodes your edit to{' '}
                  <span className="tabular text-text">720p</span> and halves the frame rate.
                  Pristine patches the file so it is served back exactly as you made it —{' '}
                  <span className="text-text">byte for byte</span>.
                </p>

                <div className="mt-9 flex flex-wrap items-center gap-3">
                  <Link
                    href="/app"
                    className="rounded-xl bg-accent px-6 py-3.5 text-[15px] font-medium text-white
                               transition hover:bg-accent-soft
                               focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                  >
                    Try it on your video — free
                  </Link>
                  <Link
                    href="#pricing"
                    className="rounded-xl border border-line px-6 py-3.5 text-[15px] text-muted
                               transition hover:border-dim hover:text-text"
                  >
                    See pricing
                  </Link>
                </div>

                <p className="mt-5 text-[13px] text-dim">
                  No account needed to see the result. Your video never leaves your device.
                </p>
              </div>

              <div className="rise" style={{ animationDelay: '120ms' }}>
                <CompareSlider
                  beforeSrc="/demo/before.mp4"
                  afterSrc="/demo/after.mp4"
                  beforePoster="/demo/before.jpg"
                  afterPoster="/demo/after.jpg"
                />
              </div>
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------- numbers */}
        <Reveal>
          <section className="border-y border-line-soft bg-bg-soft">
            <div className="mx-auto max-w-6xl px-6 py-16">
              <p className="legend mb-8">The same 10 seconds, delivered two ways</p>
              <dl className="grid gap-y-10 gap-x-8 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  { n: '9.0×', l: 'the pixels', s: '8,294,400 vs 921,600' },
                  { n: '14.4×', l: 'the bitrate', s: '41.72 vs 2.90 Mbps' },
                  { n: '2×', l: 'the frame rate', s: '60fps vs 30fps' },
                  { n: '0', l: 'compressed versions built', s: 'nothing to fall back to' },
                ].map((m) => (
                  <div key={m.l}>
                    <dt className="tabular text-[2.4rem] font-medium leading-none tracking-tight text-text">
                      {m.n}
                    </dt>
                    <dd className="mt-2 text-[15px] text-text">{m.l}</dd>
                    <dd className="tabular mt-1 text-[12px] text-dim">{m.s}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </section>
        </Reveal>

        {/*
          * Three steps, and deliberately no explanation of the mechanism.
          *
          * A competitor publishes theirs. That is their call; there is no
          * obligation to hand the same thing to everyone else, and a buyer is
          * choosing on the measured result, not on an architecture diagram.
          * What IS stated is everything that affects their decision: the video
          * never leaves the device, nothing is re-encoded, and an audio track is
          * required. Withholding how it works is fine. Withholding what it does
          * to your file would not be.
          */}
        <Reveal>
          <section id="how" className="mx-auto max-w-6xl px-6 py-24">
            <h2 className="max-w-2xl text-[clamp(1.8rem,3.4vw,2.6rem)] font-semibold tracking-[-0.02em]">
              Three steps, about ten seconds
            </h2>
            <p className="mt-4 max-w-2xl text-[1.02rem] leading-relaxed text-muted">
              No install, no account to start, nothing to learn. Your video stays on your device
              the whole time, and the picture that comes out is bit-identical to the one that
              went in.
            </p>

            <ol className="mt-14 grid gap-6 md:grid-cols-3">
              {[
                {
                  k: '01',
                  t: 'Drop your export in',
                  d: 'Your browser reads the index — a few dozen kilobytes — and shows you exactly what it found: resolution, frame rate, codec, level, bitrate.',
                },
                {
                  k: '02',
                  t: 'See it before you decide',
                  d: 'Your video, side by side, as TikTok would deliver it versus what Pristine gets you. No account, no card, no email.',
                },
                {
                  k: '03',
                  t: 'Download and post',
                  d: 'The patched file is assembled in your browser and saves to your device. Upload it to TikTok the way you always do.',
                },
              ].map((s) => (
                <li key={s.k} className="rounded-panel border border-line bg-panel p-7">
                  <div className="tabular text-[12px] text-accent">{s.k}</div>
                  <h3 className="mt-3 text-[1.05rem] font-medium">{s.t}</h3>
                  <p className="mt-2.5 text-[14px] leading-relaxed text-muted">{s.d}</p>
                </li>
              ))}
            </ol>
          </section>
        </Reveal>

        {/* ---------------------------------------------------------- proof */}
        <Reveal>
          <section className="border-y border-line-soft bg-bg-soft">
            <div className="mx-auto max-w-6xl px-6 py-24">
              <div className="grid gap-14 md:grid-cols-[0.9fr_1.1fr]">
                <div>
                  <p className="legend mb-4">How we know</p>
                  <h2 className="text-[clamp(1.7rem,3vw,2.3rem)] font-semibold tracking-[-0.02em]">
                    One controlled test, not a claim
                  </h2>
                  <p className="mt-5 text-[15px] leading-relaxed text-muted">
                    The same footage was uploaded twice, minutes apart, from the same account —
                    an account with <span className="text-text">zero followers</span>, so nothing
                    could be explained away by reputation. The only difference between the two
                    files was the patch.
                  </p>
                  <p className="mt-4 text-[15px] leading-relaxed text-muted">
                    The patched file came back{' '}
                    <span className="text-text">byte-for-byte identical</span> to what was sent,
                    and TikTok never built a compressed version of it at all — so there is
                    nothing for a viewer&rsquo;s player to drop down to.
                  </p>
                </div>

                <div className="rounded-panel border border-line bg-panel p-6 font-mono text-[12.5px] leading-[1.9]">
                  <div className="legend mb-4 text-[9px]">What TikTok returned</div>
                  <div className="grid grid-cols-[auto_1fr] gap-x-5">
                    <span className="text-dim">control</span>
                    <span className="tabular text-muted">
                      720×1280 &nbsp; 30fps &nbsp; 2.90 Mbps
                    </span>
                    <span className="text-dim">&nbsp;</span>
                    <span className="tabular text-bad">re-encoded to a smaller copy</span>

                    <span className="mt-4 text-dim">patched</span>
                    <span className="tabular mt-4 text-text">
                      2160×3840 &nbsp; 60fps &nbsp; 41.72 Mbps
                    </span>
                    <span className="text-dim">&nbsp;</span>
                    <span className="tabular text-good">served exactly as uploaded</span>
                  </div>
                  <div className="mt-6 border-t border-line-soft pt-4 text-[11.5px] text-dim">
                    52,323,644 bytes sent · 52,323,644 bytes served
                  </div>
                </div>
              </div>
            </div>
          </section>
        </Reveal>

        {/* -------------------------------------------------------- pricing */}
        <Reveal>
          <section id="pricing" className="mx-auto max-w-6xl px-6 py-24">
            <div className="mb-14 text-center">
              <h2 className="text-[clamp(1.8rem,3.4vw,2.6rem)] font-semibold tracking-[-0.02em]">
                Try it on your own video first
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-muted">
                See the result before you pay for it. You only need a plan when you want to
                download the file.
              </p>
            </div>
            <PricingTable />
          </section>
        </Reveal>

        {/* ------------------------------------------------------------ faq */}
        <Reveal>
          <section id="faq" className="border-t border-line-soft bg-bg-soft">
            <div className="mx-auto max-w-3xl px-6 py-24">
              <h2 className="mb-12 text-[clamp(1.7rem,3vw,2.2rem)] font-semibold tracking-[-0.02em]">
                FAQ
              </h2>
              {/*
                * <details>, not a JS accordion. It opens with no hydration, it is
                * keyboard-operable and screen-reader-announced for free, and the
                * answers stay in the DOM so browser find-in-page and search
                * crawlers still reach them. A hand-rolled version would be more
                * code and worse on every one of those counts.
                */}
              <div className="divide-y divide-line-soft border-y border-line-soft">
                {FAQ.map((f) => (
                  <details key={f.q} className="group">
                    <summary
                      className="flex cursor-pointer list-none items-center justify-between gap-6 py-5
                                 text-[1.02rem] font-medium transition hover:text-accent-soft
                                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft
                                 [&::-webkit-details-marker]:hidden"
                    >
                      {f.q}
                      <svg
                        aria-hidden viewBox="0 0 20 20" fill="none"
                        className="h-4 w-4 shrink-0 text-dim transition-transform duration-200 group-open:rotate-180"
                      >
                        <path d="M5 7.5 10 12.5 15 7.5" stroke="currentColor" strokeWidth="1.6"
                              strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </summary>
                    <div className="pb-6 pr-10 text-[14.5px] leading-relaxed text-muted">{f.a}</div>
                  </details>
                ))}
              </div>
            </div>
          </section>
        </Reveal>
      </main>

      <footer className="border-t border-line-soft">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-12 text-[13px] text-dim
                        sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} Pristine</p>
          {/* min-h-11 keeps these at a 44px touch target. At their natural
                20px they were below the WCAG 2.2 minimum and genuinely fiddly
                to hit on a phone. */}
            <nav className="flex flex-wrap items-center gap-6">
            <Link href="/legal/terms" className="inline-flex min-h-11 items-center transition hover:text-text">Terms</Link>
            <Link href="/legal/privacy" className="inline-flex min-h-11 items-center transition hover:text-text">Privacy</Link>
            <Link href="/legal/refunds" className="inline-flex min-h-11 items-center transition hover:text-text">Refunds</Link>
          </nav>
        </div>
        <div className="mx-auto max-w-6xl px-6 pb-12">
          <p className="max-w-3xl text-[11.5px] leading-relaxed text-dim/70">
            Pristine is not affiliated with, endorsed by, or connected to TikTok or ByteDance.
            &ldquo;TikTok&rdquo; is used only to describe what this tool is compatible with.
            Results depend on your source file, and the behaviour this relies on is outside our
            control and may change.
          </p>
        </div>
      </footer>
    </>
  );
}
