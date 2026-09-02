'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import CompareStage from '@/components/CompareStage';
import Plate3D from '@/components/Plate3D';
import PricingTable from '@/components/PricingTable';
import Reveal from '@/components/Reveal';
import SceneNav from '@/components/SceneNav';
import Wordmark from '@/components/Wordmark';
import CountUp from '@/components/fx/CountUp';
import Globe from '@/components/fx/Globe';
import GrowIn from '@/components/fx/GrowIn';
import RibbonField from '@/components/fx/RibbonField';
import SceneSection from '@/components/fx/SceneSection';
import Starfield from '@/components/fx/Starfield';
import { play, soundProps } from '@/lib/sound';

/*
 * The landing page.
 *
 * Every number on this page is measured, and the two clips in the comparison
 * are what TikTok actually served. That is a deliberate constraint: the whole
 * product is "your video arrives the way you made it", and a page that
 * exaggerates to sell that is undercutting its own claim. Where something is a
 * simulation it says so.
 *
 * COMPOSITION
 * One page, no header bar. The starfield is a fixed canvas behind everything;
 * the sections are transparent over it. The hero is scenery: the nav's links
 * and its floating dock (SceneNav), the reader's engagement raining upward
 * behind the headline (HeroField, three.js) and thin threads of chrome
 * (RibbonField), all canvases and layers inside the one section. Everything
 * after it is a run of SceneSections — each a perspective of its own — in
 * which the panels of text are glass slabs (Plate3D) that rise in as the
 * reader reaches them and lean with the pointer, and the comparison stage
 * holds the phone in a real hand.
 *
 * WHY <main> HAS NO Z-INDEX ANY MORE
 * The nav's dock is `position: fixed` inside the hero, inside main. A z-index
 * on main would make main a stacking context, and everything painted after
 * main — the footer — would then cover the dock whenever the two overlap. So
 * nothing on the page has a z-index except the starfield, which is pushed to
 * −10 instead; every section, plate and canvas paints above it in tree order,
 * and the dock's own z-index works in the root context as it should.
 *
 * WHY THIS IS A CLIENT COMPONENT
 * HeroField is three.js and must never enter the server bundle or the first
 * paint, which is `next/dynamic` with `ssr: false` — and Next allows that
 * only inside a client component. The page still prerenders to the same
 * HTML; the only difference is where the bundle boundary sits.
 *
 * Nothing is ever layered ABOVE the two autoplaying videos (the grain note in
 * globals.css records what happened last time something was). Everything
 * decorative — the fields, the globe, the drawn-in bars, the slab edges, the
 * giant wordmark above the footer — is aria-hidden and adds no copy of its
 * own; the words a screen reader meets are exactly the words in the source.
 */

/* Loaded only in the browser, after the first paint: it is three.js. */
const HeroField = dynamic(() => import('@/components/three/HeroField'), { ssr: false });

/* The export advice, at the foot of the page. */
const EXPORT_TIPS = [
  {
    h: 'Up to 4K, up to 60 fps',
    p: 'Pristine keeps exactly what you give it. 1080p at 60 fps stays 1080p at 60 fps; 4K at 60 fps stays 4K at 60 fps. Nothing is upscaled and nothing is dropped.',
  },
  {
    h: 'Not above 60 fps',
    p: 'TikTok cuts anything above 60 fps down to 30, and Pristine never changes your frame rate — that would mean touching your picture. If you shot at 120 fps, export at 60.',
  },
  {
    h: 'Shot in 1080p or 30 fps?',
    p: 'Upscale it first with Topaz Video AI — 4K and 60 fps — then export and bring that file here. What you send is what gets served.',
  },
];

const FAQ: { q: string; a: React.ReactNode }[] = [
  {
    q: 'Does my video get uploaded to your servers?',
    a: (
      <>
        No, and this is the part worth understanding. Your video is read on your device, and
        only a few kilobytes of technical information about the file — never the picture, never
        the sound — are sent. The finished file is assembled in your browser. Tools that upload
        the whole file cannot say this.
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
        through Pristine, one not. The plain one came back at 720p and 30fps regardless of how good
        the upload was.
      </>
    ),
  },
  {
    q: 'Will this keep working?',
    a: (
      <>
        This depends on how TikTok processes uploads, and TikTok can change that whenever they
        like. We will not pretend otherwise — which is why there is no
        lifetime plan; selling you &ldquo;forever&rdquo; for something we do not control would be
        dishonest.
        {' '}
        What we do commit to: finding what changed and shipping a fix is the entire job, and it
        is what we spend our time on. This method was found by measuring what TikTok actually
        serves, and the same work finds the next one. If it ever stops, you will hear it from
        us before you notice it yourself, your access carries on and resumes by itself when it is
        back, and any time lost beyond 14 days is added to your plan.
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

/* The four measured figures, and the three steps. Strings exactly as they
 * have always read; only the panels around them changed. */
const NUMBERS = [
  { n: '9.0×', l: 'the pixels', s: '8,294,400 vs 921,600' },
  { n: '14.4×', l: 'the bitrate', s: '41.72 vs 2.90 Mbps' },
  { n: '2×', l: 'the frame rate', s: '60fps vs 30fps' },
  { n: '0', l: 'compressed versions built', s: 'nothing to fall back to' },
];
const STEPS = [
  {
    k: '01',
    t: 'Drop your export in',
    d: 'Your browser reads the file right on your device — nothing is uploaded — and shows you exactly what it found: resolution and frame rate.',
  },
  {
    k: '02',
    t: 'See it before you decide',
    d: 'Your video, side by side, as TikTok would deliver it versus what Pristine gets you. No account, no card, no email.',
  },
  {
    k: '03',
    t: 'Download and post',
    d: 'The finished file is assembled in your browser and saves to your device. Upload it to TikTok the way you always do.',
  },
];

/*
 * The proof readout's bars are the two control-versus-patched ratios drawn to
 * scale: width for resolution, then bitrate. The figures are the measured ones
 * printed beside them, so the bars can never disagree with the text.
 */
const CONTROL_WIDTH_RATIO = 720 / 2160;
const CONTROL_BITRATE_RATIO = 2.9 / 41.72;

/*
 * The full iridescent spectrum as a horizontal gradient, for the few places
 * that need it as a paint rather than as text (the patched bars). Reads the
 * tokens so it can never drift from the wordmark.
 */
const IRI_BAR =
  'bg-[linear-gradient(90deg,var(--color-iri-pink),var(--color-iri-violet),var(--color-iri-blue),var(--color-iri-cyan))]';

/*
 * Every wrapper between a SceneSection and the plates inside it has to keep
 * the 3D chain intact, or the plates fall back to a flat projection at that
 * wrapper. One class, named once.
 */
const KEEP_3D = '[transform-style:preserve-3d]';

/* The stagger between neighbouring plates, ms. */
const STAGGER = 90;

/* A counter landing is a tick; four of them land STAGGER ms apart. */
const tick = () => play('tick');

/**
 * A full-bleed iridescent hairline between sections, faded at both ends so it
 * reads as a line of light rather than a border. Replaces the solid bands the
 * sections used to sit on: over a starfield a band is a wall. It sits between
 * SceneSections, never inside one — its mask is a grouping property and would
 * flatten a 3D context it was part of.
 */
function Rule() {
  return (
    <div
      aria-hidden
      className="iri-line opacity-25 [mask-image:linear-gradient(90deg,transparent,#000_18%,#000_82%,transparent)]"
    />
  );
}

export default function Home() {
  return (
    <>
      {/* Behind the page at −10: see the note on z-index above. */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
        <Starfield />
      </div>

      <main id="main" className="relative">
        {/* ---------------------------------------------------------- hero */}
        {/*
          * A plain `relative` section, not a SceneSection: the dock inside
          * SceneNav is `position: fixed`, and a `perspective` on an ancestor
          * would become its containing block and pin it to the hero. The
          * nav's own 3D layer is a container of its own inside it.
          *
          * The headline is mixed case, left-aligned, in the hero face, and
          * balanced by the browser; the second sentence is a block so it
          * always starts a line of its own and, on a phone, breaks after the
          * name rather than leaving "it." alone.
          */}
        {/* The hero and the comparison share one sky: the scenery spans
            both and thins out toward the bottom of the comparison, so the
            field does not stop dead at the hero's edge and the colour does
            not change under the phone. The wrapper has no perspective (the
            dock inside SceneNav is fixed) and no stacking context of its
            own, so the scenery's −10 still resolves behind the page. */}
        <div className="relative overflow-x-clip">
          {/* The scenery, behind the copy at −10 in tree order: the reader's
              engagement raining upward, and thin threads of chrome mirrored
              to the right so the headline keeps the left third. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10
                       [mask-image:linear-gradient(to_bottom,#000_38%,transparent_60%)]"
          >
            <HeroField />
            <div className="absolute inset-0" style={{ transform: 'scaleX(-1)' }}>
              <RibbonField intensity={0.5} thickness={0.22} />
            </div>
          </div>

        <section className="relative flex min-h-[100svh] flex-col">
          <SceneNav />
          {/* Shelter for the words: the scenery dims under the copy's column
              and is untouched on the right, where most of it rises. Painted
              after the canvases at the same level, so it lands on top of them
              and under the text. A gradient, not a blur. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10
                       bg-[linear-gradient(90deg,rgba(5,6,12,0.86)_0%,rgba(5,6,12,0.62)_38%,rgba(5,6,12,0.18)_62%,rgba(5,6,12,0)_78%)]
                       max-md:bg-[linear-gradient(180deg,rgba(5,6,12,0.45)_0%,rgba(5,6,12,0.78)_40%,rgba(5,6,12,0.78)_72%,rgba(5,6,12,0.3)_100%)]"
          />

          <div
            className="relative mx-auto flex w-full max-w-7xl flex-1 flex-col justify-center px-6
                       pt-28 pb-24 sm:pt-32 md:pb-28"
          >
            <div className="rise">
              {/* The badge: the same words, the same live dot. */}
              <div className="mb-7 flex items-center gap-2.5">
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-good
                             shadow-[0_0_10px_var(--color-good)]"
                />
                <span className="legend text-[10px] leading-[1.6] text-muted">
                  Measured, not claimed
                </span>
              </div>

              <h1 className="hero-h1">
                TikTok <span className="hero-word">compresses</span> your video.{' '}
                <span className="block">
                  <span className="brand" {...soundProps('brand')}>Pristine</span> stops it.
                </span>
              </h1>
            </div>

            <div className="rise mt-10 max-w-[34rem] md:mt-12" style={{ animationDelay: '120ms' }}>
              <p className="text-[1.075rem] leading-relaxed text-muted">
                Upload normally and TikTok re-encodes your edit to{' '}
                <span className="tabular text-text">720p</span> and halves the frame rate.
                Pristine makes sure it is served back exactly as you made it —{' '}
                <span className="text-text">byte for byte</span>.
              </p>

              <div className="mt-9 flex flex-wrap items-center gap-3">
                <Link href="/app" className="pill pill-primary" {...soundProps('hover')}>
                  Try it on your video — free
                </Link>
                <Link href="#pricing" className="pill pill-ghost" {...soundProps('hover')}>
                  See pricing
                </Link>
              </div>

              <p className="mt-5 text-[13px] text-dim">
                No account needed to see the result. Your video never leaves your device.
              </p>
            </div>
          </div>
        </section>

        {/* ----------------------------------------------------- comparison */}
        {/*
          * No heading on purpose: the clips are the argument. The stage brings
          * its own perspective, hand and tilt; the SceneSection around it
          * clips sideways overflow so the holograms and the hand can reach
          * past the phone without anything widening the page. Nothing here
          * carries a data-depth: the phone already moves with the reader.
          */}
        <SceneSection className="py-10 md:py-16">
          <CompareStage
            src="/demo/pair.mp4"
            poster="/demo/pair.jpg"
          />
        </SceneSection>
        </div>

        {/* -------------------------------------------------------- numbers */}
        {/*
          * Four slabs, rising in one after another; each figure counts up
          * and ticks when it lands. Each slab holds its own <dl> so the
          * markup stays conforming with the slab's layers around it.
          */}
        <Rule />
        <SceneSection className="py-20 md:py-24">
          <div className={`mx-auto max-w-6xl px-6 ${KEEP_3D}`}>
            <div data-depth="0.05">
              <Reveal>
                <p className="legend mb-8">The same 10 seconds, delivered two ways</p>
              </Reveal>
            </div>
            <div className={`grid gap-4 sm:grid-cols-2 lg:grid-cols-4 ${KEEP_3D}`}>
              {NUMBERS.map((m, i) => (
                <Plate3D key={m.l} delay={i * STAGGER} className="p-6 md:p-7">
                  <GrowIn className="iri-line mb-6" delay={i * STAGGER} />
                  <dl>
                    <dt className="brand tabular text-[2.6rem] font-medium leading-none tracking-tight">
                      <CountUp value={m.n} delay={i * STAGGER} onDone={tick} />
                    </dt>
                    <dd className="mt-3 text-[15px] text-text">{m.l}</dd>
                    <dd className="tabular mt-1 text-[12px] text-dim">{m.s}</dd>
                  </dl>
                </Plate3D>
              ))}
            </div>
          </div>
        </SceneSection>

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
        <Rule />
        <SceneSection id="how" className="py-24">
          <div className={`mx-auto max-w-6xl px-6 ${KEEP_3D}`}>
            <div data-depth="0.05">
              <Reveal>
                <h2 className="title-3d max-w-2xl text-[clamp(1.8rem,3.4vw,2.6rem)]">
                  Three steps, about ten seconds
                </h2>
                <p className="mt-4 max-w-2xl text-[1.02rem] leading-relaxed text-muted">
                  No install, no account to start, nothing to learn. Your video stays on your device
                  the whole time, and the picture that comes out is bit-identical to the one that
                  went in.
                </p>
              </Reveal>
            </div>

            <div className={`relative mt-14 ${KEEP_3D}`}>
              {/* Decorative: one line of light running behind the three slabs
                  at the height of their step numbers, so they read as a
                  sequence. It sits a little behind the slabs' plane, so it
                  passes behind them and shows crisp in the gaps. */}
              <div
                aria-hidden
                className="iri-line pointer-events-none absolute inset-x-10 top-[37px] hidden opacity-40 md:block"
                style={{ transform: 'translateZ(-24px)' }}
              />
              <ol className={`grid gap-6 md:grid-cols-3 ${KEEP_3D}`}>
                {STEPS.map((s, i) => (
                  <li key={s.k} className={`grid ${KEEP_3D}`}>
                    <Plate3D delay={i * STAGGER} className="p-7">
                      <div className="brand tabular text-[12px]">{s.k}</div>
                      <h3 className="mt-3 text-[1.05rem] font-medium">{s.t}</h3>
                      <p className="mt-2.5 text-[14px] leading-relaxed text-muted">{s.d}</p>
                    </Plate3D>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </SceneSection>

        {/* ---------------------------------------------------------- proof */}
        <Rule />
        <SceneSection className="py-24">
          {/* Decorative: a large iridescent globe low in the empty corner
              under the text column, drifting on scroll at its own depth.
              Non-interactive and pointer-transparent, so nothing under it is
              ever harder to hit. */}
          <div
            aria-hidden
            data-depth="0.14"
            className="pointer-events-none absolute bottom-0 -left-16 hidden opacity-70 md:block lg:-left-8"
          >
            <Globe size={220} tone="iri" interactive={false} />
          </div>

          <div className={`relative mx-auto max-w-6xl px-6 ${KEEP_3D}`}>
            <div className={`grid gap-14 md:grid-cols-[0.9fr_1.1fr] ${KEEP_3D}`}>
              <div data-depth="0.04">
                <Reveal>
                  <p className="legend mb-4">How we know</p>
                  <h2 className="title-3d text-[clamp(1.7rem,3vw,2.3rem)]">
                    One controlled test, not a claim
                  </h2>
                  <p className="mt-5 text-[15px] leading-relaxed text-muted">
                    The same footage was uploaded twice, minutes apart, from the same account —
                    an account with <span className="text-text">zero followers</span>, so nothing
                    could be explained away by reputation. The only difference between the two
                    files was Pristine.
                  </p>
                  <p className="mt-4 text-[15px] leading-relaxed text-muted">
                    The Pristine file came back{' '}
                    <span className="text-text">byte-for-byte identical</span> to what was sent,
                    and TikTok never built a compressed version of it at all — so there is
                    nothing for a viewer&rsquo;s player to drop down to.
                  </p>
                </Reveal>
              </div>

              {/* The readout: the one slab on the page with the iridescent
                  ring, and a little thicker — it is the evidence. */}
              <Plate3D glow depth={14} tilt={5}>
                <div className="p-6 font-mono text-[12.5px] leading-[1.9]">
                  <div className="legend mb-4 text-[9px]">What TikTok returned</div>
                  <div className="grid grid-cols-[auto_1fr] gap-x-5">
                    <span className="text-dim">normal</span>
                    <span className="tabular text-muted">
                      720×1280 &nbsp; 30fps &nbsp; 2.90 Mbps
                    </span>
                    <span className="text-dim">&nbsp;</span>
                    <span className="tabular text-bad">re-encoded to a smaller copy</span>
                    {/* Decorative: the control's width and bitrate as a
                        fraction of the patched file's, drawn to scale. */}
                    <span aria-hidden />
                    <div aria-hidden className="mt-2 flex flex-col gap-1">
                      <GrowIn
                        className="h-[3px] rounded-full bg-bad/60"
                        style={{ width: `${CONTROL_WIDTH_RATIO * 100}%` }}
                      />
                      <GrowIn
                        className="h-[3px] rounded-full bg-bad/35"
                        style={{ width: `${CONTROL_BITRATE_RATIO * 100}%` }}
                        delay={100}
                      />
                    </div>

                    <span className="mt-4 text-dim">Pristine</span>
                    <span className="tabular mt-4 text-text">
                      2160×3840 &nbsp; 60fps &nbsp; 41.72 Mbps
                    </span>
                    <span className="text-dim">&nbsp;</span>
                    <span className="tabular text-good">served exactly as uploaded</span>
                    <span aria-hidden />
                    <div aria-hidden className="mt-2 flex flex-col gap-1">
                      <GrowIn
                        className={`h-[3px] w-full rounded-full ${IRI_BAR} shadow-[0_0_12px_rgba(78,240,255,0.35)]`}
                        delay={200}
                      />
                      <GrowIn
                        className={`h-[3px] w-full rounded-full ${IRI_BAR} opacity-70`}
                        delay={300}
                      />
                    </div>
                  </div>
                  <div className="mt-6 border-t border-line-soft pt-4 text-[11.5px] text-dim">
                    52,323,644 bytes sent · 52,323,644 bytes served
                  </div>
                </div>
              </Plate3D>
            </div>
          </div>
        </SceneSection>

        {/* -------------------------------------------------------- pricing */}
        <Rule />
        <SceneSection id="pricing" className="py-24">
          <div className={`mx-auto max-w-6xl px-6 ${KEEP_3D}`}>
            <div data-depth="0.05" className="mb-14 text-center">
              <Reveal>
                <h2 className="title-3d text-[clamp(1.8rem,3.4vw,2.6rem)]">
                  Try it on your own video first
                </h2>
                <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-muted">
                  See the result before you pay for it. You only need a plan when you want to
                  download the file.
                </p>
              </Reveal>
            </div>
            {/* The cards carry the slab material as classes (PricingTable);
                they are still, so the fade around them flattens nothing. */}
            <Reveal delay={80}>
              <PricingTable />
            </Reveal>
          </div>
        </SceneSection>

        {/* ------------------------------------------------------------ faq */}
        <Rule />
        <SceneSection id="faq" className="py-24">
          <div className={`mx-auto max-w-3xl px-6 ${KEEP_3D}`}>
            <div data-depth="0.05">
              <Reveal>
                <h2 className="title-3d mb-12 text-[clamp(1.7rem,3vw,2.2rem)]">
                  FAQ
                </h2>
              </Reveal>
            </div>
            {/* One gradient, defined once, that every chevron below strokes
                with while its row is open. Zero-sized but not display:none,
                which would make the reference dead. */}
            <svg aria-hidden width="0" height="0" className="absolute" focusable="false">
              <defs>
                <linearGradient id="faq-iri" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" style={{ stopColor: 'var(--color-iri-pink)' }} />
                  <stop offset="0.35" style={{ stopColor: 'var(--color-iri-violet)' }} />
                  <stop offset="0.7" style={{ stopColor: 'var(--color-iri-blue)' }} />
                  <stop offset="1" style={{ stopColor: 'var(--color-iri-cyan)' }} />
                </linearGradient>
              </defs>
            </svg>
            {/*
              * <details>, not a JS accordion. It opens with no hydration, it is
              * keyboard-operable and screen-reader-announced for free, and the
              * answers stay in the DOM so browser find-in-page and search
              * crawlers still reach them. A hand-rolled version would be more
              * code and worse on every one of those counts. Each one sits in
              * a slab of its own, which grows with it when it opens.
              */}
            <div className={`space-y-3 ${KEEP_3D}`}>
              {FAQ.map((f, i) => (
                <Plate3D key={f.q} delay={i * 70} tilt={4} className="px-6">
                  <details className="group">
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
                              strokeLinecap="round" strokeLinejoin="round"
                              className="group-open:[stroke:url(#faq-iri)]" />
                      </svg>
                    </summary>
                    <div className="pb-6 pr-10 text-[14.5px] leading-relaxed text-muted">{f.a}</div>
                  </details>
                </Plate3D>
              ))}
            </div>
          </div>
        </SceneSection>

        {/* ---- before you export ----
          * The practical advice, low on the page but never hidden: what to
          * export, what Pristine keeps, and what to do with footage that is
          * not 4K60 yet. It says nothing about how the file is prepared. */}
        <SceneSection id="export" className="pb-24">
          <div className="mx-auto max-w-3xl px-6">
            <h2 className="title-3d text-[clamp(1.6rem,3vw,2.2rem)] leading-tight">Before you export</h2>
            <div className="mt-8 grid gap-4 md:grid-cols-3">
              {EXPORT_TIPS.map((t, i) => (
                <Plate3D key={t.h} depth={8} tilt={1.5} delay={i * 90} className="px-6 py-5">
                  <h3 className="text-[15px] font-medium">{t.h}</h3>
                  <p className="mt-2 text-[14px] leading-relaxed text-muted">{t.p}</p>
                </Plate3D>
              ))}
            </div>
          </div>
        </SceneSection>
      </main>

      {/* Decorative: the wordmark at page width, fading out under the footer.
          aria-hidden on the wrapper — it repeats the brand, it says nothing.
          Outside any SceneSection: its mask would flatten one. */}
      <div
        aria-hidden
        className="pointer-events-none relative flex select-none justify-center overflow-hidden pt-12 opacity-25
                   [mask-image:linear-gradient(to_bottom,#000_15%,transparent_92%)] md:pt-20"
      >
        <Wordmark size="giant" />
      </div>

      <footer className="relative">
        <Rule />
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
