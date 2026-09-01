'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import Nav from '@/components/Nav';
import PreviewCompare from '@/components/PreviewCompare';
import { Mp4Error } from '@/lib/mp4/boxes';
import { assemble, scanFile, type ScanResult } from '@/lib/mp4/scan';

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
  const inputRef = useRef<HTMLInputElement>(null);

  // Object URLs leak the whole file until revoked, which matters when the file
  // is 500 MB and someone tries a few in a row.
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

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

              <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-panel border border-line bg-line sm:grid-cols-3 lg:grid-cols-6">
                {[
                  ['Resolution', `${scan.width}×${scan.height}`],
                  ['Frame rate', `${scan.fps.toFixed(2)} fps`],
                  ['Codec', scan.codec],
                  ['Profile', scan.profile ? `${scan.profile} @ L${scan.level}` : '—'],
                  ['Bitrate', `${scan.bitrateMbps.toFixed(1)} Mbps`],
                  ['Duration', `${scan.durationSec.toFixed(1)}s`],
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
                  crushed={CRUSHED_STATS}
                  pristine={PRISTINE_STATS}
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
                    Assembled in your browser from the file you already have. The picture is
                    bit-identical to your export — not one pixel is touched.
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

              {receipt && (
                <div className="mt-6 border-t border-line pt-5">
                  <div className="flex items-center gap-2">
                    <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-good" />
                    <span className="legend text-[10px] text-good">Patched</span>
                  </div>
                  <dl className="tabular mt-3 grid gap-x-8 gap-y-1.5 text-[12.5px] sm:grid-cols-2">
                    <div className="flex justify-between gap-4">
                      <dt className="text-dim">Audio track</dt>
                      <dd>{receipt.clonedTrack ? 'added' : 'existing one used'}</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-dim">Declared samples</dt>
                      <dd>
                        {receipt.realSamples.toLocaleString()}
                        {' → '}
                        {(receipt.realSamples + receipt.phantomSamples).toLocaleString()}
                        <span className="text-dim"> ({receipt.multiplier}×)</span>
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-dim">Timeline</dt>
                      <dd>{receipt.neutralisedEdts ? 'corrected' : 'already correct'}</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-dim">Output</dt>
                      <dd>{(receipt.outputLen / 1_048_576).toFixed(1)} MB</dd>
                    </div>
                  </dl>
                  <p className="mt-4 text-[12.5px] leading-relaxed text-dim">
                    Your video track was not touched — the picture is bit-identical to what you
                    dropped in. Upload this file to TikTok as you normally would.
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
  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-black/75 p-6 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-panel border border-line bg-panel p-8"
      >
        <h2 className="text-[1.25rem] font-semibold tracking-[-0.01em]">
          You&rsquo;ve seen the difference
        </h2>
        <p className="mt-3 text-[14px] leading-relaxed text-muted">
          Downloading the patched file needs a plan. Everything you just saw stays free —
          you only pay when you want the file itself.
        </p>
        <Link
          href="/#pricing"
          className="mt-7 block rounded-xl bg-accent px-5 py-3.5 text-center text-[15px] font-medium text-white transition hover:bg-accent-soft"
        >
          See plans
        </Link>
        <button
          onClick={onClose}
          className="mt-3 w-full rounded-xl px-5 py-2.5 text-center text-[13.5px] text-dim transition hover:text-muted"
        >
          Not yet
        </button>
      </div>
    </div>
  );
}
