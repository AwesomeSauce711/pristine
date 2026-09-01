/*
 * verify-port.ts — does the TypeScript port still produce the exact file
 * TikTok accepted?
 *
 * This is the anchor test for the whole product. `VAR_J_rein.mp4` is the upload
 * that came back videoQuality "original", byte-for-byte identical, with an
 * empty rendition ladder. If the port drifts by a single byte, the thing being
 * sold is no longer the thing that was measured.
 *
 * Run: npx tsx --conditions=react-server scripts/verify-port.ts
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { buildPatchedMoov } from '../src/lib/mp4/patch.server';
import { children, findBox, findPath, readBoxHeader, type Box } from '../src/lib/mp4/boxes';

const SRC = 'C:/Users/Sam/tiktok-hd/output/VAR_I_twoaudio.mp4';
const ACCEPTED = 'C:/Users/Sam/tiktok-hd/output/VAR_J_rein.mp4';
const SINGLE_AUDIO = 'C:/Users/Sam/tiktok-hd/work/t_vertical.mp4';

const sha = (b: Uint8Array) => createHash('sha256').update(Buffer.from(b)).digest('hex');

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? ' — ' + extra : ''));
  cond ? pass++ : fail++;
};

/** Locate ftyp/moov/mdat the same way the browser scanner does. */
function topLevel(bytes: Uint8Array): Box[] {
  const out: Box[] = [];
  let p = 0;
  while (p + 8 <= bytes.length) {
    const h = readBoxHeader(bytes.subarray(p, Math.min(p + 16, bytes.length)), p, bytes.length);
    if (!h || p + h.size > bytes.length) break;
    out.push(h);
    p += h.size;
  }
  return out;
}

/** Reassemble exactly as the client does, so we compare whole files. */
function patchWholeFile(bytes: Uint8Array, multiplier = 10) {
  const top = topLevel(bytes);
  const ftyp = top.find((b) => b.type === 'ftyp')!;
  const moovBox = top.find((b) => b.type === 'moov')!;
  const mdat = top.find((b) => b.type === 'mdat')!;

  const payloadStart = mdat.pos + mdat.headerLen;
  const payloadLen = mdat.size - mdat.headerLen;

  const r = buildPatchedMoov({
    moov: bytes.slice(moovBox.pos, moovBox.pos + moovBox.size),
    ftypLen: ftyp.size,
    payloadStart,
    payloadLen,
    multiplier,
    movedMoov: moovBox.pos > mdat.pos,
  });

  const out = new Uint8Array(r.outputLen);
  let o = 0;
  const put = (part: Uint8Array) => { out.set(part, o); o += part.length; };
  put(bytes.subarray(ftyp.pos, ftyp.pos + ftyp.size));
  put(r.moov);
  put(r.mdatHeader);
  put(bytes.subarray(payloadStart, payloadStart + payloadLen));
  o += r.fillerLen;   // zeros, already zero-filled

  return { bytes: out, result: r };
}

console.log('\nTypeScript port fidelity\n');

if (existsSync(SRC) && existsSync(ACCEPTED)) {
  const src = new Uint8Array(readFileSync(SRC));
  const want = new Uint8Array(readFileSync(ACCEPTED));
  const { bytes, result } = patchWholeFile(src, 10);

  ok('output length matches the accepted upload', bytes.length === want.length,
    `${bytes.length} vs ${want.length}`);
  ok('output is byte-for-byte the file TikTok accepted', sha(bytes) === sha(want),
    sha(bytes).slice(0, 16) + ' vs ' + sha(want).slice(0, 16));
  ok('reports the expected sample counts',
    result.realSamples === 470 && result.phantomSamples === 4230,
    `${result.realSamples} real + ${result.phantomSamples} phantom`);
  ok('did not need to clone (input already had two audio tracks)', result.clonedTrack === false);
} else {
  console.log('  skip  byte-equality anchor (fixtures not found)');
}

if (existsSync(SINGLE_AUDIO)) {
  const src = new Uint8Array(readFileSync(SINGLE_AUDIO));
  const { bytes, result } = patchWholeFile(src, 10);
  ok('clones a decoy from a single audio track', result.clonedTrack === true);
  ok('moves moov to the front when it was last', result.movedMoov === true);

  const kinds = children(bytes, 0, bytes.length).map((k) => k.type).join(' ');
  ok('output is faststart', kinds === 'ftyp moov mdat', kinds);

  // The media payload must survive the move untouched.
  const srcMdat = topLevel(src).find((b) => b.type === 'mdat')!;
  const outMdat = children(bytes, 0, bytes.length).find((k) => k.type === 'mdat')!;
  const a = Buffer.from(src.subarray(srcMdat.pos + srcMdat.headerLen, srcMdat.pos + srcMdat.size));
  const b = Buffer.from(bytes.subarray(outMdat.pos + 8, outMdat.pos + 8 + a.length));
  ok('media payload survives byte-for-byte', a.equals(b));

  ok('mdat grew by the filler alone (decoy shares chunks, costs no media bytes)',
    (outMdat.size - 8) - (srcMdat.size - srcMdat.headerLen) === result.fillerLen,
    `+${(outMdat.size - 8) - (srcMdat.size - srcMdat.headerLen)} bytes, filler ${result.fillerLen}`);
} else {
  console.log('  skip  clone/faststart checks (fixture not found)');
}

/* ---- hostile input ------------------------------------------------------ */

console.log('\n  hostile input');
{
  const refuses = (label: string, fn: () => unknown, want: string) => {
    const t0 = Date.now();
    let msg: string | null = null;
    try { fn(); } catch (e) { msg = (e as Error).message; }
    const ms = Date.now() - t0;
    ok(label, msg !== null && msg.includes(want) && ms < 250,
      (msg ?? 'did not throw').slice(0, 52) + ` [${ms}ms]`);
  };

  const src = existsSync(SRC) ? new Uint8Array(readFileSync(SRC)) : null;
  if (src) {
    const top = topLevel(src);
    const moovBox = top.find((b) => b.type === 'moov')!;
    const mdat = top.find((b) => b.type === 'mdat')!;
    const base = {
      ftypLen: top.find((b) => b.type === 'ftyp')!.size,
      payloadStart: mdat.pos + mdat.headerLen,
      payloadLen: mdat.size - mdat.headerLen,
    };
    const moov = () => src.slice(moovBox.pos, moovBox.pos + moovBox.size);

    refuses('rejects multiplier 1', () => buildPatchedMoov({ ...base, moov: moov(), multiplier: 1 }), 'between');
    refuses('rejects multiplier 999', () => buildPatchedMoov({ ...base, moov: moov(), multiplier: 999 }), 'between');
    refuses('rejects a fractional multiplier', () => buildPatchedMoov({ ...base, moov: moov(), multiplier: 2.5 }), 'whole number');

    // A crafted stsz claiming four billion samples must be refused instantly.
    const hostile = moov();
    const traks = children(hostile, 8, hostile.length).filter((k) => k.type === 'trak');
    const decoy = traks[traks.length - 1];
    const stbl = findPath(hostile, ['mdia', 'minf', 'stbl'], decoy.pos + 8, decoy.pos + decoy.size)!;
    const stsz = findBox(hostile, 'stsz', stbl.pos + 8, stbl.pos + stbl.size)!;
    for (let i = 16; i < 20; i++) hostile[stsz.pos + i] = 0xFF;
    refuses('rejects a stsz claiming 4.29 billion samples',
      () => buildPatchedMoov({ ...base, moov: hostile }), 'only holds');
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
