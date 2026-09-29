// Controlled local experiments. These are not the site's default.
import fs from 'node:fs';
import { scanFile, assemble } from '../src/lib/mp4/scan';
import { prepareUpload } from '../src/lib/mp4/upload';
import { buildPatchedMoov } from '../src/lib/mp4/patch';
import { children, findBox, putU64, u32 } from '../src/lib/mp4/boxes';
const [source, prefix] = process.argv.slice(2);
const original = new File([fs.readFileSync(source)], 'source.mp4');
const scan = await scanFile(original);
const single = prepareUpload(scan, 'compatible');
const bytes = new Uint8Array(await single.arrayBuffer());
const moov = children(bytes, 0, bytes.length).find(x => x.type === 'moov')!;
const movie = findBox(bytes, 'mvhd', moov.pos + 8, moov.pos + moov.size)!;
putU64(bytes, movie.pos + 32, Math.ceil(scan.durationSec * u32(bytes, movie.pos + 28)));
fs.writeFileSync(prefix + '_finite_single.mp4', bytes);
const d = scan.descriptor;
const duplicate = buildPatchedMoov({ moov: scan.moov, ftypLen:d.ftypLen,payloadStart:d.payloadStart,payloadLen:d.payloadLen });
const two = assemble(original,scan.ftyp,duplicate.moov,duplicate.mdatHeader,d.payloadStart,d.payloadLen,duplicate.fillerLen,duplicate.fillerHead);
const double = new Uint8Array(await two.arrayBuffer());
const m = children(double,0,double.length).find(x=>x.type==='moov')!;
const mv = findBox(double,'mvhd',m.pos+8,m.pos+m.size)!;
// Paired test: old duplicate audio layout, only movie duration made unspecified.
double.fill(255,mv.pos+24,mv.pos+28);
fs.writeFileSync(prefix + '_duplicate_unknown.mp4',double);
console.log('Wrote finite single-audio and duplicate-audio comparison files; video frames unchanged.');
