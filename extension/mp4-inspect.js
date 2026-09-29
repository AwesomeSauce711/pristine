'use strict';

// Reads metadata only from a bounded MP4 byte range. No video samples are decoded.
(function (root) {
  function inspectMp4Sample(input, fileBytes) {
    const b = input instanceof Uint8Array ? input : new Uint8Array(input);
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const u32 = (p) => p + 4 <= b.length ? view.getUint32(p) : 0;
    const u64 = (p) => Number(BigInt(u32(p)) * 4294967296n + BigInt(u32(p + 4)));
    const type = (p) => String.fromCharCode(...b.subarray(p, p + 4));
    function children(start, end) {
      const out = [];
      for (let p = start; p + 8 <= end;) {
        let size = u32(p), header = 8;
        if (size === 1) { size = u64(p + 8); header = 16; }
        else if (size === 0) size = end - p;
        if (!Number.isSafeInteger(size) || size < header || p + size > end) break;
        out.push({ type: type(p + 4), start: p, data: p + header, end: p + size });
        p += size;
      }
      return out;
    }
    const child = (box, name) => box && children(box.data, box.end).find(x => x.type === name);
    const path = (box, names) => names.reduce(child, box);
    let moov = children(0, b.length).find(x => x.type === 'moov');
    // A tail range can begin in mdat, so its top-level box boundaries are lost.
    if (!moov) {
      for (let p = 4; p + 4 <= b.length; p++) {
        if (type(p) !== 'moov') continue;
        const start = p - 4, size = u32(start);
        if (size >= 16 && start + size <= b.length) {
          const candidate = { type: 'moov', start, data: p + 4, end: start + size };
          if (child(candidate, 'trak')) { moov = candidate; break; }
        }
      }
    }
    if (!moov) return null;
    const movieHeader = child(moov, 'mvhd');
    const movieVersion = movieHeader && b[movieHeader.data];
    const movieDurationPosition = movieHeader && movieHeader.start + (movieVersion === 1 ? 32 : 24);
    const movieDurationUnknown = !!movieHeader && u32(movieDurationPosition) === 0xffffffff &&
      (movieVersion !== 1 || u32(movieDurationPosition + 4) === 0xffffffff);
    const tracks = children(moov.data, moov.end).filter(x => x.type === 'trak');
    const audio = [];
    for (const track of tracks) {
      const media = child(track, 'mdia'), handler = child(media, 'hdlr');
      if (!handler || type(handler.start + 16) !== 'soun') continue;
      const table = path(track, ['mdia', 'minf', 'stbl']);
      const desc = child(table, 'stsd');
      if (!desc) continue;
      const sample = desc.start + 16;
      if (sample + 36 > desc.end || u32(sample) < 36) continue;
      const timing = child(table, 'stts');
      let samples = 0, sampleTicks = 0, trailingSamples = 0, trailingSampleDelta = 0;
      if (timing) {
        const count = u32(timing.start + 12);
        if (count <= 100000 && timing.start + 16 + count * 8 <= timing.end) {
          for (let i = 0; i < count; i++) {
            const pos = timing.start + 16 + i * 8, n = u32(pos), delta = u32(pos + 4);
            samples += n; sampleTicks += n * delta;
            trailingSamples = n; trailingSampleDelta = delta;
          }
        }
      }
      const mdhd = child(media, 'mdhd');
      const version = mdhd && b[mdhd.data];
      const timescale = mdhd && u32(mdhd.start + (version === 1 ? 28 : 20));
      const ticks = mdhd && (version === 1 ? u64(mdhd.start + 32) : u32(mdhd.start + 24));
      const sizes = child(table, 'stsz');
      let tinySamples = 0;
      if (sizes) {
        const fixed = u32(sizes.start + 12), count = u32(sizes.start + 16);
        if (count <= 100000) {
          if (fixed) tinySamples = fixed <= 8 ? count : 0;
          else if (sizes.start + 20 + count * 4 <= sizes.end) {
            for (let i = 0; i < count; i++) if (u32(sizes.start + 20 + i * 4) <= 8) tinySamples++;
          }
        }
      }
      audio.push({ codec: type(sample + 4), channels: view.getUint16(sample + 24),
        sampleRate: u32(sample + 32) / 65536, samples,
        duration: timescale ? Math.round(ticks / timescale * 1000) / 1000 : null,
        tinySamples, trailingSamples, trailingSampleDelta,
        sampleTableDuration: timescale ? Math.round(sampleTicks / timescale * 1000) / 1000 : null });
    }
    for (const trak of tracks) {
      const mdia = child(trak, 'mdia'), hdlr = child(mdia, 'hdlr');
      if (!hdlr || type(hdlr.start + 16) !== 'vide') continue;
      const mdhd = child(mdia, 'mdhd');
      const stbl = path(trak, ['mdia', 'minf', 'stbl']);
      const stsd = child(stbl, 'stsd'), stts = child(stbl, 'stts');
      if (!mdhd || !stsd || !stts) continue;
      const version = b[mdhd.data];
      const timescale = u32(mdhd.start + (version === 1 ? 28 : 20));
      const ticks = version === 1 ? u64(mdhd.start + 32) : u32(mdhd.start + 24);
      const duration = timescale ? ticks / timescale : 0;
      const entry = stsd.start + 16;
      if (entry + 36 > stsd.end || u32(entry) < 36) continue;
      const codec = type(entry + 4);
      const width = view.getUint16(entry + 32), height = view.getUint16(entry + 34);
      const config = codec === 'avc1' || codec === 'avc3'
        ? children(entry + 86, Math.min(entry + u32(entry), stsd.end)).find(x => x.type === 'avcC') : null;
      const profileId = config && b[config.data + 1];
      let profile = { 66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High', 110: 'High 10', 122: 'High 4:2:2', 244: 'High 4:4:4' }[profileId] || null;
      let level = config ? b[config.data + 3] / 10 : null, tier = null;
      if (codec === 'hvc1' || codec === 'hev1') {
        const hevc = children(entry + 86, Math.min(entry + u32(entry), stsd.end)).find(x => x.type === 'hvcC');
        if (hevc && hevc.data + 13 <= hevc.end) {
          profile = { 1: 'Main', 2: 'Main 10', 3: 'Main Still Picture' }[b[hevc.data + 1] & 31] || null;
          level = b[hevc.data + 12] / 30;
          tier = b[hevc.data + 1] & 32 ? 'High' : 'Main';
        }
      }
      const sync = child(stbl, 'stss');
      const keyframes = sync ? u32(sync.start + 12) : null;
      let frames = 0, sampleTicks = 0, shortest = Infinity, longest = 0;
      const count = u32(stts.start + 12);
      if (count > 100000 || stts.start + 16 + count * 8 > stts.end) continue;
      for (let i = 0, p = stts.start + 16; i < count && p + 8 <= stts.end; i++, p += 8) {
        const n = u32(p), delta = u32(p + 4);
        frames += n; sampleTicks += n * delta;
        if (delta) { shortest = Math.min(shortest, delta); longest = Math.max(longest, delta); }
      }
      if (!width || !height || !frames || !sampleTicks || !timescale) continue;
      return {
        codec, profile, level, tier, width, height, frames, keyframes, audio, movieDurationUnknown,
        fps: Math.round(frames * timescale / sampleTicks * 1000) / 1000,
        variableFrameRate: shortest !== longest,
        duration: Math.round(duration * 1000) / 1000,
        containerMbps: fileBytes && duration ? Math.round(fileBytes * 8 / duration / 1e4) / 100 : null,
        source: 'MP4 sample table',
      };
    }
    return null;
  }
  root.inspectMp4Sample = inspectMp4Sample;
  if (typeof module !== 'undefined') module.exports = { inspectMp4Sample };
})(globalThis);
