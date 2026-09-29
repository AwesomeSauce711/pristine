import fs from 'node:fs';
import assert from 'node:assert/strict';
import { scanFile } from '../src/lib/mp4/scan';
import { prepareUpload } from '../src/lib/mp4/upload';
import { audioTraks, findPath, findBox, parseStsz, parseStts, offsetBoxes, offsetCount, readOffset } from '../src/lib/mp4/boxes';

for (const name of ['with-audio', 'no-audio']) {
  const source = new File([fs.readFileSync(`tests/fixtures/${name}.mp4`)], `${name}.mp4`);
  const scan = await scanFile(source);
  for (const mode of ['compatible', 'mobile'] as const) {
    if (name === 'with-audio' && mode === 'compatible') {
      assert.throws(() => prepareUpload(scan, mode), /stereo AAC-LC/); // fixture is mono
      continue;
    }
    const output = prepareUpload(scan, mode);
    const again = await scanFile(output);
    assert.equal(again.videoSamples, scan.videoSamples);
    assert.equal(again.width, scan.width);
    assert.equal(again.height, scan.height);
    assert.equal(again.audioTrackCount, 1);
    const before = new Uint8Array(await source.slice(scan.descriptor.payloadStart, scan.descriptor.payloadStart + scan.descriptor.payloadLen).arrayBuffer());
    const after = new Uint8Array(await output.slice(again.descriptor.payloadStart, again.descriptor.payloadStart + scan.descriptor.payloadLen).arrayBuffer());
    assert.deepEqual(after, before, 'original compressed media must remain byte-identical');
    const audio = audioTraks(again.moov)[0];
    const stbl = findPath(again.moov, ['mdia', 'minf', 'stbl'], audio.pos + 8, audio.pos + audio.size)!;
    const box = (type: string) => findBox(again.moov, type, stbl.pos + 8, stbl.pos + stbl.size)!;
    const sizes = parseStsz(again.moov, box('stsz'));
    const timing = parseStts(again.moov, box('stts'));
    assert.deepEqual(timing.at(-1), [sizes.length * .9, 1]);
    assert.ok(sizes.slice(sizes.length / 10).every(n => n === 8));
    for (const offsets of offsetBoxes(again.moov)) {
      for (let i = 0; i < offsetCount(again.moov, offsets); i++) {
        const at = readOffset(again.moov, offsets, i);
        assert.ok(at >= again.descriptor.payloadStart && at < output.size, 'chunk must point at media');
      }
    }
    const end = new Uint8Array(await output.slice(-8).arrayBuffer());
    assert.deepEqual([...end], mode === 'mobile' ? [0,0,0,4,0,0,0,0] : [33,16,4,96,140,28,0,0]);
    assert.throws(() => prepareUpload(again, mode), /already prepared/);
    console.log(`single audio: ${name}, ${mode}, original bytes preserved, offsets and extra packets checked`);
  }
}

const silent = await scanFile(new File([fs.readFileSync('tests/fixtures/no-audio.mp4')], 'silent.mp4'));
const duplicate = await scanFile(prepareUpload(silent, 'compatible', true));
assert.equal(duplicate.videoSamples, silent.videoSamples);
assert.equal(duplicate.audioTrackCount, 2);
assert.throws(() => prepareUpload(duplicate), /one AAC audio track/);
console.log('Separate-audio comparison preserves video count and prevents repeat preparation.');
const normalized = await scanFile(prepareUpload(silent, 'compatible', false, 30));
assert.equal(normalized.fps, 30);
assert.equal(normalized.videoSamples, silent.videoSamples);
assert.deepEqual(new Uint8Array(await normalized.file.slice(normalized.descriptor.payloadStart, normalized.descriptor.payloadStart + silent.descriptor.payloadLen).arrayBuffer()),
  new Uint8Array(await silent.file.slice(silent.descriptor.payloadStart, silent.descriptor.payloadStart + silent.descriptor.payloadLen).arrayBuffer()));
console.log('Encoded frame cadence stays exact without changing video packets.');
