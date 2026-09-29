import { scanFile } from './mp4/scan';
import { prepareUpload } from './mp4/upload';
import type { FFmpeg } from '@ffmpeg/ffmpeg';
import type { Conversion } from 'mediabunny';

export const EXPORT_PRESETS = [
  { label: '4K · 60 fps', short: 2160, long: 3840, fps: 60, codec: 'avc' as const },
  { label: '1080p · 120 fps', short: 1080, long: 1920, fps: 120, codec: 'avc' as const },
  { label: '4K · 120 fps', short: 2160, long: 3840, fps: 120, codec: 'hevc' as const },
];
export type VideoInfo = { file: File; width: number; height: number; fps: number; duration: number; codec: string };
type Progress = (message: string, fraction?: number) => void;
const assetBase = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/encoder`;
let wrapperPromise: Promise<void> | undefined;

export async function inspectVideo(file: File): Promise<VideoInfo> {
  if (!file.size) throw new Error('Choose a video that is fully downloaded to your device. This file is empty.');
  const { Input, BlobSource, ALL_FORMATS } = await import('mediabunny');
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('This file has no video track.');
    const [width, height, stats, duration, codec] = await Promise.all([
      track.getDisplayWidth(), track.getDisplayHeight(), track.computePacketStats(120),
      track.computeDuration(), track.getCodec(),
    ]);
    return { file, width, height, fps: stats.averagePacketRate, duration, codec: codec?.toUpperCase() ?? 'Video' };
  } finally { input.dispose(); }
}

function aborted(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Conversion cancelled.', 'AbortError');
}

async function nativeConvert(info: VideoInfo, selected: number, width: number, height: number, update: Progress, signal: AbortSignal, copyVideo: boolean) {
  const m = await import('mediabunny');
  const preset = EXPORT_PRESETS[selected];
  const quality = new m.Quality({ bitrate: selected === 1 ? 24_000_000 : 40_000_000 });
  if (!copyVideo && !await m.canEncodeVideo(preset.codec, { width, height, frameRate: preset.fps, quality })) return null;
  if (!await m.canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000 })) {
    const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
    registerAacEncoder();
  }
  const input = new m.Input({ source: new m.BlobSource(info.file), formats: m.ALL_FORMATS });
  const output = new m.Output({ format: new m.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new m.BufferTarget() });
  let conversion: Conversion | undefined;
  const cancel = () => { void conversion?.cancel(); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    aborted(signal);
    conversion = await m.Conversion.init({
      input, output,
      video: (_, index) => index ? { discard: true } : copyVideo ? { forceTranscode: false } : {
        width, height, fit: 'contain', frameRate: preset.fps, codec: preset.codec,
        quality, forceTranscode: true, allowTransformationMetadata: false, keyFrameInterval: 2,
      },
      audio: (_, index) => index ? { discard: true } : {
        codec: 'aac', numberOfChannels: 2, sampleRate: 48000, quality: new m.Quality({ bitrate: 192_000 }), forceTranscode: true,
      },
      tags: {},
    });
    // Never silently drop a source audio/video track because its decoder is unavailable.
    if (!conversion.isValid || conversion.discardedTracks.some(track => track.reason !== 'discarded_by_user')) return null;
    conversion.onProgress = progress => update(copyVideo ? 'Preparing audio and container — keeping original video' : 'Converting on your device', progress);
    await conversion.execute();
    aborted(signal);
    if (!output.target.buffer) throw new Error('The video encoder returned an empty file.');
    return new File([output.target.buffer], 'converted.mp4', { type: 'video/mp4' });
  } finally {
    signal.removeEventListener('abort', cancel);
    input.dispose();
    if (output.state !== 'finalized') await output.cancel();
  }
}

async function loadSoftware(): Promise<FFmpeg> {
  const host = window as unknown as { FFmpegWASM?: { FFmpeg: new () => FFmpeg } };
  if (!host.FFmpegWASM) {
    wrapperPromise ??= new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `${assetBase}/ffmpeg.js`;
      script.onload = () => resolve();
      script.onerror = () => { script.remove(); wrapperPromise = undefined; reject(new Error('The encoder could not load. Check your connection and try again.')); };
      document.head.appendChild(script);
    });
    await wrapperPromise;
  }
  if (!host.FFmpegWASM) throw new Error('The local encoder is unavailable in this browser.');
  return new host.FFmpegWASM.FFmpeg();
}

async function softwareConvert(info: VideoInfo, selected: number, width: number, height: number, update: Progress, signal: AbortSignal, copyVideo: boolean) {
  const preset = EXPORT_PRESETS[selected];
  update('Loading the free local encoder (31 MB)');
  const threaded = !copyVideo && preset.codec === 'hevc';
  const message = copyVideo ? 'Preparing audio and container — keeping original video' : 'Converting on your device — keep this tab open';
  if (threaded && !window.crossOriginIsolated) throw new Error('Reload this page once to enable 4K conversion, then choose your video again. If it still fails, open Pristine directly in Chrome or Edge.');
  const coreBase = threaded ? `${assetBase}/threaded` : assetBase;
  const ffmpeg = await loadSoftware();
  const cancel = () => ffmpeg.terminate();
  signal.addEventListener('abort', cancel, { once: true });
  const recent: string[] = [];
  ffmpeg.on('log', ({ message }) => {
    recent.push(message); if (recent.length > 12) recent.shift();
    const time = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
    if (time && info.duration > 0) update(message, Math.min(0.99, (+time[1] * 3600 + +time[2] * 60 + +time[3]) / info.duration));
  });
  try {
    aborted(signal);
    await ffmpeg.load({ coreURL: new URL(`${coreBase}/ffmpeg-core.js`, location.href).href, wasmURL: new URL(`${coreBase}/ffmpeg-core.wasm`, location.href).href,
      ...(threaded ? { workerURL: new URL(`${coreBase}/ffmpeg-core.worker.js`, location.href).href } : {}) });
    aborted(signal);
    update(message, 0);
    await ffmpeg.writeFile('input', new Uint8Array(await info.file.arrayBuffer()));
    const codec = preset.codec === 'hevc'
      ? ['-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '20', '-tag:v', 'hvc1', '-x265-params', 'level-idc=5.2:vbv-maxrate=60000:vbv-bufsize=60000:pools=none:frame-threads=1']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-profile:v', 'high', '-level:v', selected === 0 ? '5.2' : '5.1'];
    const videoArgs = copyVideo ? ['-c:v', 'copy'] : [
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${preset.fps}`,
      ...codec, '-bf', '0', '-pix_fmt', 'yuv420p', '-threads', '1',
    ];
    const status = await ffmpeg.exec(['-threads', '1', '-filter_threads', '1', '-i', 'input', '-map', '0:v:0', '-map', '0:a:0?',
      ...videoArgs, '-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', '192k',
      '-map_metadata', '-1', '-use_editlist', '0', '-movflags', '+faststart', '-y', 'output.mp4']);
    aborted(signal);
    if (status !== 0) {
      console.warn('Local encoder:', recent.join('\n'));
      throw new Error('This device could not convert the video. Try a shorter clip or a desktop browser with more available memory.');
    }
    const data = await ffmpeg.readFile('output.mp4');
    if (typeof data === 'string') throw new Error('The encoder did not produce an MP4.');
    return new File([data as BlobPart], 'converted.mp4', { type: 'video/mp4' });
  } finally {
    signal.removeEventListener('abort', cancel);
    ffmpeg.terminate();
  }
}

export async function convertForUpload(info: VideoInfo, selected: number, update: Progress, signal: AbortSignal): Promise<File> {
  const preset = EXPORT_PRESETS[selected];
  const landscape = info.width > info.height;
  const width = landscape ? preset.long : preset.short;
  const height = landscape ? preset.short : preset.long;
  const name = `${info.file.name.replace(/\.[^.]+$/, '')}-${selected === 1 ? '1080p' : '4K'}-${preset.fps}fps-pristine.mp4`;
  aborted(signal);
  update('Checking the video');
  let copyVideo = false;
  try {
    const original = await scanFile(info.file);
    copyVideo = original.width === width && original.height === height && Math.abs(original.fps - preset.fps) < 0.5
      && (selected !== 2 || original.codec === 'HEVC');
    if (copyVideo) {
      const prepared = prepareUpload(original, 'compatible', true);
      const check = await scanFile(prepared);
      if (Math.abs(check.fps - preset.fps) < 0.5) return new File([prepared], name, { type: 'video/mp4' });
    }
  } catch { /* Keep matching video packets when only the audio/container needs normalization. */ }
  let converted: File | null = null;
  try { converted = await nativeConvert(info, selected, width, height, update, signal, copyVideo); }
  catch (error) { if (signal.aborted) throw error; console.info('Using the software encoder.', error); }
  aborted(signal);
  converted ??= await softwareConvert(info, selected, width, height, update, signal, copyVideo);
  aborted(signal);
  update('Verifying dimensions and frame rate');
  const scan = await scanFile(converted);
  if (scan.width !== width || scan.height !== height
    || (selected === 2 && scan.codec !== 'HEVC')) throw new Error('The encoder did not produce the selected quality. No incorrect file was saved.');
  const prepared = prepareUpload(scan, 'compatible', true, copyVideo ? undefined : preset.fps);
  const final = await scanFile(prepared);
  if (Math.abs(final.fps - preset.fps) > 0.5) throw new Error('The prepared file did not retain the selected frame rate. No incorrect file was saved.');
  return new File([prepared], name, { type: 'video/mp4' });
}
