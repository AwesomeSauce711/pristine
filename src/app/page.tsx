'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import Wordmark from '@/components/Wordmark';
import CursorTrail from '@/components/CursorTrail';
import Starfield from '@/components/fx/Starfield';
import RibbonField from '@/components/fx/RibbonField';
import { Mp4Error } from '@/lib/mp4/boxes';
import { buildPatchedMoov } from '@/lib/mp4/patch';
import { assemble, scanFile, type ScanResult } from '@/lib/mp4/scan';

const HeroField = dynamic(() => import('@/components/three/HeroField'), { ssr: false });
const DONATION_URL = 'https://buymeacoffee.com/pristine4k';
const GITHUB_URL = 'https://github.com/AwesomeSauce711/pristine';

export default function Home() {
  const input = useRef<HTMLInputElement>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  async function selectFile(file?: File) {
    if (!file) return;
    setError('');
    setDone(false);
    setScan(null);
    setPreviewUrl('');
    setBusy(true);
    try {
      const result = await scanFile(file);
      setScan(result);
      setPreviewUrl(URL.createObjectURL(result.file));
    } catch (cause) {
      setError(cause instanceof Mp4Error ? cause.message : 'We could not read that video. Try an MP4 file.');
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    if (!scan || busy) return;
    setBusy(true);
    setError('');
    setDone(false);
    try {
      const result = buildPatchedMoov({
        moov: scan.moov,
        ftypLen: scan.descriptor.ftypLen,
        payloadStart: scan.descriptor.payloadStart,
        payloadLen: scan.descriptor.payloadLen,
        movedMoov: scan.needsFaststart,
      });
      const output = assemble(
        scan.file, scan.ftyp, result.moov, result.mdatHeader,
        scan.descriptor.payloadStart, scan.descriptor.payloadLen,
        result.fillerLen, result.fillerHead,
      );
      const url = URL.createObjectURL(output);
      const link = document.createElement('a');
      link.href = url;
      link.download = output.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setDone(true);
    } catch (cause) {
      setError(cause instanceof Mp4Error ? cause.message : 'The video could not be prepared. Try another MP4 file.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <CursorTrail />
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10"><Starfield /></div>
      <main id="main" className="relative min-h-[100svh] overflow-x-clip">
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          <HeroField />
          <div className="absolute inset-0" style={{ transform: 'scaleX(-1)' }}>
            <RibbonField intensity={0.5} thickness={0.22} />
          </div>
        </div>
        <div className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(90deg,rgba(5,6,12,.9),rgba(5,6,12,.7)_52%,rgba(5,6,12,.25))]" />
        <div className="mx-auto flex min-h-[100svh] max-w-7xl flex-col px-6">
          <header className="flex items-center justify-between gap-4 py-6">
            <Wordmark />
            <a className="nav-link" href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub ↗</a>
          </header>

          <div className="flex flex-1 flex-col justify-center py-14 md:py-20">
            <div className="rise max-w-[44rem]">
              <p className="legend mb-6 text-accent-soft">Free · Open source · No account</p>
              <h1 className="hero-h1">Your video.<br /><span className="brand">Pristine.</span></h1>
              <p className="mt-7 max-w-xl text-[1.05rem] leading-relaxed text-muted">
                Prepare your MP4 for TikTok in your browser. Your video stays on your device.
              </p>
            </div>

            <div className="rise mt-12 max-w-2xl" style={{ animationDelay: '120ms' }}>
              <input ref={input} type="file" accept="video/mp4,.mp4" className="sr-only"
                onChange={(event) => { void selectFile(event.target.files?.[0]); event.target.value = ''; }}
                aria-label="Choose an MP4 video" />
              {!scan ? (
                <button type="button" onClick={() => input.current?.click()}
                  onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => { event.preventDefault(); setDragging(false); void selectFile(event.dataTransfer.files[0]); }}
                  className={`group w-full rounded-[28px] border p-8 text-left shadow-[0_24px_80px_rgba(0,0,0,.35)] transition duration-300 sm:p-11 ${dragging ? 'border-accent-soft bg-accent/20 scale-[1.01]' : 'border-white/15 bg-[#111523d9] hover:border-accent-soft/70 hover:bg-[#171b2c]'}`}>
                  <span className="mb-8 grid h-14 w-14 place-items-center rounded-2xl bg-accent/20 text-3xl text-accent-soft transition group-hover:scale-110" aria-hidden>↑</span>
                  <span className="block text-2xl font-semibold">{busy ? 'Reading your video…' : 'Choose a video'}</span>
                  <span className="mt-2 block text-sm text-muted">MP4 · Drag and drop or tap to browse</span>
                </button>
              ) : (
                <div className="overflow-hidden rounded-[28px] border border-white/15 bg-[#111523e8] shadow-[0_24px_80px_rgba(0,0,0,.35)]">
                  <div className="grid gap-6 p-6 sm:grid-cols-[160px_1fr] sm:p-8">
                    {previewUrl && <video src={previewUrl} controls playsInline className="aspect-[9/16] max-h-64 w-full rounded-xl bg-black object-contain sm:max-h-none" aria-label="Selected video preview" />}
                    <div className="flex flex-col justify-center">
                      <p className="truncate text-xl font-semibold" title={scan.fileName}>{scan.fileName}</p>
                      <p className="mt-2 text-sm text-muted">{scan.width} × {scan.height} · {scan.fps.toFixed(1)} fps · {scan.codec}</p>
                      <button type="button" onClick={() => void download()} disabled={busy} className="pill pill-primary mt-7 self-start disabled:opacity-60">
                        {busy ? 'Preparing…' : 'Download free'}
                      </button>
                      <button type="button" onClick={() => input.current?.click()} className="mt-5 self-start text-sm text-muted underline decoration-white/30 underline-offset-4 hover:text-text">Choose another video</button>
                    </div>
                  </div>
                </div>
              )}
              {error && <p role="alert" className="mt-4 text-sm text-bad">{error}</p>}
              {done && <p role="status" className="mt-4 text-sm text-good">Download started. Upload the saved file as it is, without editing or re-exporting it.</p>}
              <p className="mt-5 text-sm text-dim">No upload. No email. No payment.</p>
            </div>
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-5 border-t border-white/10 py-7 text-sm text-muted">
            <p>Pristine is free for everyone.</p>
            <div className="flex flex-wrap items-center gap-5">
              <a href={DONATION_URL} target="_blank" rel="noopener noreferrer" className="text-text hover:text-accent-soft">☕ Buy me a coffee ↗</a>
              <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="hover:text-text">Source code ↗</a>
              <Link href="/legal/privacy" className="hover:text-text">Privacy</Link>
            </div>
          </footer>
        </div>
      </main>
    </>
  );
}
