'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import Wordmark from '@/components/Wordmark';
import Starfield from '@/components/fx/Starfield';
import RibbonField from '@/components/fx/RibbonField';
import { convertForUpload, EXPORT_PRESETS, inspectVideo, type VideoInfo } from '@/lib/convert';
import { useSoundEffects } from '@/lib/useSoundEffects';
import { scanFile } from '@/lib/mp4/scan';

const HeroField = dynamic(() => import('@/components/three/HeroField'), { ssr: false });
const DONATION_URL = 'https://buymeacoffee.com/pristine4k';
const GITHUB_URL = 'https://github.com/AwesomeSauce711/pristine';
const TARGETS = EXPORT_PRESETS;

export default function Home() {
  const input = useRef<HTMLInputElement>(null);
  const [scan, setScan] = useState<VideoInfo | null>(null);
  const { soundEnabled, toggleSound, playSound } = useSoundEffects();
  const controller = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<{ message: string; fraction?: number } | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [outputInfo, setOutputInfo] = useState('');
  const [saved, setSaved] = useState<{ url: string; name: string } | null>(null);
  const [target, setTarget] = useState(0);
  const chosen = TARGETS[target];

  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);
  useEffect(() => () => { if (saved) URL.revokeObjectURL(saved.url); }, [saved]);
  useEffect(() => () => controller.current?.abort(), []);

  async function selectFile(file?: File) {
    if (!file || busy) return;
    playSound('upload');
    setError('');
    setDone(false);
    setSaved(null);
    setScan(null);
    setPreviewUrl('');
    setBusy(true);
    try {
      const result = await inspectVideo(file);
      setScan(result);
      setPreviewUrl(URL.createObjectURL(result.file));
      playSound('ready');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'We could not read that video. Try an MP4, MOV, or WebM file.');
      playSound('error');
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    if (!scan || busy) return;
    setBusy(true);
    setError('');
    setDone(false);
    setSaved(null);
    controller.current = new AbortController();
    try {
      const output = await convertForUpload(scan, target, (message, fraction) => setProgress({ message, fraction }), controller.current.signal);
      const checked = await scanFile(output);
      setOutputInfo(`${checked.width} × ${checked.height} · ${checked.fps.toFixed(2)} fps · ${checked.codec} · ${checked.videoSamples.toLocaleString()} frames`);
      const url = URL.createObjectURL(output);
      setSaved({ url, name: output.name });
      const link = document.createElement('a');
      link.href = url;
      link.download = output.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setDone(true);
      playSound('ready');
    } catch (cause) {
      if (!controller.current.signal.aborted) {
        setError(cause instanceof Error ? cause.message : 'The video could not be prepared. Try another video.');
        playSound('error');
      }
    } finally {
      setBusy(false);
      setProgress(null);
      controller.current = null;
    }
  }

  return (
    <>
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
            <div className="flex items-center gap-5">
              <button type="button" data-sound-toggle aria-pressed={soundEnabled} aria-label={soundEnabled ? 'Mute sound effects' : 'Enable sound effects'} onClick={toggleSound} className="text-sm text-muted hover:text-text">Sound {soundEnabled ? 'on' : 'off'}</button>
              <a className="nav-link" href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub ↗</a>
            </div>
          </header>

          <div className="flex flex-1 flex-col justify-center py-14 md:py-20">
            <div className="rise max-w-[44rem]">
              <p className="legend mb-6 text-accent-soft">Free · Open source · No account</p>
              <h1 className="hero-h1">Your video.<br /><span className="brand">Pristine.</span></h1>
              <p className="mt-7 max-w-xl text-[1.05rem] leading-relaxed text-muted">
                Convert and prepare your video for TikTok. Your video stays on your device.
              </p>
            </div>

            <div className="rise mt-12 max-w-2xl" style={{ animationDelay: '120ms' }}>
              <fieldset className="mb-5 flex flex-wrap gap-2">
                <legend className="mb-3 text-sm text-muted">Choose your export</legend>
                {TARGETS.map((option, index) => <button key={option.label} type="button" aria-pressed={target === index}
                  disabled={busy} onClick={() => { setTarget(index); setDone(false); setSaved(null); }}
                  className={`rounded-full border px-4 py-2 text-sm transition ${target === index ? 'border-accent-soft bg-accent/20 text-text' : 'border-white/15 text-muted hover:border-white/40'}`}>
                  {option.label}
                </button>)}
              </fieldset>
              <input ref={input} type="file" accept="video/*,.mp4,.mov,.mkv,.webm" disabled={busy} className="sr-only"
                onChange={(event) => { void selectFile(event.target.files?.[0]); event.target.value = ''; }}
                aria-label="Choose a video" />
              {!scan ? (
                <button type="button" disabled={busy} onClick={() => input.current?.click()}
                  onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => { event.preventDefault(); setDragging(false); void selectFile(event.dataTransfer.files[0]); }}
                  className={`group w-full rounded-[28px] border p-8 text-left shadow-[0_24px_80px_rgba(0,0,0,.35)] transition duration-300 sm:p-11 ${dragging ? 'border-accent-soft bg-accent/20 scale-[1.01]' : 'border-white/15 bg-[#111523d9] hover:border-accent-soft/70 hover:bg-[#171b2c]'}`}>
                  <span className="mb-8 grid h-14 w-14 place-items-center rounded-2xl bg-accent/20 text-3xl text-accent-soft transition group-hover:scale-110" aria-hidden>↑</span>
                  <span className="block text-2xl font-semibold">{busy ? 'Reading your video…' : 'Choose a video'}</span>
                  <span className="mt-2 block text-sm text-muted">MP4, MOV, WebM & more · Drop or tap to browse</span>
                </button>
              ) : (
                <div className="overflow-hidden rounded-[28px] border border-white/15 bg-[#111523e8] shadow-[0_24px_80px_rgba(0,0,0,.35)]">
                  <div className="grid gap-6 p-6 sm:grid-cols-[160px_1fr] sm:p-8">
                    {previewUrl && <video src={previewUrl} controls playsInline className="aspect-[9/16] max-h-64 w-full rounded-xl bg-black object-contain sm:max-h-none" aria-label="Selected video preview" />}
                    <div className="flex flex-col justify-center">
                      <p className="truncate text-xl font-semibold" title={scan.file.name}>{scan.file.name}</p>
                      <p className="mt-2 text-sm text-muted">{scan.width} × {scan.height} · {scan.fps.toFixed(1)} fps · {scan.codec}</p>
                      <p className="mt-3 text-sm text-accent-soft">Export → {chosen.label}</p>
                      <button type="button" onClick={() => void download()} disabled={busy} className="pill pill-primary mt-7 self-start disabled:opacity-60">
                        {busy ? 'Preparing…' : 'Convert & download'}
                      </button>
                      {busy ? <button type="button" onClick={() => controller.current?.abort()} className="mt-5 self-start text-sm text-muted underline underline-offset-4">Cancel</button> : <button type="button" onClick={() => input.current?.click()} className="mt-5 self-start text-sm text-muted underline decoration-white/30 underline-offset-4 hover:text-text">Choose another video</button>}
                    </div>
                  </div>
                </div>
              )}
              {error && <p role="alert" className="mt-4 text-sm text-bad">{error}</p>}
              {progress && <div role="status" className="mt-4 text-sm text-muted"><p>{progress.message}{progress.fraction !== undefined ? ` · ${Math.round(progress.fraction * 100)}%` : '…'}</p><progress className="mt-2 h-1 w-full accent-violet-400" max={1} value={progress.fraction} /></div>}
              {done && <p role="status" className="mt-4 text-sm text-good">Download started. Upload the saved file as it is, without editing or re-exporting it.</p>}
              {done && <p className="mt-2 text-sm text-muted">{outputInfo}</p>}
              {done && saved && <a href={saved.url} download={saved.name} className="mt-2 inline-block text-sm text-accent-soft underline underline-offset-4">Save the prepared file again</a>}
              <p className="mt-4 text-sm text-muted">Pristine may not always work. TikTok can change your video’s quality when you upload it or later. Playback and saved-file compatibility can vary.</p>
              <p className="mt-2 text-xs text-dim">Upscaling and repeated frames create the selected file size and frame rate, without adding original detail or motion. Large videos need more time and device memory.</p>
              <p className="mt-5 text-sm text-dim">No upload. No email. No payment.</p>
              <div className="mt-8 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[.025] p-5">
                <p className="max-w-xs text-sm leading-relaxed text-muted">Donations help fund the creation of these free tools</p>
                <a href={DONATION_URL} target="_blank" rel="noopener noreferrer" className="rounded-full border border-accent-soft/40 px-4 py-2 text-sm text-accent-soft transition hover:bg-accent/15">☕ Buy me a coffee ↗</a>
              </div>
            </div>
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-5 border-t border-white/10 py-7 text-sm text-muted">
            <p>Pristine is free for everyone.</p>
            <div className="flex flex-wrap items-center gap-5">
              <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="hover:text-text">Source code ↗</a>
              <Link href="/legal/privacy" className="hover:text-text">Privacy</Link>
            </div>
          </footer>
        </div>
      </main>
    </>
  );
}
