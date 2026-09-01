/*
 * verify-elst.mts — the second anchor.
 *
 * verify-port.ts pins the patch against VAR_J_rein.mp4, a source that carries no
 * edit list. That file cannot detect an elst bug, and an elst bug is exactly what
 * shipped: a decoy that inherits its source's edit list has its phantom ticks
 * clamped back out of the presented timeline, and TikTok re-encodes the upload.
 *
 * proven4krpo-NOELST.mp4 is the counterpart: HandBrake output, elst on both
 * traks, patched with the decoy's edts neutralised — uploaded and confirmed
 * served back at 4K60. Both implementations must reproduce it byte for byte.
 *
 * Run: npx tsx --conditions=react-server scripts/verify-elst.mts
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { buildPatchedMoov } from '../src/lib/mp4/patch.server';
import { type Box, readBoxHeader } from '../src/lib/mp4/boxes';

const SRC = 'C:/Users/Sam/Downloads/proven4krpo.mp4';
const GOLD = 'C:/Users/Sam/Downloads/proven4krpo-NOELST.mp4';
const EXT = 'C:/Users/Sam/tiktok-hd/extension/mp4patch.js';

if (!existsSync(SRC) || !existsSync(GOLD)) {
  console.log('  skipped — reference files not on this machine');
  process.exit(0);
}

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

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const bytes = readFileSync(SRC);

const top = topLevel(bytes);
const ftyp = top.find((b) => b.type === 'ftyp')!;
const moovBox = top.find((b) => b.type === 'moov')!;
const mdat = top.find((b) => b.type === 'mdat')!;
const payloadStart = mdat.pos + mdat.headerLen;
const payloadLen = mdat.size - mdat.headerLen;

const r = buildPatchedMoov({
  moov: bytes.slice(moovBox.pos, moovBox.pos + moovBox.size),
  ftypLen: ftyp.size, payloadStart, payloadLen, multiplier: 10,
  movedMoov: moovBox.pos > mdat.pos,
});
const web = new Uint8Array(r.outputLen);
let o = 0;
const put = (p: Uint8Array) => { web.set(p, o); o += p.length; };
put(bytes.subarray(ftyp.pos, ftyp.pos + ftyp.size));
put(r.moov); put(r.mdatHeader);
put(bytes.subarray(payloadStart, payloadStart + payloadLen));

const ext = createRequire(import.meta.url)(EXT);
const e = ext.patchBytes(new Uint8Array(bytes), { multiplier: 10 });

const gold = readFileSync(GOLD);
const gh = sha(gold);
let failed = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} — ${detail}`);
  if (!ok) failed++;
};

console.log('\nedit-list handling\n');
check('website reproduces the accepted upload', sha(web) === gh, `${sha(web).slice(0, 16)} vs ${gh.slice(0, 16)}`);
check('extension reproduces the accepted upload', sha(e.bytes) === gh, `${sha(e.bytes).slice(0, 16)} vs ${gh.slice(0, 16)}`);
check('same length as the accepted upload', web.length === gold.length, `${web.length} vs ${gold.length}`);
check('website and extension agree', sha(web) === sha(e.bytes), 'byte-identical');
check('website reports the edit list was neutralised', r.neutralisedEdts === true, `neutralisedEdts=${r.neutralisedEdts}`);
check('extension reports the edit list was neutralised', e.neutralisedEdts === true, `neutralisedEdts=${e.neutralisedEdts}`);
check('a decoy had to be cloned from the single audio track', r.clonedTrack === true, `cloned=${r.clonedTrack}`);
check('sample counts match', r.realSamples === 1359 && r.phantomSamples === 12231, `${r.realSamples} real + ${r.phantomSamples} phantom`);

console.log(`\n  ${8 - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
