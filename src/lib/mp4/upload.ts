/**
 * Local upload preparation, based on the container properties
 * measured in September 2026 tests. Video packet bytes are never re-encoded.
 * See docs/upload-tests.md for evidence and limitations.
 */
import {
  type Box, Mp4Error, ascii, audioTraks, be32, buildBox, cat, children,
  findBox, findPath, fourcc, nextTrackIdOffset, offsetCount, parseStsc,
  parseStsz, parseStts, putU32, putU64, readOffset, trackIdOffset, traksOf,
  u16, u32, u64, videoTraks,
} from './boxes';
import { buildSilentTrak } from './patch';
import type { ScanResult } from './scan';

export type UploadAudioMode = 'compatible' | 'mobile';
const MAX_REAL_SAMPLES = 90_000;
const RAW_PACKET = Uint8Array.of(0, 0, 0, 4, 0, 0, 0, 0);
// AAC-LC stereo silence, generated with FFmpeg and decoded before testing.
const SILENT_PACKET = Uint8Array.of(0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c, 0, 0);
const bytes64 = (n: number) => { const b = new Uint8Array(8); putU64(b, 0, n); return b; };
const table = (name: string, rows: number[][]) => buildBox(name, cat([
  be32(0), be32(rows.length), ...rows.map(row => cat(row.map(be32))),
]));
const durationAt = (data: Uint8Array, box: Box) => box.pos +
  (data[box.pos + 8] === 1 ? (box.type === 'tkhd' ? 36 : 32) : (box.type === 'tkhd' ? 28 : 24));
const duration = (data: Uint8Array, box: Box) => data[box.pos + 8] === 1
  ? u64(data, durationAt(data, box)) : u32(data, durationAt(data, box));
const scale = (data: Uint8Array, box: Box) => u32(data, box.pos + (data[box.pos + 8] === 1 ? 28 : 20));

function setDuration(data: Uint8Array, box: Box, ticks: number): Uint8Array {
  if (!Number.isSafeInteger(ticks) || ticks < 0) throw new Mp4Error('bad_duration', 'This file has an unsupported track timeline.');
  const out = new Uint8Array(data.subarray(box.pos, box.pos + box.size));
  const versionOne = out[8] === 1;
  out.fill(0, 12, versionOne ? 28 : 20);
  const at = durationAt(data, box) - box.pos;
  if (versionOne) putU64(out, at, ticks);
  else {
    if (ticks > 0xffffffff) throw new Mp4Error('long_duration', 'This track is too long to prepare.');
    putU32(out, at, ticks);
  }
  return out;
}

function unspecifiedMovieDuration(data: Uint8Array, box: Box): Uint8Array {
  const rest = data.subarray(box.pos + (data[box.pos + 8] === 1 ? 40 : 28), box.pos + box.size);
  return buildBox('mvhd', cat([
    be32(0x01000000), bytes64(0), bytes64(0), be32(scale(data, box)),
    new Uint8Array(8).fill(255), rest,
  ]));
}

function metadata(): Uint8Array {
  const item = (name: string, value: string) => buildBox(name,
    buildBox('data', cat([be32(1), be32(0), new TextEncoder().encode(value)])));
  const handler = buildBox('hdlr', cat([be32(0), be32(0), ascii('mdir'), ascii('appl'), new Uint8Array(9)]));
  const fields = buildBox('ilst', cat([item('©too', 'Pristine'), item('©cmt', 'Prepared locally by Pristine')]));
  const namedHandler = buildBox('hdlr', cat([be32(0), be32(0), ascii('mdir'), new Uint8Array(13)]));
  return buildBox('udta', cat([
    buildBox('meta', cat([be32(4 + handler.length + fields.length), handler, fields])),
    buildBox('meta', cat([be32(0), namedHandler, buildBox('name', ascii('Pristine')),
      buildBox('ilst', item('©cmt', 'Prepared locally by Pristine'))])),
  ]));
}

function audioDescription(data: Uint8Array, box: Box, bitrate: number): Uint8Array {
  const out = new Uint8Array(data.subarray(box.pos, box.pos + box.size));
  let peak = bitrate;
  // Update only recognized decoder bitrate descriptors; do not touch the ASC.
  for (let p = 20; p + 16 <= out.length; p++) {
    if (fourcc(out, p) !== 'esds') continue;
    let at = p + 8;
    const readLength = () => { let n = 0; for (let i = 0; i < 4 && at < out.length; i++) {
      const b = out[at++]; n = n * 128 + (b & 127); if (!(b & 128)) return n;
    } return n; };
    if (out[at++] !== 3) break;
    readLength(); at += 2;
    const flags = out[at++];
    if (flags & 128) at += 2;
    if (flags & 64) at += 1 + out[at];
    if (flags & 32) at += 2;
    if (out[at++] !== 4) break;
    readLength(); at += 5;
    if (at + 8 <= out.length) { peak = Math.max(bitrate, u32(out, at + 4)); putU32(out, at, peak); putU32(out, at + 4, bitrate); }
    break;
  }
  for (let p = 20; p + 16 <= out.length; p++) if (fourcc(out, p) === 'btrt') {
    putU32(out, p + 8, peak); putU32(out, p + 12, bitrate); break;
  }
  return out;
}

function hasStereoAacLc(data: Uint8Array, desc: Box): boolean {
  if (u16(data, desc.pos + 40) !== 2) return false;
  const esds = findBox(data, 'esds', desc.pos + 52, desc.pos + desc.size);
  if (!esds) return false;
  let at = esds.pos + 12;
  const tag = (expected: number) => {
    if (data[at++] !== expected) return false;
    for (let n = 0; n < 4 && at < esds.pos + esds.size; n++) if (!(data[at++] & 128)) return true;
    return false;
  };
  if (!tag(3)) return false;
  at += 2;
  const flags = data[at++];
  if (flags & 128) at += 2;
  if (flags & 64) at += 1 + data[at];
  if (flags & 32) at += 2;
  if (!tag(4)) return false;
  at += 13;
  if (!tag(5) || at + 2 > esds.pos + esds.size) return false;
  return data[at] >> 3 === 2 && ((data[at + 1] >> 3) & 15) === 2;
}

export function prepareUpload(scan: ScanResult, audioMode: UploadAudioMode = 'compatible', duplicateAudio = false, encodedFrameRate?: number): File {
  let data = scan.moov;
  let movie = findBox(data, 'mvhd', 8, data.length);
  if (!movie) throw new Mp4Error('no_mvhd', 'This MP4 has no movie header.');
  let suppliedAudio: Uint8Array = new Uint8Array(0);
  if (audioTraks(data).length === 0) {
    const trackId = u32(data, nextTrackIdOffset(data, movie));
    const silent = buildSilentTrak(data, movie, trackId, scan.descriptor.payloadStart + scan.descriptor.payloadLen);
    data = buildBox('moov', cat([data.subarray(8), silent.trak]));
    suppliedAudio = silent.bytes;
    movie = findBox(data, 'mvhd', 8, data.length)!;
    putU32(data, nextTrackIdOffset(data, movie), trackId + 1);
  }
  const audio = audioTraks(data);
  if (audio.length !== 1) throw new Mp4Error('multiple_audio', 'Choose a clean export with one AAC audio track. This file may already be prepared.');
  const audioTrack = audio[0];
  const audioTable = findPath(data, ['mdia', 'minf', 'stbl'], audioTrack.pos + 8, audioTrack.pos + audioTrack.size);
  if (!audioTable) throw new Mp4Error('no_audio_table', 'The audio sample table is missing.');
  const audioBox = (name: string) => findBox(data, name, audioTable.pos + 8, audioTable.pos + audioTable.size);
  const desc = audioBox('stsd'), sizesBox = audioBox('stsz'), timingBox = audioBox('stts');
  if (!desc || !sizesBox || !timingBox || fourcc(data, desc.pos + 20) !== 'mp4a')
    throw new Mp4Error('aac_required', 'Export your video with AAC audio before preparing it.');
  if (audioMode === 'compatible' && !hasStereoAacLc(data, desc))
    throw new Mp4Error('stereo_required', 'Export with stereo AAC-LC audio for this upload option.');
  const realSizes = parseStsz(data, sizesBox), audioTiming = parseStts(data, timingBox);
  const tail = audioTiming.at(-1);
  if (tail?.[1] === 1 && tail[0] > 100) throw new Mp4Error('already_prepared', 'This video is already prepared. Start with its clean export.');
  if (!realSizes.length || realSizes.length > MAX_REAL_SAMPLES)
    throw new Mp4Error('audio_too_long', 'This audio track is too long to prepare in your browser.');
  const addedCount = realSizes.length * 9;
  const packet = audioMode === 'compatible' ? SILENT_PACKET : RAW_PACKET;
  const extra = new Uint8Array(addedCount * packet.length);
  for (let p = 0; p < extra.length; p += packet.length) extra.set(packet, p);
  const movieScale = scale(data, movie);
  if (!movieScale) throw new Mp4Error('bad_timescale', 'This MP4 has an invalid movie timescale.');
  const ftyp = buildBox('ftyp', cat([ascii('isom'), be32(512), ascii('isomiso2'),
    ...(scan.codec === 'H.264' ? [ascii('avc1')] : []), ascii('mp41')]));
  const payloadSize = scan.descriptor.payloadLen + suppliedAudio.length;
  const mdatHeader = payloadSize + 8 <= 0xffffffff ? cat([be32(payloadSize + 8), ascii('mdat')])
    : cat([be32(1), ascii('mdat'), bytes64(payloadSize + 16)]);
  const trackList = traksOf(data);
  const videoPositions = new Set(videoTraks(data).map(track => track.pos));
  const encodedMovieTicks = encodedFrameRate ? Math.round(scan.videoSamples * movieScale / encodedFrameRate) : undefined;

  function rebuildTrack(track: Box, shift: number, extraOffset: number, padAudio = true): Uint8Array {
    const pick = (names: string[]) => findPath(data, names, track.pos + 8, track.pos + track.size);
    const tkhd = pick(['tkhd']), mdhd = pick(['mdia', 'mdhd']), stbl = pick(['mdia', 'minf', 'stbl']);
    if (!tkhd || !mdhd || !stbl) throw new Mp4Error('incomplete_track', 'An MP4 track has incomplete headers.');
    const audioHere = padAudio && track.pos === audioTrack.pos;
    const rate = scale(data, mdhd);
    const timing = findBox(data, 'stts', stbl.pos + 8, stbl.pos + stbl.size);
    if (!timing || !rate) throw new Mp4Error('no_timing', 'A track has no valid sample timing.');
    const originalTiming = parseStts(data, timing);
    const originalTicks = originalTiming.reduce((sum, [count, delta]) => sum + count * delta, 0);
    let mediaTicks = originalTicks, movieTicks = duration(data, tkhd);
    let encodedTiming: number[][] | null = null;
    const edit = pick(['edts', 'elst']);
    if (encodedFrameRate && videoPositions.has(track.pos)) {
      // Only used after the converter has actually generated the requested frames.
      // AAC priming may otherwise stretch the first/last video sample in the muxer.
      const count = originalTiming.reduce((sum, [n]) => sum + n, 0);
      encodedTiming = [];
      for (let i = 0; i < count; i++) {
        const delta = Math.round((i + 1) * rate / encodedFrameRate) - Math.round(i * rate / encodedFrameRate);
        if (delta < 1) throw new Mp4Error('bad_timescale', 'The video timescale is too low for this frame rate.');
        const last = encodedTiming.at(-1);
        if (last?.[1] === delta) last[0]++; else encodedTiming.push([1, delta]);
      }
      mediaTicks = Math.round(count * rate / encodedFrameRate);
      movieTicks = Math.round(mediaTicks * movieScale / rate);
    }
    // Preserve existing edits and every original sample duration. Removing the
    // edits and pushing their offset into the last frame caused an end hold.
    // The added audio lives outside the original presentation interval.
    let suppliedEdit: Uint8Array | undefined;
    if (track.pos === audioTrack.pos && !edit) {
      if (encodedMovieTicks !== undefined) movieTicks = Math.min(movieTicks, encodedMovieTicks);
      const wide = movieTicks > 0xffffffff;
      suppliedEdit = buildBox('edts', buildBox('elst', cat([
        be32(wide ? 0x01000000 : 0), be32(1),
        ...(wide ? [bytes64(movieTicks), bytes64(0)] : [be32(movieTicks), be32(0)]), be32(0x00010000),
      ])));
    }
    if (audioHere) mediaTicks += addedCount;
    const replacements = new Map<number, Uint8Array>([[tkhd.pos, setDuration(data, tkhd, movieTicks)], [mdhd.pos, setDuration(data, mdhd, mediaTicks)]]);
    const chunks = children(data, stbl.pos + 8, stbl.pos + stbl.size);
    const offsets = chunks.find(b => b.type === 'stco' || b.type === 'co64');
    if (!offsets) throw new Mp4Error('no_offsets', 'A track has no sample offsets.');
    for (const box of chunks) {
      if (box.type === 'stts') {
        const entries = encodedTiming || parseStts(data, box);
        if (audioHere) entries.push([addedCount, 1]);
        replacements.set(box.pos, table('stts', entries));
      } else if (audioHere && box.type === 'stsc') {
        const entries = parseStsc(data, box);
        entries.push([offsetCount(data, offsets) + 1, addedCount, entries.at(-1)?.[2] || 1]);
        replacements.set(box.pos, table('stsc', entries));
      } else if (audioHere && box.type === 'stsz') {
        replacements.set(box.pos, buildBox('stsz', cat([be32(0), be32(0), be32(realSizes.length + addedCount),
          ...realSizes.map(be32), ...Array.from({ length: addedCount }, () => be32(packet.length))])));
      } else if (box === offsets) {
        const values = Array.from({ length: offsetCount(data, box) }, (_, i) => readOffset(data, box, i) + shift);
        if (audioHere) values.push(extraOffset);
        const wide = values.some(n => n > 0xffffffff);
        replacements.set(box.pos, buildBox(wide ? 'co64' : 'stco', cat([be32(0), be32(values.length), ...values.map(wide ? bytes64 : be32)])));
      } else if (audioHere && box.type === 'stsd') {
        replacements.set(box.pos, audioDescription(data, box, Math.floor(realSizes.reduce((a, b) => a + b, 0) * 8 * rate / originalTicks)));
      }
    }
    const rebuild = (box: Box): Uint8Array => {
      const replacement = replacements.get(box.pos);
      if (replacement) return replacement;
      if ((box.type === 'edts' && encodedTiming) || box.type === 'udta') return new Uint8Array(0);
      if (['trak', 'mdia', 'minf', 'stbl'].includes(box.type)) {
        const parts = children(data, box.pos + 8, box.pos + box.size).map(rebuild);
        if (box.type === 'trak' && suppliedEdit) parts.splice(1, 0, suppliedEdit);
        return buildBox(box.type, cat(parts));
      }
      return data.subarray(box.pos, box.pos + box.size);
    };
    const result = rebuild(track);
    if (duplicateAudio && audioHere) {
      const header = findBox(result, 'tkhd', 8, result.length)!;
      putU32(result, trackIdOffset(result, header), u32(data, nextTrackIdOffset(data, movie!)));
    }
    return result;
  }

  let outputMoov: Uint8Array = new Uint8Array(0);
  for (let attempt = 0; attempt < 8; attempt++) {
    const payloadAt = ftyp.length + outputMoov.length + mdatHeader.length;
    const next = buildBox('moov', cat([
      unspecifiedMovieDuration(data, movie),
      ...trackList.flatMap(track => {
        const shift = payloadAt - scan.descriptor.payloadStart;
        const extraOffset = payloadAt + payloadSize;
        return duplicateAudio && track.pos === audioTrack.pos
          ? [rebuildTrack(track, shift, extraOffset, false), rebuildTrack(track, shift, extraOffset)]
          : [rebuildTrack(track, shift, extraOffset)];
      }),
      metadata(),
    ]));
    const settled = next.length === outputMoov.length;
    outputMoov = next;
    if (duplicateAudio) {
      const mv = findBox(outputMoov, 'mvhd', 8, outputMoov.length)!;
      putU32(outputMoov, nextTrackIdOffset(outputMoov, mv), u32(data, nextTrackIdOffset(data, movie)) + 1);
    }
    if (settled) break;
    if (attempt === 7) throw new Mp4Error('offset_layout', 'Could not lay out this MP4 safely.');
  }
  return new File([
    ftyp as BlobPart, outputMoov as BlobPart, mdatHeader as BlobPart,
    scan.file.slice(scan.descriptor.payloadStart, scan.descriptor.payloadStart + scan.descriptor.payloadLen),
    suppliedAudio as BlobPart, extra as BlobPart,
  ], `${scan.fileName.replace(/\.[^.]+$/, '')}-pristine.mp4`, { type: 'video/mp4' });
}
