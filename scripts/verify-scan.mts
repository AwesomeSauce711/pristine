/*
 * verify-scan.ts — does the browser-side scanner read real files correctly?
 *
 * scanFile() runs in the user's browser and everything they see on the analyse
 * screen comes from it, so a wrong reading here is a wrong claim shown to a
 * customer about their own file. Node 20+ implements File and Blob with the
 * same semantics the browser uses, including lazy slices, so the exact code
 * path can be exercised here.
 *
 * Run: npx tsx scripts/verify-scan.ts
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { scanFile } from '../src/lib/mp4/scan';

interface Expect {
  path: string;
  width: number;
  height: number;
  fps: number;
  codec: string;
  audio: number;
  faststart?: boolean;
}

const OUT = 'C:/Users/Sam/tiktok-hd/output/';
const WORK = 'C:/Users/Sam/tiktok-hd/work/';

const CASES: Expect[] = [
  { path: OUT + 'VAR_J_rein.mp4', width: 2160, height: 3840, fps: 60, codec: 'H.264', audio: 2 },
  { path: OUT + 'VAR_I_twoaudio.mp4', width: 2160, height: 3840, fps: 60, codec: 'H.264', audio: 2 },
  { path: OUT + 'VAR_M_hevc_4k120_main.mp4', width: 2160, height: 3840, fps: 120, codec: 'HEVC', audio: 2 },
  { path: OUT + 'VAR_N_1080p120.mp4', width: 1080, height: 1920, fps: 120, codec: 'H.264', audio: 1 },
  { path: OUT + 'AV1_4K60_63mbps.mp4', width: 2160, height: 3840, fps: 60, codec: 'AV1', audio: 1 },
  { path: WORK + 't_vertical.mp4', width: 1080, height: 1920, fps: 60, codec: 'H.264', audio: 1, faststart: false },
];

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? ' — ' + extra : ''));
  cond ? pass++ : fail++;
};

/** A File backed by real bytes, exactly as the browser would hand one over. */
const asFile = (path: string): File =>
  new File([readFileSync(path)], basename(path), { type: 'video/mp4' });

console.log('\nbrowser scanner against real files\n');

for (const c of CASES) {
  if (!existsSync(c.path)) {
    console.log(`  skip  ${basename(c.path)} (absent)`);
    continue;
  }

  const t0 = Date.now();
  const r = await scanFile(asFile(c.path));
  const ms = Date.now() - t0;
  const label = basename(c.path);

  const sizeMB = statSync(c.path).size / 1048576;
  ok(`${label}: dimensions`, r.width === c.width && r.height === c.height,
    `${r.width}×${r.height}`);
  ok(`${label}: frame rate`, Math.abs(r.fps - c.fps) < 0.5, `${r.fps.toFixed(2)} fps`);
  ok(`${label}: codec`, r.codec === c.codec, `${r.codec} ${r.profile} L${r.level}`);
  ok(`${label}: audio tracks`, r.audioTrackCount === c.audio, String(r.audioTrackCount));
  if (c.faststart === false) {
    ok(`${label}: detects moov after mdat`, r.needsFaststart === true);
  }

  /*
   * The claim that makes the whole architecture work: only the index is read.
   * If this ever regresses to reading the media, a phone browser will run out
   * of memory on a large file and the privacy claim stops being true.
   */
  ok(`${label}: reads only the index`,
    r.descriptor.moovLen < sizeMB * 1048576 * 0.02,
    `${(r.descriptor.moovLen / 1024).toFixed(0)} KB of ${sizeMB.toFixed(0)} MB ` +
    `(${((r.descriptor.moovLen / (sizeMB * 1048576)) * 100).toFixed(3)}%) in ${ms}ms`);
}

/* ---- refusals ----------------------------------------------------------- */

console.log('\n  refusals');
{
  const refuses = async (label: string, f: File, want: string) => {
    let msg: string | null = null;
    try { await scanFile(f); } catch (e) { msg = (e as Error).message; }
    ok(label, msg !== null && msg.includes(want), msg ?? 'did not throw');
  };

  await refuses('a text file', new File([new TextEncoder().encode('not a video at all')], 'x.mp4'), 'does not look like an MP4');
  await refuses('a genuinely empty file', new File([], 'x.mp4'), 'empty file');
  /* ftyp alone: what a file looks like mid-export. */
  await refuses('an unfinished export', new File([new Uint8Array([0,0,0,32, 0x66,0x74,0x79,0x70, 0x69,0x73,0x6f,0x6d, 0,0,2,0, 0x69,0x73,0x6f,0x6d,0x69,0x73,0x6f,0x32,0x61,0x76,0x63,0x31,0x6d,0x70,0x34,0x31])], 'x.mp4'), 'unfinished');
  await refuses('random bytes', new File([new Uint8Array(4096)], 'x.mp4'), 'does not look like an MP4');
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
