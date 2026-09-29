import { scanFile } from './scan';
import { prepareUpload } from './upload';
import { audioTraks, findPath, parseStsz, parseStts } from './boxes';

export async function patchFile(file: File, options: { mobile?: boolean; separateAudio?: boolean; auto?: boolean } = {}) {
  const scan = await scanFile(file);
  const audio = audioTraks(scan.moov)[0];
  const sizesBox = audio && findPath(scan.moov, ['mdia', 'minf', 'stbl', 'stsz'], audio.pos + 8, audio.pos + audio.size);
  const timingBox = audio && findPath(scan.moov, ['mdia', 'minf', 'stbl', 'stts'], audio.pos + 8, audio.pos + audio.size);
  const tail = timingBox && parseStts(scan.moov, timingBox).at(-1);
  if (scan.audioTrackCount === 1 && tail?.[1] === 1 && tail[0] > 100) {
    return { file, alreadyPrepared: true, real: 0, phantom: 0, clonedTrack: false, movedMoov: false };
  }
  const real = sizesBox ? parseStsz(scan.moov, sizesBox).length : 0;
  const fourK120 = Math.min(scan.width, scan.height) >= 2160 && scan.fps > 100;
  if (options.auto && fourK120 && scan.codec !== 'HEVC') throw Error('For the 4K/120 preset, export using HEVC (H.265) first.');
  const separate = options.auto ? !fourK120 : !!options.separateAudio;
  return { file: prepareUpload(scan, options.mobile ? 'mobile' : 'compatible', separate),
    real, phantom: real * 9, clonedTrack: separate, movedMoov: scan.needsFaststart };
}
