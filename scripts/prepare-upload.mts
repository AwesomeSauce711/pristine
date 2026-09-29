import fs from 'node:fs';
import path from 'node:path';
import { scanFile } from '../src/lib/mp4/scan';
import { prepareUpload } from '../src/lib/mp4/upload';

const [source, destination, mode = 'compatible', layout] = process.argv.slice(2);
if (!source || !destination || !['compatible', 'mobile'].includes(mode)) {
  throw new Error('Usage: tsx scripts/prepare-upload.mts input.mp4 output.mp4 [compatible|mobile]');
}
const scan = await scanFile(new File([fs.readFileSync(source)], path.basename(source)));
const output = prepareUpload(scan, mode as 'compatible' | 'mobile', layout === 'duplicate');
fs.writeFileSync(destination, new Uint8Array(await output.arrayBuffer()));
const result = await scanFile(output);
console.log(JSON.stringify({ destination, bytes: output.size, width: result.width, height: result.height,
  fps: result.fps, frames: result.videoSamples, audioTracks: result.audioTrackCount, mode }));
