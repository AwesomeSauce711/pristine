'use strict';
/*
 * mp4patch.js — the phantom-sample patch, in pure JavaScript, for the browser.
 *
 * This is what makes TikTok serve an upload untouched: a decoy audio track
 * declaring roughly ten times as many samples as it really has. See
 * docs/phantom-sample-method.md for the method and the paired-control evidence.
 *
 * WHY THIS EXISTS SEPARATELY FROM tiktok-pro/phantom.js
 * phantom.js is the Node implementation and it needs ffmpeg twice: once to
 * duplicate the audio track that becomes the decoy, and once to move moov to
 * the front. Neither is available in a page. This file does both in JS, which
 * means the extension can patch a file the moment it is dropped, with no local
 * server, no transcode, and no upload to anywhere.
 *
 * THE TWO THINGS THAT MAKE THAT POSSIBLE
 *
 * 1. A cloned trak may share the original's chunk offsets. stco holds absolute
 *    file offsets and nothing forbids two tracks pointing at the same bytes, so
 *    the decoy costs no media data at all — verified by cloning an audio track
 *    with shared offsets and decoding both: byte-identical PCM out of each.
 *
 * 2. Moving moov to the front is the same offset arithmetic the patch already
 *    does. Every chunk offset shifts by one number.
 *
 * MEMORY
 * The mdat payload is the whole file, and it is copied UNCHANGED. So it is
 * never read into JS memory: the output File is assembled from a Blob slice of
 * the input, which Chrome keeps as a lazy reference to the original bytes.
 * Patching a 500 MB file allocates only the moov.
 *
 * Loads in a page as window.__tthdMp4Patch, and in Node as a normal module so
 * the same code is what the tests exercise.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.__tthdMp4Patch = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  /* ------------------------------------------------------------ byte helpers */

  const u32 = (b, p) => ((b[p] << 24 | b[p + 1] << 16 | b[p + 2] << 8 | b[p + 3]) >>> 0);
  const u16 = (b, p) => ((b[p] << 8 | b[p + 1]) >>> 0);

  /* Reads a 64-bit big-endian value as a JS number. Safe below 2^53, which is
   * far above any file this will ever see; beyond that we would be lying, so it
   * throws rather than returning a rounded offset. */
  function u64(b, p) {
    const hi = u32(b, p), lo = u32(b, p + 4);
    const v = hi * 4294967296 + lo;
    if (!Number.isSafeInteger(v)) throw new PatchError('64-bit value too large to represent exactly');
    return v;
  }

  function putU32(b, p, v) {
    b[p] = (v >>> 24) & 255; b[p + 1] = (v >>> 16) & 255;
    b[p + 2] = (v >>> 8) & 255; b[p + 3] = v & 255;
  }
  function putU64(b, p, v) {
    const hi = Math.floor(v / 4294967296), lo = v >>> 0;
    putU32(b, p, hi); putU32(b, p + 4, lo);
  }

  const be32 = (n) => { const a = new Uint8Array(4); putU32(a, 0, n); return a; };
  const ascii = (s) => { const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 255; return a; };

  function cat(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  const fourcc = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
  /* A box's four-character type sits at +4 from the box start, not +8. */
  const boxType = (b, p) => fourcc(b, p + 4);

  const buildBox = (type, content) => cat([be32(8 + content.length), ascii(type), content]);

  /** Thrown with a message meant to be shown to a user as-is. */
  class PatchError extends Error {}

  /* ------------------------------------------------------------ box walking */

  const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta', 'dinf']);

  /**
   * Direct children of a container, by walking size headers.
   *
   * Deliberately tolerant: a malformed tail stops the walk rather than throwing,
   * because a file with trailing junk after a valid moov is still patchable and
   * refusing it would be worse than ignoring the junk.
   */
  function children(b, s, e) {
    const out = [];
    let p = s;
    while (p + 8 <= e) {
      const size = u32(b, p);
      if (size < 8 || p + size > e) break;
      out.push({ type: boxType(b, p), pos: p, size });
      p += size;
    }
    return out;
  }

  const findBox = (b, type, s, e) => children(b, s, e).find((k) => k.type === type) || null;

  function findPath(b, path, s, e) {
    let cs = s, ce = e, box = null;
    for (const t of path) {
      box = findBox(b, t, cs, ce);
      if (!box) return null;
      cs = box.pos + 8; ce = box.pos + box.size;
    }
    return box;
  }

  /* ------------------------------------------------------- sample tables */

  /*
   * SAMPLE COUNTS ARE ATTACKER-CONTROLLED. Read them defensively.
   *
   * Every count below comes straight out of the file. A 20-byte stsz claiming
   * 4,294,967,295 samples would otherwise allocate a four-billion-element array
   * from a request that costs nothing to send, and u32() past the end of the
   * buffer returns 0 rather than throwing, so the loops spin instead of
   * failing. In a tab patching its own file that is a self-inflicted crash; on
   * a server it is a one-request denial of service for every other user.
   *
   * So each count is checked against the space its own box actually has before
   * anything is allocated. A table that does not fit in its box is malformed by
   * definition, so this rejects nothing valid.
   */
  const MAX_SAMPLES = 1000000;

  function boundedCount(b, box, headerLen, entryLen, what) {
    const n = u32(b, box.pos + 12);
    if (headerLen + n * entryLen > box.size) {
      throw new PatchError(what + ' declares ' + n + ' entries but its box only holds ' +
        Math.max(0, Math.floor((box.size - headerLen) / entryLen)));
    }
    return n;
  }

  function parseStts(b, box) {
    const n = boundedCount(b, box, 16, 8, 'stts');
    const out = [];
    for (let i = 0; i < n; i++) out.push([u32(b, box.pos + 16 + i * 8), u32(b, box.pos + 20 + i * 8)]);
    return out;
  }
  const buildStts = (e) =>
    buildBox('stts', cat([be32(0), be32(e.length), cat(e.map(([c, d]) => cat([be32(c), be32(d)])))]));

  /* stsz carries either a single uniform size or a table; expanded to a table
   * here so the phantom sizes can differ from the real ones. buildStsz always
   * writes the table form, so the round trip is lossless either way. */
  function parseStsz(b, box) {
    const uniform = u32(b, box.pos + 12);
    const count = u32(b, box.pos + 16);
    /*
     * The uniform form carries no table, so the box size cannot bound the
     * count — this is the one case that needs an explicit ceiling, and it is
     * the cheapest version of the attack to write.
     */
    if (uniform !== 0) {
      if (count > MAX_SAMPLES) {
        throw new PatchError('stsz declares ' + count + ' samples; the limit is ' + MAX_SAMPLES);
      }
      return new Array(count).fill(uniform);
    }
    if (20 + count * 4 > box.size) {
      throw new PatchError('stsz declares ' + count + ' samples but its box only holds ' +
        Math.max(0, Math.floor((box.size - 20) / 4)));
    }
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = u32(b, box.pos + 20 + i * 4);
    return out;
  }
  function buildStsz(sizes) {
    const body = new Uint8Array(sizes.length * 4);
    for (let i = 0; i < sizes.length; i++) putU32(body, i * 4, sizes[i]);
    return buildBox('stsz', cat([be32(0), be32(0), be32(sizes.length), body]));
  }

  function parseStsc(b, box) {
    const n = boundedCount(b, box, 16, 12, 'stsc');
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push([u32(b, box.pos + 16 + i * 12), u32(b, box.pos + 20 + i * 12), u32(b, box.pos + 24 + i * 12)]);
    }
    return out;
  }
  const buildStsc = (e) =>
    buildBox('stsc', cat([be32(0), be32(e.length), cat(e.map((x) => cat([be32(x[0]), be32(x[1]), be32(x[2])])))]));

  /* ------------------------------------------------------------ chunk offsets */

  /**
   * Every chunk-offset box in a moov, whichever width it uses.
   *
   * Returned as descriptors rather than values because the patch has to REWRITE
   * these in place after the layout is known, and the two box types need
   * different writers.
   */
  function offsetBoxes(moov) {
    const found = [];
    const walk = (s, e) => {
      for (const k of children(moov, s, e)) {
        if (k.type === 'stco' || k.type === 'co64') found.push(k);
        else if (CONTAINERS.has(k.type)) walk(k.pos + 8, k.pos + k.size);
      }
    };
    walk(8, moov.length);
    return found;
  }

  const readOffset = (moov, box, i) => box.type === 'co64'
    ? u64(moov, box.pos + 16 + i * 8)
    : u32(moov, box.pos + 16 + i * 4);

  const writeOffset = (moov, box, i, v) => box.type === 'co64'
    ? putU64(moov, box.pos + 16 + i * 8, v)
    : putU32(moov, box.pos + 16 + i * 4, v);

  /* Same reasoning as the sample tables: this count is read from the file and
   * drives the rewrite loops, so it is bounded by its own box. */
  const offsetCount = (moov, box) =>
    boundedCount(moov, box, 16, box.type === 'co64' ? 8 : 4, box.type);

  /* ------------------------------------------------------------ track helpers */

  const trakHandler = (b, t) => {
    const h = findPath(b, ['mdia', 'hdlr'], t.pos + 8, t.pos + t.size);
    return h ? fourcc(b, h.pos + 16) : '';
  };

  const traksOf = (moov) => children(moov, 8, moov.length).filter((k) => k.type === 'trak');
  const audioTraks = (moov) => traksOf(moov).filter((t) => trakHandler(moov, t) === 'soun');

  /*
   * tkhd and mvhd put their identifiers at different offsets depending on the
   * box version, and getting this wrong writes a track_ID into a timestamp.
   * Both are version-checked rather than assumed.
   */
  function trackIdOffset(b, tk) {
    const version = b[tk.pos + 8];
    return tk.pos + 8 + (version === 1 ? 20 : 12);
  }
  function nextTrackIdOffset(b, mvhd) {
    const version = b[mvhd.pos + 8];
    return mvhd.pos + 8 + (version === 1 ? 108 : 96);
  }

  /* ------------------------------------------------------------ the patch */

  const PHANTOM_SIZE = 8;    // bytes per phantom sample, matching the reference files
  const PHANTOM_DELTA = 1;   // one media tick: the smallest lie that still adds a sample

  /* See the note where this is enforced: the patch multiplies the sample count,
   * so this bounds peak memory rather than validating the file. */
  const MAX_REAL_SAMPLES = 250000;

  /**
   * Build the patched moov and describe the layout the file must be written in.
   *
   * @param {Uint8Array} moovSrc          the original moov box, standalone
   * @param {number} ftypLen              bytes of ftyp, which stays first
   * @param {number} oldPayloadStart      offset of the mdat PAYLOAD in the source
   * @param {number} payloadLen           length of that payload
   * @param {number} multiplier           decoy carries this many times its real samples
   * @returns {{moov, filler, mdatHeader, real, phantom, clonedTrack, neutralisedEdts}}
   */
  function buildPatchedMoov(moovSrc, ftypLen, oldPayloadStart, payloadLen, multiplier) {
    if (!(multiplier > 1)) throw new PatchError('multiplier must be greater than 1');

    let moov = moovSrc;
    let clonedTrack = false;

    /* ---- make a decoy if there is not already one ------------------------ */

    if (audioTraks(moov).length < 2) {
      const audio = audioTraks(moov);
      if (!audio.length) {
        throw new PatchError(
          'this video has no audio track, so there is nothing to use as a decoy. ' +
          'Add one (even silent) and try again.');
      }
      const mvhd = findBox(moov, 'mvhd', 8, moov.length);
      if (!mvhd) throw new PatchError('moov has no mvhd');
      const nextId = u32(moov, nextTrackIdOffset(moov, mvhd));

      const src = audio[audio.length - 1];
      /*
       * MUST be a real copy. `.slice()` on a Node Buffer returns a VIEW sharing
       * the same memory — Buffer overrides it as an alias for subarray — so
       * writing the new track_ID below would also overwrite the ORIGINAL audio
       * trak's id, leaving two traks claiming the same number. A browser
       * Uint8Array copies, so this only ever manifested off the browser path.
       */
      const clone = new Uint8Array(moov.subarray(src.pos, src.pos + src.size));
      const tk = findBox(clone, 'tkhd', 8, clone.length);
      if (!tk) throw new PatchError('audio track has no tkhd to clone');
      putU32(clone, trackIdOffset(clone, tk), nextId);

      /*
       * The clone keeps the original's chunk offsets. Two traks pointing at the
       * same chunks is legal — stco holds absolute file offsets and nothing
       * requires them to be disjoint — so the decoy costs no media bytes.
       */
      const kids = children(moov, 8, moov.length);
      moov = buildBox('moov', cat(kids.map((k) => moov.subarray(k.pos, k.pos + k.size)).concat([clone])));

      const mv2 = findBox(moov, 'mvhd', 8, moov.length);
      putU32(moov, nextTrackIdOffset(moov, mv2), nextId + 1);
      clonedTrack = true;
    }

    /* ---- inflate the decoy ------------------------------------------------ */

    const audio = audioTraks(moov);
    const decoy = audio[audio.length - 1];       // a player uses the FIRST one
    const stbl = findPath(moov, ['mdia', 'minf', 'stbl'], decoy.pos + 8, decoy.pos + decoy.size);
    if (!stbl) throw new PatchError('decoy track has no sample table');

    /*
     * NEUTRALISE THE DECOY'S EDIT LIST.
     *
     * An elst maps presentation time onto media time, and the segment_duration
     * it declares is the REAL duration — so a decoy that inherits its source's
     * edit list has the phantom ticks clamped straight back out of the presented
     * timeline. The inflation is still sitting in the sample tables, but it
     * stops being visible to anything that honours edit lists, and TikTok
     * evidently does: an upload whose decoy carried an inherited elst was
     * re-encoded, while the byte-identical file with this single box
     * neutralised came back untouched at 4K60.
     *
     * Both files the method was originally measured on happen to carry no elst
     * at all, which is why this never surfaced. Most encoders emit one — the
     * source that exposed it was HandBrake output — so this is the common case.
     *
     * Rewriting the fourcc to 'free' rather than deleting the box keeps every
     * following byte where it was: 'free' is skippable padding, so parsers
     * ignore its contents and no chunk offset has to move.
     */
    const decoyEdts = findBox(moov, 'edts', decoy.pos + 8, decoy.pos + decoy.size);
    const decoyEdtsPos = decoyEdts ? decoyEdts.pos : -1;

    const sb = [stbl.pos + 8, stbl.pos + stbl.size];

    const stts = findBox(moov, 'stts', ...sb);
    const stsz = findBox(moov, 'stsz', ...sb);
    const stsc = findBox(moov, 'stsc', ...sb);
    const stco = findBox(moov, 'stco', ...sb) || findBox(moov, 'co64', ...sb);
    if (!stts || !stsz || !stsc || !stco) throw new PatchError('decoy track is missing a sample table');

    const sizes = parseStsz(moov, stsz);
    const sttsEntries = parseStts(moov, stts);
    const stscEntries = parseStsc(moov, stsc);
    const chunkCount = offsetCount(moov, stco);

    const real = sizes.length;

    /*
     * A second ceiling, on top of the per-box bounds, because the patch
     * MULTIPLIES this: the rebuilt tables are `real * multiplier` entries and
     * get concatenated several times over, so peak memory is roughly
     * 240 bytes per real sample. 250k samples is about 90 minutes of AAC —
     * far past any platform's upload limit — and keeps the worst case well
     * inside a small server's memory.
     */
    if (real > MAX_REAL_SAMPLES) {
      throw new PatchError('this audio track has ' + real + ' samples, more than the ' +
        MAX_REAL_SAMPLES + ' this can patch — try a shorter video');
    }

    const phantom = Math.round(real * (multiplier - 1));
    if (phantom < 1) throw new PatchError('multiplier is too small to add any samples');

    const newStts = sttsEntries.concat([[phantom, PHANTOM_DELTA]]);
    const newSizes = sizes.concat(new Array(phantom).fill(PHANTOM_SIZE));
    // All phantoms in one extra chunk, matching the reference files.
    const newStsc = stscEntries.concat([[chunkCount + 1, phantom, 1]]);

    /*
     * The decoy's chunk-offset box gains one entry for the filler chunk. Its
     * value is written later, once the layout is known; it is identified by
     * INDEX rather than by a sentinel value so a real chunk that happens to sit
     * at a sentinel offset cannot be mistaken for it.
     */
    const fillerEntryIndex = chunkCount;
    const oldOffsets = [];
    for (let i = 0; i < chunkCount; i++) oldOffsets.push(readOffset(moov, stco, i));

    /* Rebuilt bottom-up so every ancestor size is recomputed rather than
     * patched, which is what keeps the box tree self-consistent. */
    const rebuild = (b, pos, size, targetStblPos) => {
      const type = boxType(b, pos);
      // Must precede the CONTAINERS check: 'edts' is a container, so the walk
      // would otherwise recurse into it and rebuild it under its original type.
      if (pos === decoyEdtsPos) {
        const freed = b.slice(pos, pos + size);
        freed.set([0x66, 0x72, 0x65, 0x65], 4);   // 'free'
        return freed;
      }
      if (pos === targetStblPos) {
        const parts = [];
        for (const k of children(b, pos + 8, pos + size)) {
          if (k.type === 'stts') parts.push(buildStts(newStts));
          else if (k.type === 'stsz') parts.push(buildStsz(newSizes));
          else if (k.type === 'stsc') parts.push(buildStsc(newStsc));
          else if (k.type === 'stco' || k.type === 'co64') {
            // Keep the original width; values are written in the layout pass.
            const body = k.type === 'co64'
              ? new Uint8Array((chunkCount + 1) * 8)
              : new Uint8Array((chunkCount + 1) * 4);
            parts.push(buildBox(k.type, cat([be32(0), be32(chunkCount + 1), body])));
          } else parts.push(b.subarray(k.pos, k.pos + k.size));
        }
        return buildBox('stbl', cat(parts));
      }
      if (!CONTAINERS.has(type)) return b.subarray(pos, pos + size);
      const parts = [];
      for (const k of children(b, pos + 8, pos + size)) parts.push(rebuild(b, k.pos, k.size, targetStblPos));
      if (!parts.length) return b.subarray(pos, pos + size);
      return buildBox(type, cat(parts));
    };

    const decoyStblPos = stbl.pos;
    let newMoov = rebuild(moov, 0, moov.length, decoyStblPos);

    /*
     * The decoy's mdhd duration is in media ticks and the phantoms add one each.
     * Without this the track header disagrees with its own sample table, which
     * is the kind of inconsistency a validator can reject outright.
     */
    {
      const nAudio = audioTraks(newMoov);
      const nDecoy = nAudio[nAudio.length - 1];
      const mdhd = findPath(newMoov, ['mdia', 'mdhd'], nDecoy.pos + 8, nDecoy.pos + nDecoy.size);
      if (mdhd) {
        const version = newMoov[mdhd.pos + 8];
        if (version === 1) {
          putU64(newMoov, mdhd.pos + 8 + 24, u64(newMoov, mdhd.pos + 8 + 24) + phantom * PHANTOM_DELTA);
        } else {
          putU32(newMoov, mdhd.pos + 8 + 16, u32(newMoov, mdhd.pos + 8 + 16) + phantom * PHANTOM_DELTA);
        }
      }
    }

    /* ---- lay the file out and fix every offset --------------------------- */

    const fillerLen = phantom * PHANTOM_SIZE;
    const newMdatSize = 8 + payloadLen + fillerLen;
    /* mdat needs a 64-bit header once its own size passes 4 GB. Writing a
     * 32-bit one there would silently truncate the length field. */
    const big = newMdatSize > 0xFFFFFFFF;
    const mdatHeaderLen = big ? 16 : 8;
    const mdatHeader = big
      ? cat([be32(1), ascii('mdat'), (() => { const a = new Uint8Array(8); putU64(a, 0, 16 + payloadLen + fillerLen); return a; })()])
      : cat([be32(newMdatSize), ascii('mdat')]);

    const newDataStart = ftypLen + newMoov.length + mdatHeaderLen;
    const shift = newDataStart - oldPayloadStart;
    const fillerOffset = newDataStart + payloadLen;

    /*
     * The decoy's own table was rebuilt with a zero-filled body, so it is
     * restored from the values read before the rebuild rather than shifted in
     * place. It is identified by walking to it, not by looking for zeroes — a
     * sentinel would be indistinguishable from a legitimately-zero offset.
     */
    const decoyOffsetBox = (() => {
      const nAudio = audioTraks(newMoov);
      const nDecoy = nAudio[nAudio.length - 1];
      const nStbl = findPath(newMoov, ['mdia', 'minf', 'stbl'], nDecoy.pos + 8, nDecoy.pos + nDecoy.size);
      return findBox(newMoov, 'stco', nStbl.pos + 8, nStbl.pos + nStbl.size)
          || findBox(newMoov, 'co64', nStbl.pos + 8, nStbl.pos + nStbl.size);
    })();

    for (const box of offsetBoxes(newMoov)) {
      if (box.pos === decoyOffsetBox.pos) continue;      // restored below
      const n = offsetCount(newMoov, box);
      for (let i = 0; i < n; i++) writeOffset(newMoov, box, i, readOffset(newMoov, box, i) + shift);
    }

    for (let i = 0; i < fillerEntryIndex; i++) {
      writeOffset(newMoov, decoyOffsetBox, i, oldOffsets[i] + shift);
    }
    writeOffset(newMoov, decoyOffsetBox, fillerEntryIndex, fillerOffset);

    /* A 32-bit stco cannot describe an offset past 4 GB. Caught here rather
     * than producing a file that plays until it reaches the far chunks. */
    for (const box of offsetBoxes(newMoov)) {
      if (box.type !== 'stco') continue;
      const n = offsetCount(newMoov, box);
      for (let i = 0; i < n; i++) {
        if (readOffset(newMoov, box, i) > 0xFFFFFFFF) {
          throw new PatchError('file is too large for 32-bit chunk offsets; re-mux it with co64');
        }
      }
    }

    return {
      moov: newMoov,
      mdatHeader,
      fillerLen,
      real,
      phantom,
      clonedTrack,
      neutralisedEdts: decoyEdtsPos >= 0,
    };
  }

  /* ------------------------------------------------------- top-level layout */

  /**
   * Locate the top-level boxes without assuming any particular order.
   *
   * A file straight out of an editor often has moov LAST, and QuickTime files
   * put a 'wide' box before mdat. Both are handled by walking headers rather
   * than by expecting ftyp/moov/mdat in that sequence.
   */
  function readBoxHeader(bytes, pos, fileLen) {
    if (pos + 8 > fileLen) return null;
    let size = u32(bytes, 0);
    const type = fourcc(bytes, 4);
    let headerLen = 8;
    if (size === 1) {
      if (pos + 16 > fileLen) return null;
      size = u64(bytes, 8);
      headerLen = 16;
    } else if (size === 0) {
      size = fileLen - pos;             // extends to end of file
    }
    if (size < headerLen) return null;
    return { type, pos, size, headerLen };
  }

  /* ------------------------------------------------------------ entry points */

  /** Patch a whole file already in memory. Used by the tests and by Node. */
  function patchBytes(bytes, opts) {
    const multiplier = (opts && opts.multiplier) || 10;
    const fileLen = bytes.length;

    const top = [];
    let p = 0;
    while (p + 8 <= fileLen) {
      const h = readBoxHeader(bytes.subarray(p, Math.min(p + 16, fileLen)), p, fileLen);
      if (!h || p + h.size > fileLen) break;
      top.push(h);
      p += h.size;
    }

    const ftyp = top.find((b) => b.type === 'ftyp');
    const moovBox = top.find((b) => b.type === 'moov');
    const mdatBox = top.find((b) => b.type === 'mdat');
    if (!ftyp || !moovBox || !mdatBox) throw new PatchError('not a plain mp4 (need ftyp, moov, mdat)');

    const ftypBytes = bytes.subarray(ftyp.pos, ftyp.pos + ftyp.size);
    const moovSrc = bytes.slice(moovBox.pos, moovBox.pos + moovBox.size);
    const payloadStart = mdatBox.pos + mdatBox.headerLen;
    const payloadLen = mdatBox.size - mdatBox.headerLen;

    const r = buildPatchedMoov(moovSrc, ftypBytes.length, payloadStart, payloadLen, multiplier);

    return {
      bytes: cat([
        ftypBytes,
        r.moov,
        r.mdatHeader,
        bytes.subarray(payloadStart, payloadStart + payloadLen),
        new Uint8Array(r.fillerLen),
      ]),
      real: r.real,
      phantom: r.phantom,
      fillerBytes: r.fillerLen,
      clonedTrack: r.clonedTrack,
      neutralisedEdts: r.neutralisedEdts,
      movedMoov: moovBox.pos > mdatBox.pos,
    };
  }

  /**
   * Patch a File in the browser without ever reading the media into memory.
   *
   * Only ftyp and moov are read. The payload — which is essentially the whole
   * file — is carried across as a Blob slice, which Chrome keeps as a reference
   * to the original bytes rather than a copy.
   */
  async function patchFile(file, opts) {
    const multiplier = (opts && opts.multiplier) || 10;
    const fileLen = file.size;

    const readAt = async (pos, len) =>
      new Uint8Array(await file.slice(pos, Math.min(pos + len, fileLen)).arrayBuffer());

    const top = [];
    let p = 0;
    while (p + 8 <= fileLen) {
      const head = await readAt(p, 16);
      const h = readBoxHeader(head, p, fileLen);
      if (!h || p + h.size > fileLen) break;
      top.push(h);
      p += h.size;
    }

    const ftyp = top.find((b) => b.type === 'ftyp');
    const moovBox = top.find((b) => b.type === 'moov');
    const mdatBox = top.find((b) => b.type === 'mdat');
    if (!ftyp || !moovBox || !mdatBox) throw new PatchError('not a plain mp4 (need ftyp, moov, mdat)');

    const ftypBytes = await readAt(ftyp.pos, ftyp.size);
    const moovSrc = await readAt(moovBox.pos, moovBox.size);
    const payloadStart = mdatBox.pos + mdatBox.headerLen;
    const payloadLen = mdatBox.size - mdatBox.headerLen;

    const r = buildPatchedMoov(moovSrc, ftypBytes.length, payloadStart, payloadLen, multiplier);

    const out = new File(
      [ftypBytes, r.moov, r.mdatHeader,
       file.slice(payloadStart, payloadStart + payloadLen),
       new Uint8Array(r.fillerLen)],
      file.name,
      { type: 'video/mp4', lastModified: Date.now() });

    return {
      file: out,
      real: r.real,
      phantom: r.phantom,
      fillerBytes: r.fillerLen,
      clonedTrack: r.clonedTrack,
      neutralisedEdts: r.neutralisedEdts,
      movedMoov: moovBox.pos > mdatBox.pos,
    };
  }

  return {
    patchFile,
    patchBytes,
    buildPatchedMoov,
    PatchError,
    PHANTOM_SIZE,
    PHANTOM_DELTA,
    MAX_SAMPLES,
    MAX_REAL_SAMPLES,
    // exposed for tests
    _internals: { children, findBox, findPath, audioTraks, traksOf, parseStts, parseStsz, parseStsc, offsetBoxes, readOffset, offsetCount, u32, u64 },
  };
}));
