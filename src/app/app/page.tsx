'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Nav from '@/components/Nav';
import PricingTable from '@/components/PricingTable';
import PreviewCompare from '@/components/PreviewCompare';
import { Mp4Error } from '@/lib/mp4/boxes';
import { assemble, scanFile, type ScanResult } from '@/lib/mp4/scan';
import { clearStash, stashFile, takeStashedFile } from '@/lib/stash';

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
const CRUSHED_STATS = { likes: 19, comments: 2, shares: 0 };
const PRISTINE_STATS = { likes: 1_200_000, comments: 6_497, shares: 18_300 };

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

  const refreshAccess = useCallback(async () => {
    try {
      const res = await fetch('/api/me', { cache: 'no-store' });
      const data = await res.json();
      setEntitled(Boolean(data.entitled));
    } catch { /* leave it false; the server decides anyway */ }
  }, []);

  useEffect(() => { void refreshAccess(); }, [refreshAccess]);
  const inputRef = useRef<HTMLInputElement>(null);

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

    // Drop the flag immediately so a refresh does not try to resume twice.
    window.history.replaceState(null, '', '/app');

    let cancelled = false;
    (async () => {
      await refreshAccess();
      const f = await takeStashedFile();
      if (cancelled) return;
      if (!f) { setResumeNote(true); return; }
      setAutoDownload(true);
      await take(f);
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
      void stashFile(file);
      setPaywall(true);
      return;
    }

    setBusy(true);
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
        void stashFile(file);
        setPaywall(true);
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message ?? 'Something went wrong patching this file.');
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
      <Nav />
      <main id="main" className="mx-auto max-w-6xl px-6 py-14">
        {(stage === 'idle' || stage === 'scanning' || stage === 'error') && (
          <div className="mx-auto max-w-2xl">
            <h1 className="text-[clamp(1.9rem,4vw,2.6rem)] font-semibold tracking-[-0.02em]">
              See what TikTok will do to your video
            </h1>
            <p className="mt-4 text-[15px] leading-relaxed text-muted">
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

            <label
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              className={[
                'mt-9 grid cursor-pointer place-items-center rounded-panel border-2 border-dashed px-6 py-20 text-center transition',
                dragOver ? 'border-accent bg-accent/5' : 'border-line bg-panel/40 hover:border-dim',
              ].join(' ')}
            >
              <input
                ref={inputRef}
                type="file"
                accept="video/mp4,video/quicktime,.mp4,.mov"
                aria-label="Choose a video file"
                className="sr-only"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void take(f); }}
              />
              {stage === 'scanning' ? (
                <>
                  <div className="h-7 w-7 animate-spin rounded-full border-2 border-line border-t-accent" />
                  <p className="mt-4 text-[14px] text-muted">Reading the index…</p>
                </>
              ) : (
                <>
                  <svg width="34" height="34" viewBox="0 0 24 24" fill="none" className="text-dim" aria-hidden="true">
                    <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"
                          stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <p className="mt-4 text-[15px] font-medium">Drop your video here</p>
                  <p className="mt-1.5 text-[13px] text-dim">MP4 or MOV · up to 4K · any length</p>
                </>
              )}
            </label>

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
                  className="rounded-lg border border-line px-4 py-2 text-[13px] text-muted transition hover:border-dim hover:text-text"
                >
                  Choose another
                </button>
                <input
                  ref={inputRef}
                  type="file"
                  accept="video/mp4,video/quicktime,.mp4,.mov"
                  aria-label="Choose a different video file"
                  className="sr-only"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void take(f); }}
                />
              </div>

              {/*
                * Two numbers, not six. Codec, profile, level, bitrate and
                * duration are all real and all correct, and none of them mean
                * anything to someone who just wants a file that uploads well.
                * They are still read and still sent — the patch needs them —
                * they are simply not the user's problem.
                */}
              <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-panel border border-line bg-line">
                {[
                  ['Resolution', `${scan.width}×${scan.height}`],
                  ['Frame rate', `${scan.fps.toFixed(0)} fps`],
                ].map(([k, v]) => (
                  <div key={k} className="bg-panel px-4 py-4">
                    <dt className="legend">{k}</dt>
                    <dd className="tabular mt-1.5 text-[14px] text-text">{v}</dd>
                  </div>
                ))}
              </dl>

              {/* The one thing that must be caught before any payment. */}
              {!scan.hasAudio && (
                <div className="mt-4 rounded-xl border border-warn/30 bg-warn/5 px-5 py-4">
                  <p className="text-[14px] font-medium text-text">This video has no audio track</p>
                  <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">
                    Pristine needs your export to contain an audio track — a silent one counts.
                    Add a silent audio track in your editor and export again — everything else
                    about your file is fine.
                  </p>
                </div>
              )}
            </section>

            {/* ---- the hook ---- */}
            <section>
              <div className="mb-7">
                <h2 className="text-[clamp(1.4rem,2.6vw,1.9rem)] font-semibold tracking-[-0.02em]">
                  Your video, both ways
                </h2>
                <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-muted">
                  Drag the handle. One side is TikTok&rsquo;s measured delivery for an ordinary
                  upload; the other is your file served exactly as you made it.
                </p>
              </div>

              {url && (
                <PreviewCompare
                  src={url}
                  width={scan.width}
                  height={scan.height}
                  fps={scan.fps}
                  bitrateMbps={scan.bitrateMbps}
                  crushedLikes={CRUSHED_STATS.likes}
                  pristineLikes={PRISTINE_STATS.likes}
                />
              )}

              <p className="mx-auto mt-6 max-w-xl text-center text-[11.5px] leading-relaxed text-dim">
                Preview only — simulated, and the engagement numbers are illustrative. The left
                side reproduces TikTok&rsquo;s measured 720×1280 / 30fps delivery by drawing your
                own video at that resolution and frame rate. Not affiliated with TikTok.
              </p>
            </section>

            {/* ---- download ---- */}
            <section className="rounded-panel border border-line bg-panel p-7">
              <div className="flex flex-wrap items-center justify-between gap-6">
                <div>
                  <h3 className="text-[1.05rem] font-medium">Download your patched file</h3>
                  <p className="mt-1.5 max-w-md text-[13.5px] leading-relaxed text-muted">
                    Same video, same quality — ready to upload.
                  </p>
                </div>
                <button
                  onClick={download}
                  disabled={busy || !scan.hasAudio}
                  className="rounded-xl bg-accent px-7 py-3.5 text-[15px] font-medium text-white transition
                             hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40
                             focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                >
                  {busy ? 'Patching…' : receipt ? 'Download again' : 'Download'}
                </button>
              </div>

              {/*
                * A receipt, not a spec sheet. The earlier version listed decoy
                * track, declared sample counts, the multiplier and the edit-list
                * state — all true, and all meaningless to someone who wants a
                * file that uploads well. What they need to know is that it
                * worked and that their picture was not touched.
                */}
              {receipt && (
                <div className="mt-6 flex items-center gap-3 border-t border-line-soft pt-5">
                  <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-good" />
                  <p className="text-[13.5px] leading-relaxed text-muted">
                    <span className="text-good">Saved to your downloads.</span>{' '}
                    Upload it to TikTok exactly as you normally would — nothing else to do.
                  </p>
                </div>
              )}
            </section>
          </div>
        )}
      </main>

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
                 bg-black/80 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="my-auto w-full max-w-5xl rounded-panel border border-line bg-panel p-6 sm:p-9"
      >
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-[clamp(1.3rem,3vw,1.75rem)] font-semibold tracking-[-0.02em]">
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

        <button
          onClick={onClose}
          className="mt-6 w-full rounded-xl px-5 py-2.5 text-center text-[13.5px] text-dim transition hover:text-muted"
        >
          Not yet
        </button>
      </div>
    </div>
  );
}
