'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import Plate3D from '@/components/Plate3D';
import PreviewCompare, { PreviewNote } from '@/components/PreviewCompare';
import PricingTable from '@/components/PricingTable';
import SceneNav from '@/components/SceneNav';
import SceneStage from '@/components/Stage';
import Starfield from '@/components/fx/Starfield';
import { CRUSHED_STATS, PRISTINE_ENGAGEMENT, PRISTINE_STATS, randomPristine } from '@/lib/engagement';
import DropMorph from '@/components/DropMorph';
import Link from 'next/link';

/* The rising likes, comments, shares and bookmarks behind the drop zone — the
 * hero's field, on the page where the reader actually drops a file. three.js,
 * so it never enters the server bundle or the first paint. */
const HeroField = dynamic(() => import('@/components/three/HeroField'), { ssr: false });
import { Mp4Error } from '@/lib/mp4/boxes';
import { assemble, scanFile, type ScanResult } from '@/lib/mp4/scan';
import { play, soundProps } from '@/lib/sound';
import { clearStash, peekStashedFile, rehydrateFile, stashFile } from '@/lib/stash';

/*
 * Wait for the copy to be written before any navigation destroys the page. It
 * used to be fired and forgotten a moment before leaving for sign-in or Stripe,
 * which is a race a large file loses -- and the return then said the copy
 * could not be kept. Never hang the button on a slow disk, though: past eight
 * seconds, go anyway, and the return will say so.
 */
async function stashBeforeLeaving(file: File): Promise<boolean> {
  return Promise.race([
    stashFile(file),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 8000)),
  ]);
}

/*
 * The tool.
 *
 * The order here is the product. Someone drops a file, sees what it is, and
 * sees what it will look like — all before anything is asked of them. The
 * paywall lands on Download and nowhere earlier, because the thing being sold
 * is a feeling about their own video, and you cannot sell that from a pricing
 * table.
 *
 * Everything up to Download is local: the file is read with Blob.slice, only
 * the index is parsed, and the preview plays from an object URL. Nothing is
 * uploaded, which is both the privacy claim and the reason this works on a
 * phone.
 *
 * THE SCENE
 * The tool stands in the same scenery as the landing page — the starfield,
 * the nav floating in the corners rather than sitting on a bar, the dropzone
 * and the download panel as glass plates, and the preview held in the same
 * hand and the same phone (Stage → Phone3D) the hero uses — so the thing
 * someone tries is visibly the thing they were shown. None of it touches the
 * order above: the state machine, the scan, the paywall and the download are
 * exactly as they were; the scene only wraps them. The sounds are fired from
 * effects that watch that state (the preview arriving, the receipt appearing)
 * and from the handlers' wrappers (a file landing) — never from inside `take`
 * or `download`.
 *
 * The paywall's backdrop no longer blurs: a backdrop filter across the whole
 * viewport re-blurred the playing preview and the hand's canvases under it
 * every frame, which is the grain-overlay mistake in globals.css over again.
 * It is a darker plain wash instead, and the offer stands on a glowing plate.
 */

type Stage = 'idle' | 'scanning' | 'ready' | 'error';

/*
 * What the patch actually did, shown after the download.
 *
 * This is a receipt, not decoration. The whole product is an invisible change —
 * the picture is bit-identical and the file plays the same — so without stating
 * what was altered there is nothing to distinguish a working patch from a plain
 * copy of the input. `edtsNeutralised` in particular is worth showing: an
 * inherited edit list silently cancelled the method, and a file that needed that
 * fix looks exactly like one that did not.
 */
interface Receipt {
  outputLen: number;
  realSamples: number;
  phantomSamples: number;
  multiplier: number;
  clonedTrack: boolean;
  neutralisedEdts: boolean;
}

/* Illustrative engagement, labelled as such wherever it is shown. */

/*
 * The preview's screen is 9:19.5 (a phone), and the stage sizes the phone's
 * box as width × aspect — its default, 16/9, is the landing slider's 9:16
 * screen written as height over width — so the app passes the same ratio the
 * same way up. 336 is the width the preview has always had.
 */
const PREVIEW_WIDTH = 336;
const PREVIEW_ASPECT = 19.5 / 9;

/*
 * The download takes a few seconds on purpose. The work itself is quick, but
 * a file that appears the instant a button is pressed reads as "nothing
 * happened" — and trains people to expect instant, which a future version
 * that genuinely needs longer would then break. So the button holds for at
 * least PATCH_MIN_MS and shows what is being done, in words that describe the
 * outcome and never the means. The hold is only ever padding: if the real
 * work takes longer, the file arrives when it is ready.
 */
const PATCH_MIN_MS = 3800;
const PATCH_STEPS = ['Reading your file', 'Preparing your video', 'Assembling the file', 'Checking every byte'];
const holdPatch = (startedAt: number) =>
  new Promise<void>((r) => window.setTimeout(r, Math.max(0, PATCH_MIN_MS - (performance.now() - startedAt))));

export default function AppPage() {
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState<string>('');
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState<string>('');
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [paywall, setPaywall] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [autoDownload, setAutoDownload] = useState(false);
  const [resumeNote, setResumeNote] = useState(false);
  /*
   * Known before the user presses Download, so the paywall can appear instantly
   * instead of after a round trip. Display only — /api/patch re-resolves access
   * server-side on every call, so this being wrong or tampered with changes what
   * the page looks like and nothing else.
   */
  const [entitled, setEntitled] = useState(false);
  /* null until /api/me has answered once; the download button waits on it. */
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  /* A restored file arrives with no drop, so the drop-to-phone morph is
   * skipped for it: nothing to fly from, and the morph plays a second copy
   * of the video while hiding the real stage until its animation ends. */
  const [skipMorph, setSkipMorph] = useState(false);
  const router = useRouter();
  /* Which of PATCH_STEPS is showing while the download is being prepared. */
  const [patchStep, setPatchStep] = useState(0);
  /*
   * The one instruction that matters after the file is saved, shown as a
   * pop-up the moment the download lands: upload it as it is. Anything that
   * touches the file first — a trim, a re-export, another app — makes a new
   * file, and the new file is not the one that was prepared.
   */
  const [notice, setNotice] = useState(false);
  /* A fresh set of million-scale figures for each file dropped in. Drawn
   * during render on purpose: the preview only ever renders on the client,
   * after a scan, so there is no server figure for it to disagree with. */
  const pristine = useMemo(() => (scan ? randomPristine() : PRISTINE_ENGAGEMENT), [scan]);

  /* Step through the labels while busy; a tick marks each one. */
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => {
      setPatchStep((s) => {
        if (s < PATCH_STEPS.length - 1) play('tick');
        return Math.min(PATCH_STEPS.length - 1, s + 1);
      });
    }, PATCH_MIN_MS / PATCH_STEPS.length);
    return () => window.clearInterval(id);
  }, [busy]);
  /*
   * Where the preview's split sits, reported by PreviewCompare, so the stage
   * can light the phone and the hand by how much Pristine shows. Presentation
   * only: nothing about the file or the download reads it.
   */
  const [pos, setPos] = useState(50);
  const onPos = useCallback((p: number) => setPos(p), []);

  const refreshAccess = useCallback(async (): Promise<{ signedIn: boolean; entitled: boolean }> => {
    try {
      const res = await fetch('/api/me', { cache: 'no-store' });
      const data = await res.json();
      const next = { signedIn: Boolean(data.signedIn), entitled: Boolean(data.entitled) };
      setSignedIn(next.signedIn);
      setEntitled(next.entitled);
      return next;
    } catch {
      /* leave them as they were; the server decides anyway */
      return { signedIn: signedIn ?? false, entitled };
    }
    // Reads the latest state only for the failure fallback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { void refreshAccess(); }, [refreshAccess]);
  const inputRef = useRef<HTMLInputElement>(null);
  /* For the morph from the drop zone into the phone (DropMorph): where the
   * zone is while it exists, and the stage it becomes once it does. */
  const dropRef = useRef<HTMLLabelElement>(null);
  const stageWrapRef = useRef<HTMLDivElement>(null);

  // Object URLs leak the whole file until revoked, which matters when the file
  // is 500 MB and someone tries a few in a row.
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  /*
   * COMING BACK FROM STRIPE.
   *
   * The claim route sends a successful checkout to /app?resume=1. The file the
   * user dropped was stashed just before they left, so it is restored here and
   * the download fires on its own — no re-selecting, no second Download press.
   * That round trip is what "I had to go through the whole process again" was.
   *
   * If nothing was stashed (quota, private window, a different browser) the page
   * simply shows the normal dropzone with a line explaining what to do. Paid
   * access is already on the account either way, so the second attempt succeeds.
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('resume') !== '1') return;
    /*
     * Two ways back here with a stashed file:
     *   paid=1          from Stripe, via the claim route.
     *   intent=download from sign-in, which the Download button sent them to.
     *
     * THE FILE FIRST. The preview is on screen within a second of arriving,
     * before anything is asked of the server. The previous order waited for
     * access before touching the file, which left the reader on the empty
     * drop zone for as long as the webhook took -- the "back to the upload
     * screen" that was reported.
     *
     * THEN ACCESS, quietly. Straight back from Stripe the webhook that grants
     * it may still be in flight, so keep asking for a few seconds and start
     * the download on its own the moment it lands. Back from sign-in with no
     * payment there is nothing to wait for and nothing to open: the plans
     * appear only when they press Download themselves, having seen their
     * own comparison.
     */
    const paid = params.get('paid') === '1';

    // Drop the flags immediately so a refresh does not try to resume twice.
    window.history.replaceState(null, '', '/app');

    let cancelled = false;
    (async () => {
      /* Peek, restore, then clear: the stash is the only copy, and a restore
       * interrupted by a re-mount must be able to run again. */
      const stashed = await peekStashedFile();
      if (cancelled) return;
      if (!stashed) { setResumeNote(true); void refreshAccess(); return; }
      /* The copy STAYS until a download succeeds: from here the reader may
       * still go to the plans and to Stripe, and the copy must survive that
       * trip too. Clearing it here and re-writing it later was where it was
       * lost. Re-read into memory first so it plays like a fresh file. */
      const f = await rehydrateFile(stashed);
      if (cancelled) return;
      setSkipMorph(true);
      await take(f);
      if (cancelled) return;

      let access = await refreshAccess();
      if (!paid) return;
      for (let i = 0; i < 12 && !cancelled && !access.entitled; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        access = await refreshAccess();
      }
      if (!cancelled && access.entitled) setAutoDownload(true);
    })();
    return () => { cancelled = true; };
    // `take` is stable for the life of the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * Fire the download once the restored file has finished scanning. Separate
   * from the effect above because scanning is async and sets state; calling
   * download() before `scan` exists would patch nothing.
   */
  useEffect(() => {
    if (!autoDownload || stage !== 'ready' || !scan || busy) return;
    setAutoDownload(false);
    void download();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDownload, stage, scan, busy]);

  /*
   * SOUNDS, from state.
   *
   * The two moments the page should feel good at — the preview arriving, the
   * file saved — are read off state the page already keeps, so nothing in the
   * flow changes to make a noise. `stage` is compared with what it was, not
   * only what it is, so a re-render while ready does not chime again; every
   * receipt is a new object, so a second download is a second success.
   */
  const heardStage = useRef<Stage>(stage);
  useEffect(() => {
    const was = heardStage.current;
    heardStage.current = stage;
    if (stage === 'ready' && was !== 'ready') play('reveal');
  }, [stage]);
  useEffect(() => {
    if (receipt) play('success');
  }, [receipt]);
  /* Escape closes the notice. */
  useEffect(() => {
    if (!notice) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNotice(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [notice]);

  const take = useCallback(async (f: File) => {
    setStage('scanning');
    setError('');
    setScan(null);
    setReceipt(null);
    setUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return ''; });

    try {
      const result = await scanFile(f);
      setScan(result);
      setFile(f);
      setUrl(URL.createObjectURL(f));
      setStage('ready');
    } catch (e) {
      setError(e instanceof Mp4Error ? e.message : 'That file could not be read as an MP4.');
      setStage('error');
    }
  }, []);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    setSkipMorph(false);
    if (f) void take(f);
  };

  async function download() {
    if (!scan || !file) return;

    /*
     * Check access BEFORE showing any progress. The old order called
     * /api/patch first, so someone with no subscription watched the button say
     * "Patching…" — for work that was never going to happen — before being
     * shown a paywall. Telling someone you are doing a thing you are about to
     * refuse to do is the wrong way round.
     */
    if (!entitled) {
      await stashBeforeLeaving(file);
      /*
       * Not signed in: sign in FIRST, then choose a plan. The file is stashed
       * and the return address restores it and presses Download again, so the
       * next thing they see after the code is the plans -- not the drop zone.
       */
      if (signedIn === false) {
        router.push(`/sign-in?next=${encodeURIComponent('/app?resume=1&intent=download')}`);
        return;
      }
      setPaywall(true);
      return;
    }

    setBusy(true);
    setPatchStep(0);
    const startedAt = performance.now();
    try {
      const res = await fetch('/api/patch', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-pristine-ftyp-len': String(scan.descriptor.ftypLen),
          'x-pristine-payload-start': String(scan.descriptor.payloadStart),
          'x-pristine-payload-len': String(scan.descriptor.payloadLen),
        },
        body: scan.moov as BodyInit,
      });

      if (res.status === 401 || res.status === 402) {
        /*
         * Save the file before the paywall, because the next thing that happens
         * is a full navigation to Stripe that destroys it. Best-effort: if the
         * browser will not store it, the user re-selects on return, which is
         * what happens today anyway.
         */
        await stashBeforeLeaving(file);
        if (res.status === 401) {
          router.push(`/sign-in?next=${encodeURIComponent('/app?resume=1&intent=download')}`);
          return;
        }
        setPaywall(true);
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message ?? 'Something went wrong preparing this file.');
        setStage('error');
        return;
      }

      const meta = JSON.parse(res.headers.get('x-pristine-result') ?? '{}');
      const buf = new Uint8Array(await res.arrayBuffer());
      const moov = buf.subarray(0, meta.moovLen);
      const mdatHeader = buf.subarray(meta.moovLen, meta.moovLen + meta.mdatHeaderLen);

      const out = assemble(
        file, scan.ftyp, moov, mdatHeader,
        scan.descriptor.payloadStart, scan.descriptor.payloadLen, meta.fillerLen,
      );

      /* The hold: the file is ready, the reader is not yet expecting it. */
      await holdPatch(startedAt);

      const a = document.createElement('a');
      const objUrl = URL.createObjectURL(out);
      a.href = objUrl;
      a.download = out.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 60_000);
      // The copy only existed to survive the trip to Stripe. It has served its
      // purpose, so it goes now rather than lingering on the user's disk.
      void clearStash();

      setNotice(true);
      setReceipt({
        outputLen: meta.outputLen,
        realSamples: meta.realSamples,
        phantomSamples: meta.phantomSamples,
        multiplier: meta.multiplier,
        clonedTrack: !!meta.clonedTrack,
        neutralisedEdts: !!meta.neutralisedEdts,
      });
    } catch {
      setError('The download could not be completed. Please try again.');
      setStage('error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* The galaxy, fixed behind everything at z 0; the scene sits above it at z 1. */}
      <Starfield density={0.7} />

      {/*
        * The scene. SceneNav floats the wordmark and the links in this
        * wrapper's top corners and docks a copy bottom-right once the reader
        * has scrolled; there is no bar. overflow-x-clip: the hand's canvases
        * reach well past the phone, and must never widen the page.
        */}
      <div className="relative z-[1] min-h-[100svh] overflow-x-clip">
        <SceneNav variant="app" cta="none" dockHidden={stage === 'ready' && !!scan && !notice} />
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          <HeroField calm={0.5} />
        </div>

        <main id="main" className="mx-auto max-w-6xl px-6 pt-28 pb-20 md:pt-32 md:pb-24">
          {(stage === 'idle' || stage === 'scanning' || stage === 'error') && (
            <div className="mx-auto max-w-2xl">
              <h1 className="title-3d text-[clamp(2.1rem,4.6vw,3.2rem)] leading-[1.02]">
                See what TikTok will do to your video
              </h1>
              <p className="mt-5 text-[15px] leading-relaxed text-muted">
                Drop your export in. It is read on your device and never uploaded — no account,
                no card, nothing to sign up for.
              </p>

              {/*
                * The fallback when the file could not be brought back across the
                * trip to Stripe — no storage quota, a private window, or a return
                * in a different browser. Without this the user lands on an empty
                * dropzone after paying and has no idea whether it worked.
                */}
              {resumeNote && (
                <div className="mt-6 rounded-xl border border-good/30 bg-good/5 px-5 py-4">
                  <p className="text-[14px] font-medium text-good">Your plan is active.</p>
                  <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">
                    Drop your video back in and press Download — you will not be asked to pay
                    again. We could not keep a copy while you were on the payment page, which is
                    deliberate: it never left your device.
                  </p>
                </div>
              )}

              {/*
                * The dropzone: the same <label> with the same handlers and the
                * same hidden input, standing on a glass plate. The plate rises
                * in, leans with the page, and lights its iridescent ring while a
                * file is over it. The dashed target and the pool of light behind
                * the arrow are decorative layers under the label's own content
                * (the label isolates, so their negative z stays inside it).
                */}
              <div className="mt-9">
                <Plate3D depth={14} tilt={4} glow={dragOver} className="drop-clear">
                  <label
                    ref={dropRef}
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={(e) => {
                      // The sound of a file landing, from the handler's wrapper:
                      // `take` itself is silent, and so is a drop with nothing in it.
                      const landed = Boolean(e.dataTransfer.files?.[0]);
                      onDrop(e);
                      if (landed) play('drop');
                    }}
                    className="relative isolate grid cursor-pointer place-items-center rounded-panel px-6 py-12 text-center sm:py-20"
                  >
                    <input
                      ref={inputRef}
                      type="file"
                      accept="video/mp4,video/quicktime,.mp4,.mov"
                      aria-label="Choose a video file"
                      className="sr-only"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        setSkipMorph(false);
                        if (f) void take(f);
                        // Same sound as a drop: the file has landed either way.
                        if (f) play('drop');
                      }}
                    />

                    {/* Decorative: the dashed target, inset from the plate's edge. */}
                    <span
                      aria-hidden="true"
                      className={[
                        'pointer-events-none absolute inset-2.5 -z-10 rounded-[10px] border-2 border-dashed transition-colors duration-300',
                        dragOver ? 'border-accent-soft' : 'border-white/12',
                      ].join(' ')}
                    />
                    {/* Decorative: the light that comes up under a file being held over it. */}
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 -z-10 rounded-panel transition-opacity duration-300"
                      style={{
                        opacity: dragOver ? 1 : 0,
                        background:
                          'radial-gradient(60% 70% at 50% 42%, rgba(124, 92, 255, 0.22), rgba(78, 240, 255, 0.06) 55%, transparent 76%)',
                      }}
                    />

                    {stage === 'scanning' ? (
                      <>
                        <div className="h-7 w-7 animate-spin rounded-full border-2 border-line border-t-accent" />
                        <p className="mt-4 text-[14px] text-muted">Reading your file…</p>
                      </>
                    ) : (
                      <>
                        {/* The arrow on a glass disc that lifts while a file is over the plate. */}
                        <span
                          aria-hidden="true"
                          className={[
                            'grid h-16 w-16 place-items-center rounded-full border border-white/10 bg-white/[0.04]',
                            'shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_16px_40px_-16px_rgba(124,92,255,0.55)]',
                            'transition-transform duration-300 ease-out',
                            dragOver ? '-translate-y-1 scale-105' : '',
                          ].join(' ')}
                        >
                          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" className="text-text/85" aria-hidden="true">
                            <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"
                                  stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </span>
                        {/*
                          * Two readings of the same control, chosen by whether
                          * the device has a fine pointer rather than by width:
                          * a tablet is wide and still has no drag gesture. On a
                          * phone "drop" describes something the reader cannot
                          * do, and the plate then reads as decoration — the
                          * primary action on the page that earns money looked
                          * like empty space. The pill is a span, not a button:
                          * it is inside the <label>, so a tap on it opens the
                          * picker, while a nested <button> would swallow that.
                          */}
                        <span className="pill pill-primary mt-5 pointer-fine:hidden">
                          Choose your video
                        </span>
                        <p className="mt-5 hidden text-[15px] font-medium pointer-fine:block">
                          Drop your video here
                        </p>
                        <p className="mt-1.5 text-[13px] text-muted">
                          <span className="pointer-fine:hidden">Straight from your camera roll · </span>
                          MP4 or MOV · up to 4K · up to 60 fps · any length
                        </p>
                      </>
                    )}
                  </label>
                  {/*
                    * Export advice, given room and a shape of its own.
                    *
                    * It was a grey paragraph pressed against the bottom of the
                    * plate, which is where the eye goes last and where the two
                    * specs that actually matter were buried mid-sentence. The
                    * numbers are pulled out as their own chips — the spec is
                    * the message — with the fallback for smaller footage under
                    * them as a quieter line.
                    */}
                  <div className="mx-auto mt-10 mb-2 flex max-w-lg flex-col items-center gap-3 px-2 pb-2">
                    <div className="flex items-center gap-2.5">
                      <span className="iri-line h-px w-8 shrink-0 opacity-70" aria-hidden="true" />
                      <span className="legend text-[9.5px]">Bring it in at</span>
                      <span className="iri-line h-px w-8 shrink-0 opacity-70" aria-hidden="true" />
                    </div>
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      {['4K', '60 fps', 'MP4 or MOV'].map((spec) => (
                        <span
                          key={spec}
                          className="tabular rounded-full border border-line bg-white/[0.03] px-3 py-1.5
                                     text-[12px] font-medium tracking-[0.02em] text-text/90"
                        >
                          {spec}
                        </span>
                      ))}
                    </div>
                    <p className="text-center text-[12.5px] leading-relaxed text-muted">
                      What you send is what stays. Shot smaller? Upscale with Topaz Video AI first,
                      then export and bring that file here.
                    </p>
                  </div>
                </Plate3D>
              </div>

              {stage === 'error' && (
                <div className="mt-5 rounded-xl border border-bad/30 bg-bad/5 px-5 py-4">
                  <p className="text-[14px] text-text">{error}</p>
                </div>
              )}
            </div>
          )}

          {stage === 'ready' && scan && (
            <div className="space-y-14">
              {/* ---- what we actually found in their file ---- */}
              <section>
                <div className="flex flex-wrap items-end justify-between gap-4">
                  <div>
                    <p className="legend">Your file</p>
                    <h1 className="mt-1.5 max-w-xl truncate text-[1.35rem] font-medium">
                      {scan.fileName}
                    </h1>
                  </div>
                  <button
                    onClick={() => inputRef.current?.click()}
                    className="pill pill-ghost pill-sm"
                    {...soundProps('hover')}
                  >
                    Choose another
                  </button>
                  <input
                    ref={inputRef}
                    type="file"
                    accept="video/mp4,video/quicktime,.mp4,.mov"
                    aria-label="Choose a different video file"
                    className="sr-only"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void take(f);
                      // Same sound as a drop: the file has landed either way.
                      if (f) play('drop');
                    }}
                  />
                </div>

                {/*
                  * Two numbers, not six. Codec, profile, level, bitrate and
                  * duration are all real and all correct, and none of them mean
                  * anything to someone who just wants a file that uploads well.
                  * They are still read and still sent — the patch needs them —
                  * they are simply not the user's problem.
                  */}
                <div className="mt-6">
                  <Plate3D depth={10} tilt={3} delay={90}>
                    <dl className="grid grid-cols-2 divide-x divide-white/8">
                      {[
                        ['Resolution', `${scan.width}×${scan.height}`],
                        ['Frame rate', `${scan.fps.toFixed(0)} fps`],
                      ].map(([k, v]) => (
                        <div key={k} className="px-5 py-4">
                          <dt className="legend">{k}</dt>
                          <dd className="tabular mt-1.5 text-[14px] text-text">{v}</dd>
                        </div>
                      ))}
                    </dl>
                  </Plate3D>
                </div>

                {/* Past 4K or past 60 fps: say so before any payment. Pristine
                  * never touches the picture, so it cannot bring either down. */}
                {(scan.fps > 61 || Math.max(scan.width, scan.height) > 3840) && (
                  <div className="mt-4 rounded-xl border border-warn/30 bg-warn/5 px-5 py-4">
                    <p className="text-[14px] font-medium text-text">Export at up to 4K and 60 fps</p>
                    <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">
                      This file is {scan.width}×{scan.height} at {Math.round(scan.fps)} fps.{' '}
                      {scan.fps > 61
                        ? 'TikTok cuts anything above 60 fps down to 30, and Pristine never changes your frame rate — that would mean touching your picture.'
                        : 'TikTok does not serve anything above 4K, and Pristine never changes your resolution — that would mean touching your picture.'}{' '}
                      Export again at up to 4K and 60 fps and drop that file here.
                    </p>
                  </div>
                )}

                {/* The one thing that must be caught before any payment. */}
                {!scan.hasAudio && (
                  <div className="mt-4 rounded-xl border border-warn/30 bg-warn/5 px-5 py-4">
                    <p className="text-[14px] font-medium text-text">This video has no audio track</p>
                    <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">
                      Add a silent audio track in your editor and export again — everything else
                      about your file is fine.
                    </p>
                  </div>
                )}
              </section>

              {/* ---- the hook ---- */}
              {/*
                * The preview stands on the stage: the hand, the phone with real
                * thickness, the tilt that follows the pointer to the edge of the
                * page (the gyroscope on a phone), and the split that follows it
                * too. `t` is how much Pristine shows, and lights the phone.
                */}
              {/* No clip here: the hand and the screen's glow reach as far as
                * they reach, and only the page's own edge (PageShell) stops them. */}
              <section className="relative">
                <div className="mb-7">
                  <h2 className="title-3d text-[clamp(1.5rem,2.8vw,2.1rem)]">
                    Your video, both ways
                  </h2>
                  <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-muted">
                    Drag the handle. One side is TikTok&rsquo;s measured delivery for an ordinary
                    upload; the other is your file served exactly as you made it.
                  </p>
                </div>

                {url && (
                  <>
                    <div ref={stageWrapRef}>
                    <SceneStage t={1 - pos / 100} aspect={PREVIEW_ASPECT} width={PREVIEW_WIDTH} pristine={pristine} holograms={false}>
                      <PreviewCompare
                        src={url}
                        pristine={pristine}
                        width={scan.width}
                        height={scan.height}
                        fps={scan.fps}
                        bitrateMbps={scan.bitrateMbps}
                        crushedLikes={CRUSHED_STATS.likes}
                        pristineLikes={PRISTINE_STATS.likes}
                        onPositionChange={onPos}
                        motionDrive
                      />
                    </SceneStage>
                    </div>
                    <PreviewNote bitrateMbps={scan.bitrateMbps} />
                  </>
                )}

                <p className="mx-auto mt-3 max-w-xl text-center text-[11.5px] leading-relaxed text-dim">
                  Preview only — simulated, and the engagement numbers are illustrative. The left
                  side reproduces TikTok&rsquo;s measured 720×1280 / 30fps delivery by drawing your
                  own video at that resolution. Not affiliated with TikTok.
                </p>
              </section>

              {/* ---- download ---- */}
              {/* A plate; its iridescent ring comes on with the receipt. */}
              <Plate3D depth={12} tilt={3} glow={Boolean(receipt)}>
                <section className="p-7">
                  <div className="flex flex-wrap items-center justify-between gap-6">
                    <div>
                      <h3 className="text-[1.05rem] font-medium">Download your Pristine file</h3>
                      <p className="mt-1.5 max-w-md text-[13.5px] leading-relaxed text-muted">
                        Same video, same quality — ready to upload.
                      </p>
                    </div>
                    <button
                      onClick={download}
                      disabled={busy || !scan.hasAudio}
                      className="pill pill-primary disabled:cursor-not-allowed disabled:opacity-40"
                      {...soundProps('hover')}
                    >
                      {busy ? 'Patching…' : receipt ? 'Download again' : 'Download'}
                    </button>
                  </div>

                  {/* The work, shown: a step label and a bar that fills over the hold. */}
                  {busy && (
                    <div className="mt-6 border-t border-white/8 pt-5" aria-live="polite">
                      <div className="flex items-center justify-between gap-4">
                        <span className="text-[13.5px] text-muted">{PATCH_STEPS[patchStep]}</span>
                        <span className="legend">Step {patchStep + 1} of {PATCH_STEPS.length}</span>
                      </div>
                      <div className="patch-track mt-3">
                        <div className="patch-bar" />
                      </div>
                    </div>
                  )}

                  {/*
                    * A receipt, not a spec sheet. The earlier version listed decoy
                    * track, declared sample counts, the multiplier and the edit-list
                    * state — all true, and all meaningless to someone who wants a
                    * file that uploads well. What they need to know is that it
                    * worked and that their picture was not touched.
                    */}
                  {receipt && (
                    <div className="mt-6 flex items-center gap-3 border-t border-white/8 pt-5">
                      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-good shadow-[0_0_10px_var(--color-good)]" />
                      <p className="text-[13.5px] leading-relaxed text-muted">
                        <span className="text-good">Saved to your downloads.</span>{' '}
                        Upload it to TikTok exactly as you normally would — nothing else to do.
                      </p>
                    </div>
                  )}
                </section>
              </Plate3D>
            </div>
          )}
          {/*
            * Renders nothing; it flies the drop zone into the phone when a file
            * lands. It sits LAST in <main> on purpose: React attaches refs and
            * runs layout effects in tree order, so placed before the stage it
            * would run before the stage's wrapper ref existed and find nothing
            * to fly to.
            */}
          {/* The after-download notice: a warning, one instruction, one button. */}
          {notice && (
            <div
              className="fixed inset-0 z-[80] flex items-center justify-center bg-[rgba(3,4,10,0.72)] p-6"
              onClick={() => setNotice(false)}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="notice-title"
                className="plate plate-face plate-glow notice-in w-full max-w-md p-7 text-center"
                onClick={(e) => e.stopPropagation()}
              >
                <span aria-hidden className="notice-warn mx-auto flex h-14 w-14 items-center justify-center rounded-full">
                  <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3.5 2.8 19.5h18.4L12 3.5Z" />
                    <path d="M12 9.5v4.5" />
                    <circle cx="12" cy="16.8" r="0.6" fill="currentColor" />
                  </svg>
                </span>
                <h3 id="notice-title" className="mt-5 text-[1.15rem] font-semibold leading-snug">
                  Upload the downloaded file to TikTok without modifying it
                </h3>
                <p className="mt-3 text-[13.5px] leading-relaxed text-muted">
                  Don&rsquo;t trim it, re-export it, or run it through another app first. Any change
                  creates a new file, and that new file is not the one you just downloaded.
                </p>
                <button
                  type="button"
                  autoFocus
                  onClick={() => setNotice(false)}
                  className="pill pill-primary mt-6"
                  {...soundProps('hover')}
                >
                  Got it
                </button>
              </div>
            </div>
          )}
          {/* The download sits below a tall stage at every width -- on a
            * desktop too, the reader had to scroll to find it. So this stays
            * one click away the moment the preview is up, at every width, and
            * it stands where the dock was: the dock is hidden while this is
            * up (SceneNav's dockHidden), so there is one control at the
            * bottom, not a Download above a Try free. The full section with
            * its explanation remains below. */}
          {stage === 'ready' && scan && !notice && (
            <div className="pointer-events-none fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[60] flex justify-center px-4">
              <button
                type="button"
                onClick={download}
                disabled={busy || !scan.hasAudio}
                className="pill pill-primary pointer-events-auto shadow-[0_12px_40px_rgba(0,0,0,0.55)] disabled:opacity-40"
                {...soundProps('hover')}
              >
                {busy ? 'Patching…' : receipt ? 'Download again' : 'Download your Pristine file'}
              </button>
            </div>
          )}
          <DropMorph stage={stage} dropRef={dropRef} stageRef={stageWrapRef} skip={skipMorph} />
        </main>
      </div>

      {paywall && <Paywall onClose={() => setPaywall(false)} />}
    </>
  );
}

function Paywall({ onClose }: { onClose: () => void }) {
  /*
   * The plans are HERE, not a link to /#pricing.
   *
   * That link was a full navigation, and it landed on the homepage copy of the
   * pricing table — which is rendered non-interactive, so its "Start free trial"
   * button is only a link to /pricing, where an identical-looking button finally
   * does something. That is the literal cause of "I have to click start free
   * trial twice": the first click was never a button.
   */
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto
                 bg-black/85 p-4 sm:p-8"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      {/* The offer stops the click; the scenery around it closes. The plate
          glows: this is the one moment the page asks for anything. */}
      <div onClick={(e) => e.stopPropagation()} className="my-auto w-full max-w-5xl">
        <Plate3D glow depth={14} tilt={2}>
          <div className="p-6 sm:p-9">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="title-3d text-[clamp(1.4rem,3.2vw,1.9rem)]">
                You&rsquo;ve seen the difference
              </h2>
              <p className="mt-3 text-[14px] leading-relaxed text-muted">
                Everything up to here is free. You only pay for the file itself — and your video
                stays right where it is while you do.
              </p>
            </div>

            <div className="mt-8">
              <PricingTable />
            </div>

            <div className="mt-6 flex justify-center">
              <button
                onClick={onClose}
                className="pill pill-ghost pill-sm text-dim"
                {...soundProps('hover')}
              >
                Not yet
              </button>
            </div>
            {/* The paywall is where a subscriber on a new device lands; a plan
                list with no way in reads as "pay again". */}
            <p className="mt-4 text-center text-[13px] text-dim">
              Already subscribed?{' '}
              <Link href="/sign-in?next=%2Fapp" className="underline transition hover:text-text">
                Sign in
              </Link>
            </p>
          </div>
        </Plate3D>
      </div>
    </div>
  );
}
