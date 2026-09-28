/*
 * scan.ts — read what a video actually is, in the browser, without uploading it.
 *
 * Runs entirely on the client. Only `ftyp` and `moov` are ever read — typically
 * 30–150 KB even for a 200 MB file — so this is fast and costs no bandwidth.
 * The media payload is never touched.
 *
 * Two jobs:
 *   1. Show the user real, measured properties of their file. Reading their
 *      codec, level and frame rate back to them is the most direct way to show
 *      the tool actually understands the file rather than guessing.
 *   2. Produce the small descriptor the local patcher needs. Videos with no
 *      audio track are supported by adding a silent track during the patch.
 */

import {
  Box, Mp4Error, audioTraks, children, findBox, findPath, readBoxHeader,
  parseStsz, u16, u32, u64, videoTraks,
} from './boxes';

export interface ScanResult {
  /** What the local patcher needs to build the patched moov. */
  descriptor: {
    ftypLen: number;
    moovLen: number;
    payloadStart: number;
    payloadLen: number;
  };
  /** The moov bytes, kept on the device for the patcher. */
  moov: Uint8Array;
  /** The ftyp bytes, kept locally for reassembly. */
  ftyp: Uint8Array;

  /** The File the scan actually read. Usually the one given; a File that the
   *  browser reported as 0 bytes is re-materialised from its bytes, and every
   *  later read must use this one. */
  file: File;
  fileName: string;
  fileSize: number;
  durationSec: number;
  /** Whole-file bitrate in Mbps. */
  bitrateMbps: number;

  width: number;
  height: number;
  fps: number;
  videoSamples: number;
  codec: string;
  profile: string;
  level: string;

  audioTrackCount: number;
  /** The patch clones an audio track to use as the decoy; without one it cannot run. */
  hasAudio: boolean;

  /** True when moov sits after mdat — common straight out of an editor. */
  needsFaststart: boolean;
}

const MAX_MOOV_BYTES = 4 * 1024 * 1024;

/** H.264 profile_idc values worth naming. */
const AVC_PROFILES: Record<number, string> = {
  66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High',
  110: 'High 10', 122: 'High 4:2:2', 244: 'High 4:4:4',
};

const HEVC_PROFILES: Record<number, string> = {
  1: 'Main', 2: 'Main 10', 3: 'Main Still Picture', 4: 'Range Extensions',
};

/**
 * Read only the bytes needed, by walking top-level box headers.
 *
 * Never assumes ftyp/moov/mdat order — a file straight out of an editor
 * usually has moov last, and QuickTime files put a `wide` box before `mdat`.
 */
async function locateTopLevel(file: File): Promise<Box[]> {
  const readAt = async (pos: number, len: number): Promise<Uint8Array> =>
    new Uint8Array(await file.slice(pos, Math.min(pos + len, file.size)).arrayBuffer());

  const out: Box[] = [];
  let p = 0;
  // A malformed file could otherwise loop; no real MP4 has thousands of
  // top-level boxes.
  let guard = 0;
  while (p + 8 <= file.size && guard++ < 4096) {
    const head = await readAt(p, 16);
    const h = readBoxHeader(head, p, file.size);
    if (!h || p + h.size > file.size) break;
    out.push(h);
    p += h.size;
  }
  return out;
}

interface VideoDescription {
  codec: string;
  profile: string;
  level: string;
  /** Coded frame size, from the sample entry. Null if it could not be read. */
  codedSize: { width: number; height: number } | null;
}

function describeVideo(moov: Uint8Array, videoTrak: Box): VideoDescription {
  const none: VideoDescription = { codec: 'unknown', profile: '', level: '', codedSize: null };

  const stsd = findPath(moov, ['mdia', 'minf', 'stbl', 'stsd'], videoTrak.pos + 8, videoTrak.pos + videoTrak.size);
  if (!stsd) return none;

  // stsd: version/flags(4) + entryCount(4), then the sample entries.
  const entries = children(moov, stsd.pos + 16, stsd.pos + stsd.size);
  const entry = entries[0];
  if (!entry) return none;

  /*
   * VisualSampleEntry: 8 bytes of SampleEntry, then pre_defined(2),
   * reserved(2), pre_defined[3](12), then width and height as uint16.
   */
  const codedSize = {
    width: u16(moov, entry.pos + 8 + 24),
    height: u16(moov, entry.pos + 8 + 26),
  };

  const codec = entry.type;
  // A visual sample entry is 78 bytes before its codec-specific child boxes.
  const configStart = entry.pos + 8 + 78;
  const configEnd = entry.pos + entry.size;

  const avcC = findBox(moov, 'avcC', configStart, configEnd);
  if (avcC) {
    const b = avcC.pos + 8;
    return {
      codec: 'H.264',
      profile: AVC_PROFILES[moov[b + 1]] ?? `profile ${moov[b + 1]}`,
      level: (moov[b + 3] / 10).toFixed(1),
      codedSize,
    };
  }

  const hvcC = findBox(moov, 'hvcC', configStart, configEnd);
  if (hvcC) {
    const b = hvcC.pos + 8;
    const profileIdc = moov[b + 1] & 0x1f;
    return {
      codec: 'HEVC',
      profile: HEVC_PROFILES[profileIdc] ?? `profile ${profileIdc}`,
      // general_level_idc is in units of 1/30th.
      level: (moov[b + 12] / 30).toFixed(1) + (moov[b + 1] & 0x20 ? ' High tier' : ''),
      codedSize,
    };
  }

  const av1C = findBox(moov, 'av1C', configStart, configEnd);
  if (av1C) {
    const idx = moov[av1C.pos + 8 + 1] & 0x1f;
    return { codec: 'AV1', profile: 'Main', level: `${2 + (idx >> 2)}.${idx & 3}`, codedSize };
  }

  return { codec, profile: '', level: '', codedSize };
}

/*
 * A File that reports 0 bytes is not always empty. Chrome hands one over for
 * a file that lives online-only (OneDrive, iCloud Drive, Google Drive
 * placeholders), for a file dragged out of a zip folder, and occasionally
 * for a Photos pick that has not finished exporting. Everything below reads
 * by `file.size`, so such a file would be refused as "not an MP4" for the
 * wrong reason. Read the bytes anyway; if the browser can produce them, use
 * them, and only if it truly has none say so in words that name the cause.
 */
async function materialise(file: File): Promise<File> {
  if (file.size > 0) return file;
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    bytes = new ArrayBuffer(0);
  }
  if (bytes.byteLength === 0) {
    throw new Mp4Error(
      'empty_file',
      'The browser handed over an empty file (0 bytes). If it is stored online-only '
      + '(OneDrive, iCloud Drive, Google Drive), open the folder and download it fully first, '
      + 'or pick it with the Choose file button instead of dragging.',
    );
  }
  return new File([bytes], file.name, { type: file.type, lastModified: file.lastModified });
}

export async function scanFile(input: File): Promise<ScanResult> {
  /* No size floor: any file that carries ftyp, moov and mdat is a video here,
   * however short. A file that does not is told so, not told it is "small". */
  const file = await materialise(input);

  const top = await locateTopLevel(file);
  const ftypBox = top.find((b) => b.type === 'ftyp');
  const moovBox = top.find((b) => b.type === 'moov');
  const mdatBox = top.find((b) => b.type === 'mdat');

  /* An MP4 header with no moov or mdat behind it is what a file looks like
   * while an editor or HandBrake is still writing it -- dropped a moment too
   * early. Say that, rather than calling a real video "not an MP4". */
  if (ftypBox && (!moovBox || !mdatBox)) {
    throw new Mp4Error(
      'unfinished',
      'This file looks unfinished. If it is still exporting, wait for the export to complete and drop it again.',
    );
  }
  if (!ftypBox || !moovBox || !mdatBox) {
    throw new Mp4Error(
      'not_mp4',
      'This does not look like an MP4. Export as .mp4 (H.264 or HEVC) and try again.',
    );
  }
  if (moovBox.size > MAX_MOOV_BYTES) {
    throw new Mp4Error(
      'moov_too_large',
      `This video's index is ${(moovBox.size / 1048576).toFixed(1)} MB, larger than we can process. ` +
        'That usually means a very long video — try a shorter clip.',
    );
  }

  const read = async (b: Box) => new Uint8Array(await file.slice(b.pos, b.pos + b.size).arrayBuffer());
  const ftyp = await read(ftypBox);
  const moov = await read(moovBox);

  const payloadStart = mdatBox.pos + mdatBox.headerLen;
  const payloadLen = mdatBox.size - mdatBox.headerLen;

  /* ---- video properties ------------------------------------------------ */

  const vTraks = videoTraks(moov);
  if (!vTraks.length) {
    throw new Mp4Error('no_video', 'This file has no video track.');
  }
  const vt = vTraks[0];

  const mdhd = findPath(moov, ['mdia', 'mdhd'], vt.pos + 8, vt.pos + vt.size);
  if (!mdhd) throw new Mp4Error('no_mdhd', 'This video is missing its track header.');
  const mdhdV1 = moov[mdhd.pos + 8] === 1;
  const timescale = mdhdV1 ? u32(moov, mdhd.pos + 8 + 20) : u32(moov, mdhd.pos + 8 + 12);
  const mediaDur = mdhdV1 ? u64(moov, mdhd.pos + 8 + 24) : u32(moov, mdhd.pos + 8 + 16);
  const durationSec = timescale > 0 ? mediaDur / timescale : 0;

  const stbl = findPath(moov, ['mdia', 'minf', 'stbl'], vt.pos + 8, vt.pos + vt.size);
  const stsz = stbl ? findBox(moov, 'stsz', stbl.pos + 8, stbl.pos + stbl.size) : null;
  const videoSamples = stsz ? parseStsz(moov, stsz).length : 0;

  /*
   * CODED dimensions, from the sample description — not tkhd.
   *
   * tkhd carries DISPLAY dimensions, which fold in the pixel aspect ratio. On a
   * file with non-square pixels the two genuinely disagree: one of our AV1
   * encodes has a sample aspect of 1214:1215, so tkhd reads 2158x3840 while the
   * frame is really 2160x3840. Both numbers are correct, but the coded size is
   * the one that matters here — it is what a platform's rendition ladder keys
   * on, and it is what the user means when they say "4K". Reporting 2158 would
   * read as a bug in our tool rather than a property of their file.
   */
  const { codec, profile, level, codedSize } = describeVideo(moov, vt);
  const width = codedSize?.width ?? 0;
  const height = codedSize?.height ?? 0;
  const audio = audioTraks(moov);

  return {
    descriptor: {
      ftypLen: ftyp.length,
      moovLen: moov.length,
      payloadStart,
      payloadLen,
    },
    moov,
    ftyp,

    file,
    fileName: file.name,
    fileSize: file.size,
    durationSec,
    bitrateMbps: durationSec > 0 ? (file.size * 8) / durationSec / 1e6 : 0,

    width,
    height,
    fps: durationSec > 0 ? videoSamples / durationSec : 0,
    videoSamples,
    codec,
    profile,
    level,

    audioTrackCount: audio.length,
    hasAudio: audio.length > 0,

    needsFaststart: moovBox.pos > mdatBox.pos,
  };
}

/**
 * Assemble the finished file from the user's own bytes plus what the patcher
 * returned.
 *
 * The media payload is passed through as a `Blob` slice of the original File,
 * which the browser keeps as a lazy reference rather than copying — measured at
 * 0 MB of JS heap growth on a 49.7 MB file. That is what lets a 500 MB video be
 * patched in a phone browser.
 */
export function assemble(
  original: File,
  ftyp: Uint8Array,
  patchedMoov: Uint8Array,
  mdatHeader: Uint8Array,
  payloadStart: number,
  payloadLen: number,
  fillerLen: number,
  fillerHead: Uint8Array = new Uint8Array(0),
): File {
  const parts: BlobPart[] = [
    ftyp as BlobPart,
    patchedMoov as BlobPart,
    mdatHeader as BlobPart,
    original.slice(payloadStart, payloadStart + payloadLen),
    fillerHead as BlobPart,
    new Uint8Array(Math.max(0, fillerLen - fillerHead.length)) as BlobPart,
  ];
  const base = original.name.replace(/\.[^.]+$/, '');
  return new File(parts, `${base}-pristine.mp4`, {
    type: 'video/mp4',
    lastModified: Date.now(),
  });
}
