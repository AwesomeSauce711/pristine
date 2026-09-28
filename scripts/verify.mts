import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { buildPatchedMoov } from '../src/lib/mp4/patch';
import { assemble, scanFile } from '../src/lib/mp4/scan';

for (const name of ['with-audio', 'no-audio']) {
  const source = readFileSync(`tests/fixtures/${name}.mp4`);
  const original = new File([source], `${name}.mp4`, { type: 'video/mp4' });
  const scan = await scanFile(original);
  assert.equal(scan.width, 64);
  assert.equal(scan.height, 64);
  assert.equal(Math.round(scan.fps), 30);
  assert.equal(scan.hasAudio, name === 'with-audio');

  const patched = buildPatchedMoov({
    moov: scan.moov,
    ftypLen: scan.descriptor.ftypLen,
    payloadStart: scan.descriptor.payloadStart,
    payloadLen: scan.descriptor.payloadLen,
    movedMoov: scan.needsFaststart,
  });
  assert.ok(patched.phantomSamples > patched.realSamples);
  assert.equal(patched.synthesisedAudio, name === 'no-audio');
  const output = assemble(
    scan.file, scan.ftyp, patched.moov, patched.mdatHeader,
    scan.descriptor.payloadStart, scan.descriptor.payloadLen,
    patched.fillerLen, patched.fillerHead,
  );
  assert.equal(output.size, patched.outputLen);
  const result = new Uint8Array(await output.arrayBuffer());
  const payloadAt = scan.ftyp.length + patched.moov.length + patched.mdatHeader.length;
  assert.deepEqual(
    result.subarray(payloadAt, payloadAt + scan.descriptor.payloadLen),
    new Uint8Array(source.subarray(scan.descriptor.payloadStart, scan.descriptor.payloadStart + scan.descriptor.payloadLen)),
  );
  const again = await scanFile(output);
  assert.ok(again.hasAudio);
  console.log(`${name}: scanned, patched, and preserved video data`);
}

assert.rejects(
  () => scanFile(new File(['not a video'], 'bad.mp4', { type: 'video/mp4' })),
  (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'not_mp4',
);
