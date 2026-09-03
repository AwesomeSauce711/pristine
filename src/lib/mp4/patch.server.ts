import 'server-only';

/*
 * patch.server.ts — the transform. SERVER ONLY.
 *
 * The `server-only` import above is load-bearing: it makes the build fail if
 * this module is ever pulled into a client bundle. That is the entire security
 * boundary of the product. If this ships to the browser, the paywall becomes an
 * `if` statement on a machine we do not control.
 *
 * WHAT IT DOES
 * Gives a decoy audio track roughly ten times the samples it really has, and
 * leaves the video track alone. Ingest appears to size its transcode job from
 * the declared sample count before decoding anything, so a file claiming ten
 * times the work is shelved and served as-is.
 *
 * Measured with a paired upload on an account with zero followers: the patched
 * file came back videoQuality "original", 2160x3840 at 41.72 Mbps, byte-for-byte
 * identical to the upload, with an EMPTY rendition ladder — no compressed rung
 * was ever built, so there is nothing for a viewer's player to fall back to. The
 * control, identical but unpatched, came back 720x1280 at 2.90 Mbps and 30fps.
 *
 * WHY IT DOES NOT BREAK PLAYBACK
 * An earlier version of this idea inflated the VIDEO sample table. It also
 * reached the original gear, and it was useless: the declared duration no longer
 * matched the frames, so posts played at quarter speed and sat unpublishable for
 * 48 hours. Inflating a duplicate AUDIO track costs nothing — the video timeline
 * stays exact, so the picture is bit-identical, and a player uses the FIRST
 * audio track, so the decoy is never decoded. The inconsistency exists only in
 * the arithmetic an ingest pipeline does when it sizes the job.
 *
 * ON SECRECY
 * There is little. A competitor describes the same technique publicly, and this
 * method was itself recovered from another tool's *published output files* —
 * no source, no inputs, no cooperation. One output file is enough. So this
 * module is server-side to enforce payment, not to keep a secret, and no
 * engineering should be spent on obfuscation. One consequence worth honouring:
 * never stamp an identifying tag into the output's `udta`. That stamp is
 * precisely how the prior art was identified.
 */

import {
  Box, Mp4Error, audioTraks, be32, buildBox, cat, children, findBox, findPath, nextTrackIdOffset, offsetBoxes, offsetCount, parseStsc, parseStts, parseStsz, putU32, putU64, readOffset, trackIdOffset, traksOf, u32, u64, writeOffset, type SttsEntry, type StscEntry, ascii,
} from './boxes';

/** Bytes per phantom sample, matching the reference files. */
const PHANTOM_SIZE = 8;
/** One media tick — the smallest lie that still adds a sample. */
const PHANTOM_DELTA = 1;

/**
 * Ceiling on the real sample count, separate from the per-box bounds in
 * boxes.ts.
 *
 * The patch MULTIPLIES this count: rebuilt tables are `real * multiplier`
 * entries and get concatenated several times over, so peak memory runs to
 * roughly 240 bytes per real sample. 250k samples is about 90 minutes of AAC,
 * far past any platform's upload limit, and keeps the worst case comfortably
 * inside a small serverless instance.
 */
const MAX_REAL_SAMPLES = 250_000;

export const MULTIPLIER_MIN = 2;
export const MULTIPLIER_MAX = 20;
export const DEFAULT_MULTIPLIER = 10;

export interface PatchResult {
  /** The rebuilt moov, to be sent back to the client. */
  moov: Uint8Array;
  /** The mdat header the client should write before its own payload bytes. */
  mdatHeader: Uint8Array;
  /** Total bytes after the payload: fillerHead first, zeros for the rest. */
  fillerLen: number;
  /** Bytes that must be written at the start of the filler (empty when none). */
  fillerHead: Uint8Array;
  /** True when the file had no audio and a silent track was supplied. */
  synthesisedAudio: boolean;
  /** Total size of the file the client will assemble. */
  outputLen: number;
  realSamples: number;
  phantomSamples: number;
  clonedTrack: boolean;
  movedMoov: boolean;
  /**
   * Whether the decoy carried an inherited edit list that had to be neutralised.
   * False means the source had none, not that the step was skipped.
   */
  neutralisedEdts: boolean;
}

const buildStts = (e: SttsEntry[]): Uint8Array =>
  buildBox('stts', cat([be32(0), be32(e.length), cat(e.map(([c, d]) => cat([be32(c), be32(d)])))]));

const buildStsc = (e: StscEntry[]): Uint8Array =>
  buildBox('stsc', cat([be32(0), be32(e.length), cat(e.map((x) => cat([be32(x[0]), be32(x[1]), be32(x[2])])))]));

function buildStsz(sizes: number[]): Uint8Array {
  const body = new Uint8Array(sizes.length * 4);
  for (let i = 0; i < sizes.length; i++) putU32(body, i * 4, sizes[i]);
  return buildBox('stsz', cat([be32(0), be32(0), be32(sizes.length), body]));
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta', 'dinf']);

export interface PatchInput {
  /** The original moov box, standalone. */
  moov: Uint8Array;
  /** Length of ftyp, which stays first in the output. */
  ftypLen: number;
  /** Offset of the mdat PAYLOAD in the source file. */
  payloadStart: number;
  /** Length of that payload. */
  payloadLen: number;
  multiplier?: number;
  /** True when the source had moov after mdat, so it is being moved. */
  movedMoov?: boolean;
}

export function buildPatchedMoov(input: PatchInput): PatchResult {
  const { ftypLen, payloadStart, payloadLen } = input;
  const multiplier = input.multiplier ?? DEFAULT_MULTIPLIER;

  if (!Number.isInteger(multiplier) || multiplier < MULTIPLIER_MIN || multiplier > MULTIPLIER_MAX) {
    throw new Mp4Error('bad_multiplier', `Multiplier must be a whole number between ${MULTIPLIER_MIN} and ${MULTIPLIER_MAX}.`);
  }

  let moov = input.moov;
  let clonedTrack = false;
  let fillerHead: Uint8Array = new Uint8Array(0);
  let synthesisedAudio = false;

  /* ---- manufacture a decoy if there is not already one ------------------ */

  if (audioTraks(moov).length < 2) {
    if (!audioTraks(moov).length) {
      /*
       * No audio at all. Rather than send the reader back to their editor, a
       * silent track is supplied here -- a real, valid AAC-LC stream of
       * silence, its samples written into the file after the payload -- and
       * everything below then treats it exactly like a track the file arrived
       * with. To a player it is a video with silent audio, which is what it
       * would have been anyway.
       */
      const mv = findBox(moov, 'mvhd', 8, moov.length);
      if (!mv) throw new Mp4Error('no_mvhd', 'This video is missing its movie header.');
      const id = u32(moov, nextTrackIdOffset(moov, mv));
      const silent = buildSilentTrak(moov, mv, id, payloadStart + payloadLen);
      const kids0 = children(moov, 8, moov.length);
      moov = buildBox('moov', cat([
        ...kids0.map((k) => moov.subarray(k.pos, k.pos + k.size)),
        silent.trak,
      ]));
      const mv1 = findBox(moov, 'mvhd', 8, moov.length);
      if (mv1) putU32(moov, nextTrackIdOffset(moov, mv1), id + 1);
      fillerHead = silent.bytes;
      synthesisedAudio = true;
    }
    const audio = audioTraks(moov);
    const mvhd = findBox(moov, 'mvhd', 8, moov.length);
    if (!mvhd) throw new Mp4Error('no_mvhd', 'This video is missing its movie header.');
    const nextId = u32(moov, nextTrackIdOffset(moov, mvhd));

    const src = audio[audio.length - 1];
    /*
     * MUST be a real copy. `.slice()` on a Node Buffer returns a VIEW sharing
     * the same memory — Buffer overrides it as an alias for subarray — so
     * writing the new track_ID below would also overwrite the ORIGINAL audio
     * trak's id, leaving two traks claiming the same number. A browser
     * Uint8Array copies, so this only ever manifested off the browser path.
     */
    const clone = new Uint8Array(moov.subarray(src.pos, src.pos + src.size));
    const tk = findBox(clone, 'tkhd', 8, clone.length);
    if (!tk) throw new Mp4Error('no_tkhd', 'The audio track is missing its header.');
    putU32(clone, trackIdOffset(clone, tk), nextId);

    /*
     * The clone keeps the original's chunk offsets. Two traks pointing at the
     * same chunks is legal — stco holds absolute file offsets and nothing
     * requires them to be disjoint — so the decoy costs no media bytes at all.
     * Verified by decoding both tracks: byte-identical PCM.
     */
    const kids = children(moov, 8, moov.length);
    moov = buildBox('moov', cat([
      ...kids.map((k) => moov.subarray(k.pos, k.pos + k.size)),
      clone,
    ]));

    const mv2 = findBox(moov, 'mvhd', 8, moov.length);
    if (mv2) putU32(moov, nextTrackIdOffset(moov, mv2), nextId + 1);
    clonedTrack = true;
  }

  /* ---- inflate the decoy ----------------------------------------------- */

  const audio = audioTraks(moov);
  const decoy = audio[audio.length - 1];   // a player uses the FIRST one
  const stbl = findPath(moov, ['mdia', 'minf', 'stbl'], decoy.pos + 8, decoy.pos + decoy.size);
  if (!stbl) throw new Mp4Error('no_sample_table', 'The audio track has no sample table.');

  /*
   * NEUTRALISE THE DECOY'S EDIT LIST.
   *
   * An elst maps presentation time onto media time, and the segment_duration it
   * declares is the REAL duration — so a decoy that inherits its source's edit
   * list has the phantom ticks clamped straight back out of the presented
   * timeline. The inflation is still sitting in the sample tables, but it stops
   * being visible to anything that honours edit lists, and TikTok evidently
   * does: an upload whose decoy carried an inherited elst was re-encoded, while
   * the byte-identical file with this single box neutralised came back untouched
   * at 4K60.
   *
   * Both files the method was originally measured on happen to carry no elst at
   * all, which is why this never surfaced. Most encoders emit one — the source
   * that exposed it was HandBrake output — so this is the common case, not the
   * exotic one.
   *
   * Rewriting the fourcc to 'free' rather than deleting the box keeps every
   * following byte exactly where it was: 'free' is defined as skippable padding,
   * so parsers ignore its contents and no chunk offset has to move. Deleting it
   * would shrink the moov and shift the whole media payload for no benefit.
   */
  const decoyEdtsPos =
    findBox(moov, 'edts', decoy.pos + 8, decoy.pos + decoy.size)?.pos ?? -1;

  const sb: [number, number] = [stbl.pos + 8, stbl.pos + stbl.size];
  const stts = findBox(moov, 'stts', ...sb);
  const stsz = findBox(moov, 'stsz', ...sb);
  const stsc = findBox(moov, 'stsc', ...sb);
  const stco = findBox(moov, 'stco', ...sb) ?? findBox(moov, 'co64', ...sb);
  if (!stts || !stsz || !stsc || !stco) {
    throw new Mp4Error('no_sample_table', 'The audio track is missing part of its sample table.');
  }

  const sizes = parseStsz(moov, stsz);
  const sttsEntries = parseStts(moov, stts);
  const stscEntries = parseStsc(moov, stsc);
  const chunkCount = offsetCount(moov, stco);

  const real = sizes.length;
  if (real > MAX_REAL_SAMPLES) {
    throw new Mp4Error(
      'too_many_samples',
      `This audio track has ${real} samples, more than we can patch. Try a shorter video.`,
    );
  }

  const phantom = Math.round(real * (multiplier - 1));
  if (phantom < 1) throw new Mp4Error('bad_multiplier', 'Multiplier is too small to add any samples.');

  const newStts: SttsEntry[] = [...sttsEntries, [phantom, PHANTOM_DELTA]];
  const newSizes = [...sizes, ...new Array<number>(phantom).fill(PHANTOM_SIZE)];
  // All phantoms in one extra chunk, matching the reference files.
  const newStsc: StscEntry[] = [...stscEntries, [chunkCount + 1, phantom, 1]];

  const fillerEntryIndex = chunkCount;
  const oldOffsets: number[] = [];
  for (let i = 0; i < chunkCount; i++) oldOffsets.push(readOffset(moov, stco, i));

  /*
   * Rebuilt bottom-up so every ancestor size is recomputed rather than patched,
   * which is what keeps the box tree self-consistent.
   */
  const decoyStblPos = stbl.pos;
  /* Containers nest a handful deep in any real file. A crafted index that
   * nests thousands deep would otherwise recurse until the stack gave out. */
  const MAX_DEPTH = 16;
  const rebuild = (b: Uint8Array, pos: number, size: number, depth = 0): Uint8Array => {
    if (depth > MAX_DEPTH) {
      throw new Mp4Error('bad_structure', "This video's index is malformed.");
    }
    const type = b[pos + 4] !== undefined
      ? String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7])
      : '';
    // Must precede the CONTAINERS check: 'edts' is a container, so the walk
    // would otherwise recurse into it and rebuild it under its original type.
    if (pos === decoyEdtsPos) {
      const freed = b.slice(pos, pos + size);
      freed.set([0x66, 0x72, 0x65, 0x65], 4);   // 'free'
      return freed;
    }
    if (pos === decoyStblPos) {
      const parts: Uint8Array[] = [];
      for (const k of children(b, pos + 8, pos + size)) {
        if (k.type === 'stts') parts.push(buildStts(newStts));
        else if (k.type === 'stsz') parts.push(buildStsz(newSizes));
        else if (k.type === 'stsc') parts.push(buildStsc(newStsc));
        else if (k.type === 'stco' || k.type === 'co64') {
          const body = new Uint8Array((chunkCount + 1) * (k.type === 'co64' ? 8 : 4));
          parts.push(buildBox(k.type, cat([be32(0), be32(chunkCount + 1), body])));
        } else parts.push(b.subarray(k.pos, k.pos + k.size));
      }
      return buildBox('stbl', cat(parts));
    }
    if (!CONTAINERS.has(type)) return b.subarray(pos, pos + size);
    const parts: Uint8Array[] = [];
    for (const k of children(b, pos + 8, pos + size)) parts.push(rebuild(b, k.pos, k.size, depth + 1));
    if (!parts.length) return b.subarray(pos, pos + size);
    return buildBox(type, cat(parts));
  };

  const newMoov = rebuild(moov, 0, moov.length);

  /*
   * The decoy's mdhd duration is in media ticks and the phantoms add one each.
   * Without this the track header disagrees with its own sample table, which is
   * the kind of inconsistency a validator can reject outright.
   */
  {
    const nAudio = audioTraks(newMoov);
    const nDecoy = nAudio[nAudio.length - 1];
    const mdhd = findPath(newMoov, ['mdia', 'mdhd'], nDecoy.pos + 8, nDecoy.pos + nDecoy.size);
    if (mdhd) {
      const added = phantom * PHANTOM_DELTA;
      if (newMoov[mdhd.pos + 8] === 1) {
        putU64(newMoov, mdhd.pos + 8 + 24, u64(newMoov, mdhd.pos + 8 + 24) + added);
      } else {
        putU32(newMoov, mdhd.pos + 8 + 16, u32(newMoov, mdhd.pos + 8 + 16) + added);
      }
    }
  }

  /* ---- lay the file out and fix every offset --------------------------- */

  /* The filler: the silent track's own samples first (when there is one),
   * then the phantoms' zeros. Both live after the payload, inside mdat. */
  const fillerLen = fillerHead.length + phantom * PHANTOM_SIZE;
  const newMdatSize = 8 + payloadLen + fillerLen;
  /* mdat needs a 64-bit header once its own size passes 4 GB; writing a 32-bit
   * one there would silently truncate the length field. */
  const big = newMdatSize > 0xFFFFFFFF;
  const mdatHeaderLen = big ? 16 : 8;
  const mdatHeader = big
    ? cat([be32(1), new Uint8Array([0x6d, 0x64, 0x61, 0x74]), (() => {
        const a = new Uint8Array(8);
        putU64(a, 0, 16 + payloadLen + fillerLen);
        return a;
      })()])
    : cat([be32(newMdatSize), new Uint8Array([0x6d, 0x64, 0x61, 0x74])]);

  const newDataStart = ftypLen + newMoov.length + mdatHeaderLen;
  const shift = newDataStart - payloadStart;
  const fillerOffset = newDataStart + payloadLen + fillerHead.length;

  const decoyOffsetBox = (() => {
    const nAudio = audioTraks(newMoov);
    const nDecoy = nAudio[nAudio.length - 1];
    const nStbl = findPath(newMoov, ['mdia', 'minf', 'stbl'], nDecoy.pos + 8, nDecoy.pos + nDecoy.size);
    if (!nStbl) throw new Mp4Error('internal', 'Lost the decoy sample table while rebuilding.');
    return findBox(newMoov, 'stco', nStbl.pos + 8, nStbl.pos + nStbl.size)
        ?? findBox(newMoov, 'co64', nStbl.pos + 8, nStbl.pos + nStbl.size);
  })();
  if (!decoyOffsetBox) throw new Mp4Error('internal', 'Lost the decoy chunk offsets while rebuilding.');

  for (const box of offsetBoxes(newMoov)) {
    if (box.pos === decoyOffsetBox.pos) continue;   // restored below
    const n = offsetCount(newMoov, box);
    for (let i = 0; i < n; i++) writeOffset(newMoov, box, i, readOffset(newMoov, box, i) + shift);
  }
  for (let i = 0; i < fillerEntryIndex; i++) {
    writeOffset(newMoov, decoyOffsetBox, i, oldOffsets[i] + shift);
  }
  writeOffset(newMoov, decoyOffsetBox, fillerEntryIndex, fillerOffset);

  /* A 32-bit stco cannot describe an offset past 4 GB. Caught here rather than
   * shipping a file that plays until it reaches the far chunks. */
  for (const box of offsetBoxes(newMoov)) {
    if (box.type !== 'stco') continue;
    const n = offsetCount(newMoov, box);
    for (let i = 0; i < n; i++) {
      if (readOffset(newMoov, box, i) > 0xFFFFFFFF) {
        throw new Mp4Error('stco_overflow', 'This file is too large for 32-bit chunk offsets.');
      }
    }
  }

  return {
    moov: newMoov,
    mdatHeader,
    fillerLen,
    fillerHead,
    synthesisedAudio,
    outputLen: ftypLen + newMoov.length + mdatHeaderLen + payloadLen + fillerLen,
    realSamples: real,
    phantomSamples: phantom,
    clonedTrack,
    neutralisedEdts: decoyEdtsPos >= 0,
    movedMoov: input.movedMoov ?? false,
  };
}

/*
 * A silent AAC-LC track, built from nothing.
 *
 * 44.1 kHz stereo, 1024 samples a frame; every frame is the same six-byte
 * AAC-LC "silence" frame, which is what an encoder emits for digital silence
 * once it has settled. The sample bytes are handed back to be written into the
 * file after the payload; the chunk offset is written in the ORIGINAL file's
 * coordinates (just after the payload) so that the offset shift applied to
 * every track below lands it exactly where the bytes go.
 */
const SILENT_FRAME = new Uint8Array([0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c]);
const AAC_RATE = 44100;
const AAC_FRAME = 1024;
/* AudioSpecificConfig: AAC-LC, 44.1 kHz, stereo. */
const AAC_ASC = new Uint8Array([0x12, 0x10]);

const be16 = (n: number): Uint8Array => new Uint8Array([(n >>> 8) & 0xff, n & 0xff]);
const zeros = (n: number): Uint8Array => new Uint8Array(n);

function buildSilentTrak(
  moov: Uint8Array,
  mvhd: Box,
  trackId: number,
  chunkOffset: number,
): { trak: Uint8Array; bytes: Uint8Array } {
  const v1 = moov[mvhd.pos + 8] === 1;
  const timescale = v1 ? u32(moov, mvhd.pos + 8 + 20) : u32(moov, mvhd.pos + 8 + 12);
  const duration = v1 ? u64(moov, mvhd.pos + 8 + 24) : u32(moov, mvhd.pos + 8 + 16);
  const seconds = timescale > 0 ? duration / timescale : 0;
  const frames = Math.max(1, Math.ceil((seconds * AAC_RATE) / AAC_FRAME));
  /* The movie header is a field in an untrusted file. A duration that asks
   * for more silence than the clone path would accept as real audio is not a
   * video anyone made; refuse it before a byte is allocated. */
  if (!Number.isFinite(frames) || frames > MAX_REAL_SAMPLES) {
    throw new Mp4Error('too_long', 'This video is longer than we can process. Try a shorter clip.');
  }
  const mediaDuration = frames * AAC_FRAME;
  const trackDuration = Math.round((mediaDuration / AAC_RATE) * timescale);

  const bytes = new Uint8Array(frames * SILENT_FRAME.length);
  for (let i = 0; i < frames; i++) bytes.set(SILENT_FRAME, i * SILENT_FRAME.length);

  /* tkhd, version 0: enabled, in movie, in preview. */
  const tkhd = buildBox('tkhd', cat([
    be32(0x00000007), be32(0), be32(0), be32(trackId), be32(0), be32(trackDuration),
    zeros(8), be16(0), be16(0), be16(0x0100), be16(0),
    be32(0x00010000), be32(0), be32(0), be32(0), be32(0x00010000), be32(0), be32(0), be32(0), be32(0x40000000),
    be32(0), be32(0),
  ]));
  const mdhd = buildBox('mdhd', cat([
    be32(0), be32(0), be32(0), be32(AAC_RATE), be32(mediaDuration), be16(0x55c4), be16(0),
  ]));
  const hdlr = buildBox('hdlr', cat([
    be32(0), be32(0), ascii('soun'), zeros(12), ascii('SoundHandler'), zeros(1),
  ]));
  const smhd = buildBox('smhd', cat([be32(0), be16(0), be16(0)]));
  const dinf = buildBox('dinf', buildBox('dref', cat([
    be32(0), be32(1), buildBox('url ', be32(0x00000001)),
  ])));

  /* esds: ES > DecoderConfig(AAC, audio) > DecoderSpecificInfo(ASC) ; SLConfig */
  const dsi = cat([new Uint8Array([0x05, AAC_ASC.length]), AAC_ASC]);
  const dcdBody = cat([
    new Uint8Array([0x40, 0x15, 0x00, 0x06, 0x00]),   // AAC, audio stream, buffer size
    be32(128_000), be32(128_000),                       // max / average bitrate (nominal)
    dsi,
  ]);
  const dcd = cat([new Uint8Array([0x04, dcdBody.length]), dcdBody]);
  const sl = new Uint8Array([0x06, 0x01, 0x02]);
  const esBody = cat([be16(0), new Uint8Array([0x00]), dcd, sl]);
  const es = cat([new Uint8Array([0x03, esBody.length]), esBody]);
  const esds = buildBox('esds', cat([be32(0), es]));

  const mp4a = buildBox('mp4a', cat([
    zeros(6), be16(1),                       // reserved, data_reference_index
    be16(0), be16(0), be32(0),               // version, revision, vendor
    be16(2), be16(16), be16(0), be16(0),     // channels, sample size, compression id, packet size
    be32(AAC_RATE << 16),                    // sample rate, 16.16
    esds,
  ]));
  const stsd = buildBox('stsd', cat([be32(0), be32(1), mp4a]));
  const stts = buildStts([[frames, AAC_FRAME]]);
  const stsc = buildStsc([[1, frames, 1]]);
  const stsz = buildStsz(new Array<number>(frames).fill(SILENT_FRAME.length));
  const stco = buildBox('stco', cat([be32(0), be32(1), be32(chunkOffset)]));
  const stbl = buildBox('stbl', cat([stsd, stts, stsc, stsz, stco]));
  const minf = buildBox('minf', cat([smhd, dinf, stbl]));
  const mdia = buildBox('mdia', cat([mdhd, hdlr, minf]));
  const trak = buildBox('trak', cat([tkhd, mdia]));
  return { trak, bytes };
}

/** Unused export kept out; traksOf is re-exported only for the test harness. */
export { traksOf };
