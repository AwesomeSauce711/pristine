/*
 * patch-file.mts — patch one local file with the production patcher, without
 * loading it into memory: the index is read, the payload is streamed.
 *
 *   npx tsx --conditions=react-server scripts/patch-file.mts <in.mp4> <out.mp4>
 *
 * Exactly what the site does, on this machine: scan, build the new index,
 * write ftyp + index + mdat header + the untouched payload + the filler.
 */
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { scanFile } from '../src/lib/mp4/scan';
import { buildPatchedMoov } from '../src/lib/mp4/patch.server';

const [input, output] = process.argv.slice(2);
if (!input || !output) { console.error('usage: patch-file.mts <in.mp4> <out.mp4>'); process.exit(2); }

/* A file-backed Blob: slices read from disk on demand, nothing is loaded. */
const blob = await fs.openAsBlob(input);
const scan = await scanFile(blob as unknown as File);
const d = scan.descriptor;
const r = buildPatchedMoov({ moov: scan.moov, ftypLen: d.ftypLen, payloadStart: d.payloadStart, payloadLen: d.payloadLen });

const out = fs.createWriteStream(output);
const write = (bytes: Uint8Array) => new Promise<void>((res, rej) => out.write(bytes, (e) => (e ? rej(e) : res())));
await write(scan.ftyp);
await write(r.moov);
await write(r.mdatHeader);
await pipeline(fs.createReadStream(input, { start: d.payloadStart, end: d.payloadStart + d.payloadLen - 1 }), out, { end: false });
await write(r.fillerHead);
const zeros = r.fillerLen - r.fillerHead.length;
if (zeros > 0) await pipeline(Readable.from((function* () { let left = zeros; while (left > 0) { const n = Math.min(left, 1 << 20); yield new Uint8Array(n); left -= n; } })()), out, { end: false });
await new Promise<void>((res) => out.end(res));

const size = fs.statSync(output).size;
if (size !== r.outputLen) throw new Error(`wrote ${size} bytes, expected ${r.outputLen}`);
console.log(JSON.stringify({
  input, output, bytes: size, realSamples: r.realSamples, phantomSamples: r.phantomSamples,
  clonedTrack: r.clonedTrack, synthesisedAudio: r.synthesisedAudio, neutralisedEdts: r.neutralisedEdts,
}));
process.exit(0);
