/*
 * boxes.ts — generic ISO-BMFF (MP4) box reading.
 *
 * Deliberately contains nothing proprietary. This is the half of the MP4 code
 * that ships to the browser: walking the box tree, reading sample tables, and
 * identifying tracks. It is the same work any MP4 inspector does.
 *
 * The patch itself — what gets changed and by how much — lives in
 * `src/lib/mp4/patch.ts`, which is server-only and never bundled for the client.
 * See `src/lib/mp4/README.md` for why the split is drawn here.
 *
 * SECURITY: every count in a sample table is read straight out of the file and
 * is therefore attacker-controlled. Reading a u32 past the end of the buffer
 * returns 0 rather than throwing, so an unbounded loop spins instead of
 * failing, and `new Array(count)` on a 32-bit count allocates four billion
 * elements from a twenty-byte box. Every count below is checked against the
 * space its own box actually has before anything is allocated. A table that
 * does not fit inside its box is malformed by definition, so this rejects
 * nothing valid.
 */

export class Mp4Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'Mp4Error';
    this.code = code;
  }
}

export interface Box {
  type: string;
  pos: number;
  size: number;
  headerLen: number;
}

/** Largest table we will parse at all, before any per-box bound is applied. */
export const MAX_TABLE_ENTRIES = 1_000_000;

/* ----------------------------------------------------------- byte helpers */

export const u32 = (b: Uint8Array, p: number): number =>
  ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;

export const u16 = (b: Uint8Array, p: number): number => ((b[p] << 8) | b[p + 1]) >>> 0;

/**
 * A 64-bit big-endian value as a JS number.
 *
 * Throws above 2^53 rather than returning a silently rounded offset — a wrong
 * chunk offset produces a file that plays garbage, which is far worse than a
 * clear refusal.
 */
export function u64(b: Uint8Array, p: number): number {
  const v = u32(b, p) * 4294967296 + u32(b, p + 4);
  if (!Number.isSafeInteger(v)) {
    throw new Mp4Error('u64_unsafe', 'This file uses 64-bit values too large to handle exactly.');
  }
  return v;
}

export function putU32(b: Uint8Array, p: number, v: number): void {
  b[p] = (v >>> 24) & 255;
  b[p + 1] = (v >>> 16) & 255;
  b[p + 2] = (v >>> 8) & 255;
  b[p + 3] = v & 255;
}

export function putU64(b: Uint8Array, p: number, v: number): void {
  putU32(b, p, Math.floor(v / 4294967296));
  putU32(b, p + 4, v >>> 0);
}

export const be32 = (n: number): Uint8Array => {
  const a = new Uint8Array(4);
  putU32(a, 0, n);
  return a;
};

export const ascii = (s: string): Uint8Array => {
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 255;
  return a;
};

export function cat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const fourcc = (b: Uint8Array, p: number): string =>
  String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

/** A box's four-character type sits at +4 from the box start, not +8. */
export const boxType = (b: Uint8Array, p: number): string => fourcc(b, p + 4);

export const buildBox = (type: string, content: Uint8Array): Uint8Array =>
  cat([be32(8 + content.length), ascii(type), content]);

/* ------------------------------------------------------------ box walking */

export const CONTAINERS = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta', 'dinf',
]);

/**
 * Direct children of a container.
 *
 * Tolerant of a malformed tail: the walk stops rather than throwing, because a
 * file with trailing junk after a valid moov is still patchable and refusing it
 * would be worse than ignoring the junk.
 */
export function children(b: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    const size = u32(b, p);
    if (size < 8 || p + size > end) break;
    out.push({ type: boxType(b, p), pos: p, size, headerLen: 8 });
    p += size;
  }
  return out;
}

export const findBox = (b: Uint8Array, type: string, s: number, e: number): Box | null =>
  children(b, s, e).find((k) => k.type === type) ?? null;

export function findPath(b: Uint8Array, path: string[], s: number, e: number): Box | null {
  let cs = s;
  let ce = e;
  let box: Box | null = null;
  for (const t of path) {
    box = findBox(b, t, cs, ce);
    if (!box) return null;
    cs = box.pos + 8;
    ce = box.pos + box.size;
  }
  return box;
}

/**
 * A top-level box header, handling both extended-size forms.
 *
 * `size === 1` means the real size is a 64-bit value after the type;
 * `size === 0` means the box runs to the end of the file.
 */
export function readBoxHeader(head: Uint8Array, pos: number, fileLen: number): Box | null {
  if (pos + 8 > fileLen) return null;
  let size = u32(head, 0);
  const type = fourcc(head, 4);
  let headerLen = 8;
  if (size === 1) {
    if (pos + 16 > fileLen) return null;
    size = u64(head, 8);
    headerLen = 16;
  } else if (size === 0) {
    size = fileLen - pos;
  }
  if (size < headerLen) return null;
  return { type, pos, size, headerLen };
}

/* --------------------------------------------------------- sample tables */

/** Reads a table's entry count, bounded by the space its own box has. */
export function boundedCount(
  b: Uint8Array, box: Box, headerLen: number, entryLen: number, what: string,
): number {
  const n = u32(b, box.pos + 12);
  if (headerLen + n * entryLen > box.size) {
    throw new Mp4Error(
      'bad_table',
      `${what} declares ${n} entries but its box only holds ` +
        `${Math.max(0, Math.floor((box.size - headerLen) / entryLen))}.`,
    );
  }
  if (n > MAX_TABLE_ENTRIES) {
    throw new Mp4Error('table_too_large', `${what} declares ${n} entries; the limit is ${MAX_TABLE_ENTRIES}.`);
  }
  return n;
}

export type SttsEntry = [count: number, delta: number];
export type StscEntry = [firstChunk: number, samplesPerChunk: number, descIndex: number];

export function parseStts(b: Uint8Array, box: Box): SttsEntry[] {
  const n = boundedCount(b, box, 16, 8, 'stts');
  const out: SttsEntry[] = [];
  for (let i = 0; i < n; i++) {
    out.push([u32(b, box.pos + 16 + i * 8), u32(b, box.pos + 20 + i * 8)]);
  }
  return out;
}

/**
 * stsz carries either one uniform size or a full table; expanded to a table
 * here so per-sample sizes can differ. The uniform form carries no table, so
 * the box size cannot bound it — that case needs the explicit ceiling, and it
 * is the cheapest version of the attack to write.
 */
export function parseStsz(b: Uint8Array, box: Box): number[] {
  const uniform = u32(b, box.pos + 12);
  const count = u32(b, box.pos + 16);
  if (uniform !== 0) {
    if (count > MAX_TABLE_ENTRIES) {
      throw new Mp4Error('table_too_large', `stsz declares ${count} samples; the limit is ${MAX_TABLE_ENTRIES}.`);
    }
    return new Array(count).fill(uniform);
  }
  if (20 + count * 4 > box.size) {
    throw new Mp4Error(
      'bad_table',
      `stsz declares ${count} samples but its box only holds ${Math.max(0, Math.floor((box.size - 20) / 4))}.`,
    );
  }
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) out[i] = u32(b, box.pos + 20 + i * 4);
  return out;
}

export function parseStsc(b: Uint8Array, box: Box): StscEntry[] {
  const n = boundedCount(b, box, 16, 12, 'stsc');
  const out: StscEntry[] = [];
  for (let i = 0; i < n; i++) {
    out.push([
      u32(b, box.pos + 16 + i * 12),
      u32(b, box.pos + 20 + i * 12),
      u32(b, box.pos + 24 + i * 12),
    ]);
  }
  return out;
}

/* ---------------------------------------------------------- chunk offsets */

export function offsetBoxes(moov: Uint8Array): Box[] {
  const found: Box[] = [];
  const walk = (s: number, e: number) => {
    for (const k of children(moov, s, e)) {
      if (k.type === 'stco' || k.type === 'co64') found.push(k);
      else if (CONTAINERS.has(k.type)) walk(k.pos + 8, k.pos + k.size);
    }
  };
  walk(8, moov.length);
  return found;
}

export const offsetCount = (moov: Uint8Array, box: Box): number =>
  boundedCount(moov, box, 16, box.type === 'co64' ? 8 : 4, box.type);

export const readOffset = (moov: Uint8Array, box: Box, i: number): number =>
  box.type === 'co64' ? u64(moov, box.pos + 16 + i * 8) : u32(moov, box.pos + 16 + i * 4);

export const writeOffset = (moov: Uint8Array, box: Box, i: number, v: number): void => {
  if (box.type === 'co64') putU64(moov, box.pos + 16 + i * 8, v);
  else putU32(moov, box.pos + 16 + i * 4, v);
};

/* ---------------------------------------------------------------- tracks */

export const trakHandler = (b: Uint8Array, t: Box): string => {
  const h = findPath(b, ['mdia', 'hdlr'], t.pos + 8, t.pos + t.size);
  return h ? fourcc(b, h.pos + 16) : '';
};

export const traksOf = (moov: Uint8Array): Box[] =>
  children(moov, 8, moov.length).filter((k) => k.type === 'trak');

export const audioTraks = (moov: Uint8Array): Box[] =>
  traksOf(moov).filter((t) => trakHandler(moov, t) === 'soun');

export const videoTraks = (moov: Uint8Array): Box[] =>
  traksOf(moov).filter((t) => trakHandler(moov, t) === 'vide');

/*
 * tkhd and mvhd place their identifiers at different offsets depending on the
 * box version. Getting this wrong writes a track_ID into a timestamp, so both
 * are version-checked rather than assumed.
 */
export const trackIdOffset = (b: Uint8Array, tk: Box): number =>
  tk.pos + 8 + (b[tk.pos + 8] === 1 ? 20 : 12);

export const nextTrackIdOffset = (b: Uint8Array, mvhd: Box): number =>
  mvhd.pos + 8 + (b[mvhd.pos + 8] === 1 ? 108 : 96);
