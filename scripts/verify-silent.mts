/*
 * verify:silent — a file with NO audio track goes through the patcher and
 * comes out as a valid file with two AAC tracks: the silent one supplied for
 * it, and the decoy cloned from that. Uses a tiny generated test fixture.
 * If ffprobe is on the PATH the streams are checked with it as well.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanFile, assemble } from '../src/lib/mp4/scan';
import { buildPatchedMoov } from '../src/lib/mp4/patch';

const src = process.argv[2] ?? 'tests/fixtures/no-audio.mp4';
const bytes = fs.readFileSync(src);
const file = new File([bytes], path.basename(src), { type: 'video/mp4' });
const scan = await scanFile(file);
if (scan.hasAudio) throw new Error(`${src} has audio; this check needs a file without any`);

const d = scan.descriptor;
const r = buildPatchedMoov({ moov: scan.moov, ftypLen: d.ftypLen, payloadStart: d.payloadStart, payloadLen: d.payloadLen });
if (!r.synthesisedAudio) throw new Error('no silent track was supplied');
if (!r.clonedTrack) throw new Error('the silent track was not cloned into a decoy');
if (r.fillerHead.length === 0) throw new Error('the silent track has no samples');
if (r.fillerLen < r.fillerHead.length) throw new Error('filler shorter than its head');

const out = assemble(file, scan.ftyp, r.moov, r.mdatHeader, d.payloadStart, d.payloadLen, r.fillerLen, r.fillerHead);
const buf = Buffer.from(await out.arrayBuffer());
if (buf.length !== r.outputLen) throw new Error(`assembled ${buf.length} bytes, expected ${r.outputLen}`);

/* The payload is byte-identical and where the moov says it is. */
const payloadAt = d.ftypLen + r.moov.length + r.mdatHeader.length;
if (!buf.subarray(payloadAt, payloadAt + d.payloadLen).equals(bytes.subarray(d.payloadStart, d.payloadStart + d.payloadLen))) {
  throw new Error('payload bytes changed');
}
/* The silent samples follow the payload, then zeros. */
if (!buf.subarray(payloadAt + d.payloadLen, payloadAt + d.payloadLen + r.fillerHead.length).equals(Buffer.from(r.fillerHead))) {
  throw new Error('silent samples are not where the moov points');
}

/* The result scans again as a file with audio. */
const again = await scanFile(new File([buf], 'out.mp4', { type: 'video/mp4' }));
if (!again.hasAudio) throw new Error('the patched file does not scan as having audio');

let probed = 'ffprobe not on PATH; structure checked only';
const tmp = path.join(os.tmpdir(), `pristine-silent-${process.pid}.mp4`);
fs.writeFileSync(tmp, buf);
try {
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'csv=p=0', tmp], { encoding: 'utf8' });
  if (probe.status === 0) {
    const audio = probe.stdout.split(/\r?\n/).filter((l) => l.startsWith('aac,audio')).length;
    if (audio !== 2) throw new Error(`ffprobe sees ${audio} aac streams, expected 2\n${probe.stdout}`);
    const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', tmp, '-f', 'null', '-'], { encoding: 'utf8' });
    if (dec.status !== 0 || dec.stderr.trim()) throw new Error(`ffmpeg decode complained:\n${dec.stderr}`);
    probed = 'ffprobe: 2 aac streams, ffmpeg decodes clean';
  }
} finally {
  fs.rmSync(tmp, { force: true });
}
console.log(`verify:silent ok — ${r.realSamples} silent frames, ${r.phantomSamples} phantoms, ${buf.length} bytes; ${probed}`);
