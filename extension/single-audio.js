"use strict";
var PristineUpload = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/lib/mp4/extension-entry.ts
  var extension_entry_exports = {};
  __export(extension_entry_exports, {
    patchFile: () => patchFile
  });

  // src/lib/mp4/boxes.ts
  var Mp4Error = class extends Error {
    constructor(code, message) {
      super(message);
      this.name = "Mp4Error";
      this.code = code;
    }
  };
  var MAX_TABLE_ENTRIES = 1e6;
  var u32 = (b, p) => (b[p] << 24 | b[p + 1] << 16 | b[p + 2] << 8 | b[p + 3]) >>> 0;
  var u16 = (b, p) => (b[p] << 8 | b[p + 1]) >>> 0;
  function u64(b, p) {
    const v = u32(b, p) * 4294967296 + u32(b, p + 4);
    if (!Number.isSafeInteger(v)) {
      throw new Mp4Error("u64_unsafe", "This file uses 64-bit values too large to handle exactly.");
    }
    return v;
  }
  function putU32(b, p, v) {
    b[p] = v >>> 24 & 255;
    b[p + 1] = v >>> 16 & 255;
    b[p + 2] = v >>> 8 & 255;
    b[p + 3] = v & 255;
  }
  function putU64(b, p, v) {
    putU32(b, p, Math.floor(v / 4294967296));
    putU32(b, p + 4, v >>> 0);
  }
  var be32 = (n) => {
    const a = new Uint8Array(4);
    putU32(a, 0, n);
    return a;
  };
  var ascii = (s) => {
    const a = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 255;
    return a;
  };
  function cat(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
  var fourcc = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
  var boxType = (b, p) => fourcc(b, p + 4);
  var buildBox = (type, content) => cat([be32(8 + content.length), ascii(type), content]);
  function children(b, start, end) {
    const out = [];
    let p = start;
    while (p + 8 <= end) {
      const size = u32(b, p);
      if (size < 8 || p + size > end) break;
      out.push({ type: boxType(b, p), pos: p, size, headerLen: 8 });
      p += size;
    }
    return out;
  }
  var findBox = (b, type, s, e) => children(b, s, e).find((k) => k.type === type) ?? null;
  function findPath(b, path, s, e) {
    let cs = s;
    let ce = e;
    let box = null;
    for (const t of path) {
      box = findBox(b, t, cs, ce);
      if (!box) return null;
      cs = box.pos + 8;
      ce = box.pos + box.size;
    }
    return box;
  }
  function readBoxHeader(head, pos, fileLen) {
    if (pos + 8 > fileLen) return null;
    let size = u32(head, 0);
    const type = fourcc(head, 4);
    let headerLen = 8;
    if (size === 1) {
      if (pos + 16 > fileLen) return null;
      size = u64(head, 8);
      headerLen = 16;
    } else if (size === 0) {
      size = fileLen - pos;
    }
    if (size < headerLen) return null;
    return { type, pos, size, headerLen };
  }
  function boundedCount(b, box, headerLen, entryLen, what) {
    const n = u32(b, box.pos + 12);
    if (headerLen + n * entryLen > box.size) {
      throw new Mp4Error(
        "bad_table",
        `${what} declares ${n} entries but its box only holds ${Math.max(0, Math.floor((box.size - headerLen) / entryLen))}.`
      );
    }
    if (n > MAX_TABLE_ENTRIES) {
      throw new Mp4Error("table_too_large", `${what} declares ${n} entries; the limit is ${MAX_TABLE_ENTRIES}.`);
    }
    return n;
  }
  function parseStts(b, box) {
    const n = boundedCount(b, box, 16, 8, "stts");
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push([u32(b, box.pos + 16 + i * 8), u32(b, box.pos + 20 + i * 8)]);
    }
    return out;
  }
  function parseStsz(b, box) {
    const uniform = u32(b, box.pos + 12);
    const count = u32(b, box.pos + 16);
    if (uniform !== 0) {
      if (count > MAX_TABLE_ENTRIES) {
        throw new Mp4Error("table_too_large", `stsz declares ${count} samples; the limit is ${MAX_TABLE_ENTRIES}.`);
      }
      return new Array(count).fill(uniform);
    }
    if (20 + count * 4 > box.size) {
      throw new Mp4Error(
        "bad_table",
        `stsz declares ${count} samples but its box only holds ${Math.max(0, Math.floor((box.size - 20) / 4))}.`
      );
    }
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = u32(b, box.pos + 20 + i * 4);
    return out;
  }
  function parseStsc(b, box) {
    const n = boundedCount(b, box, 16, 12, "stsc");
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push([
        u32(b, box.pos + 16 + i * 12),
        u32(b, box.pos + 20 + i * 12),
        u32(b, box.pos + 24 + i * 12)
      ]);
    }
    return out;
  }
  var offsetCount = (moov, box) => boundedCount(moov, box, 16, box.type === "co64" ? 8 : 4, box.type);
  var readOffset = (moov, box, i) => box.type === "co64" ? u64(moov, box.pos + 16 + i * 8) : u32(moov, box.pos + 16 + i * 4);
  var trakHandler = (b, t) => {
    const h = findPath(b, ["mdia", "hdlr"], t.pos + 8, t.pos + t.size);
    return h ? fourcc(b, h.pos + 16) : "";
  };
  var traksOf = (moov) => children(moov, 8, moov.length).filter((k) => k.type === "trak");
  var audioTraks = (moov) => traksOf(moov).filter((t) => trakHandler(moov, t) === "soun");
  var videoTraks = (moov) => traksOf(moov).filter((t) => trakHandler(moov, t) === "vide");
  var trackIdOffset = (b, tk) => tk.pos + 8 + (b[tk.pos + 8] === 1 ? 20 : 12);
  var nextTrackIdOffset = (b, mvhd) => mvhd.pos + 8 + (b[mvhd.pos + 8] === 1 ? 108 : 96);

  // src/lib/mp4/scan.ts
  var MAX_MOOV_BYTES = 4 * 1024 * 1024;
  var AVC_PROFILES = {
    66: "Baseline",
    77: "Main",
    88: "Extended",
    100: "High",
    110: "High 10",
    122: "High 4:2:2",
    244: "High 4:4:4"
  };
  var HEVC_PROFILES = {
    1: "Main",
    2: "Main 10",
    3: "Main Still Picture",
    4: "Range Extensions"
  };
  async function locateTopLevel(file) {
    const readAt = async (pos, len) => new Uint8Array(await file.slice(pos, Math.min(pos + len, file.size)).arrayBuffer());
    const out = [];
    let p = 0;
    let guard = 0;
    while (p + 8 <= file.size && guard++ < 4096) {
      const head = await readAt(p, 16);
      const h = readBoxHeader(head, p, file.size);
      if (!h || p + h.size > file.size) break;
      out.push(h);
      p += h.size;
    }
    return out;
  }
  function describeVideo(moov, videoTrak) {
    const none = { codec: "unknown", profile: "", level: "", codedSize: null };
    const stsd = findPath(moov, ["mdia", "minf", "stbl", "stsd"], videoTrak.pos + 8, videoTrak.pos + videoTrak.size);
    if (!stsd) return none;
    const entries = children(moov, stsd.pos + 16, stsd.pos + stsd.size);
    const entry = entries[0];
    if (!entry) return none;
    const codedSize = {
      width: u16(moov, entry.pos + 8 + 24),
      height: u16(moov, entry.pos + 8 + 26)
    };
    const codec = entry.type;
    const configStart = entry.pos + 8 + 78;
    const configEnd = entry.pos + entry.size;
    const avcC = findBox(moov, "avcC", configStart, configEnd);
    if (avcC) {
      const b = avcC.pos + 8;
      return {
        codec: "H.264",
        profile: AVC_PROFILES[moov[b + 1]] ?? `profile ${moov[b + 1]}`,
        level: (moov[b + 3] / 10).toFixed(1),
        codedSize
      };
    }
    const hvcC = findBox(moov, "hvcC", configStart, configEnd);
    if (hvcC) {
      const b = hvcC.pos + 8;
      const profileIdc = moov[b + 1] & 31;
      return {
        codec: "HEVC",
        profile: HEVC_PROFILES[profileIdc] ?? `profile ${profileIdc}`,
        // general_level_idc is in units of 1/30th.
        level: (moov[b + 12] / 30).toFixed(1) + (moov[b + 1] & 32 ? " High tier" : ""),
        codedSize
      };
    }
    const av1C = findBox(moov, "av1C", configStart, configEnd);
    if (av1C) {
      const idx = moov[av1C.pos + 8 + 1] & 31;
      return { codec: "AV1", profile: "Main", level: `${2 + (idx >> 2)}.${idx & 3}`, codedSize };
    }
    return { codec, profile: "", level: "", codedSize };
  }
  async function materialise(file) {
    if (file.size > 0) return file;
    let bytes;
    try {
      bytes = await file.arrayBuffer();
    } catch {
      bytes = new ArrayBuffer(0);
    }
    if (bytes.byteLength === 0) {
      throw new Mp4Error(
        "empty_file",
        "The browser handed over an empty file (0 bytes). If it is stored online-only (OneDrive, iCloud Drive, Google Drive), open the folder and download it fully first, or pick it with the Choose file button instead of dragging."
      );
    }
    return new File([bytes], file.name, { type: file.type, lastModified: file.lastModified });
  }
  async function scanFile(input) {
    const file = await materialise(input);
    const top = await locateTopLevel(file);
    if (top.some((b) => b.type === "moof") || top.filter((b) => b.type === "mdat").length > 1) {
      throw new Mp4Error("fragmented", "Export a regular, flattened MP4 before preparing this video.");
    }
    const ftypBox = top.find((b) => b.type === "ftyp");
    const moovBox = top.find((b) => b.type === "moov");
    const mdatBox = top.find((b) => b.type === "mdat");
    if (ftypBox && (!moovBox || !mdatBox)) {
      throw new Mp4Error(
        "unfinished",
        "This file looks unfinished. If it is still exporting, wait for the export to complete and drop it again."
      );
    }
    if (!ftypBox || !moovBox || !mdatBox) {
      throw new Mp4Error(
        "not_mp4",
        "This does not look like an MP4. Export as .mp4 (H.264 or HEVC) and try again."
      );
    }
    if (moovBox.size > MAX_MOOV_BYTES) {
      throw new Mp4Error(
        "moov_too_large",
        `This video's index is ${(moovBox.size / 1048576).toFixed(1)} MB, larger than we can process. That usually means a very long video \u2014 try a shorter clip.`
      );
    }
    const read = async (b) => new Uint8Array(await file.slice(b.pos, b.pos + b.size).arrayBuffer());
    const ftyp = await read(ftypBox);
    const moov = await read(moovBox);
    const payloadStart = mdatBox.pos + mdatBox.headerLen;
    const payloadLen = mdatBox.size - mdatBox.headerLen;
    const vTraks = videoTraks(moov);
    if (!vTraks.length) {
      throw new Mp4Error("no_video", "This file has no video track.");
    }
    const vt = vTraks[0];
    const mdhd = findPath(moov, ["mdia", "mdhd"], vt.pos + 8, vt.pos + vt.size);
    if (!mdhd) throw new Mp4Error("no_mdhd", "This video is missing its track header.");
    const mdhdV1 = moov[mdhd.pos + 8] === 1;
    const timescale = mdhdV1 ? u32(moov, mdhd.pos + 8 + 20) : u32(moov, mdhd.pos + 8 + 12);
    const mediaDur = mdhdV1 ? u64(moov, mdhd.pos + 8 + 24) : u32(moov, mdhd.pos + 8 + 16);
    const durationSec = timescale > 0 ? mediaDur / timescale : 0;
    const stbl = findPath(moov, ["mdia", "minf", "stbl"], vt.pos + 8, vt.pos + vt.size);
    const stsz = stbl ? findBox(moov, "stsz", stbl.pos + 8, stbl.pos + stbl.size) : null;
    const videoSamples = stsz ? parseStsz(moov, stsz).length : 0;
    const { codec, profile, level, codedSize } = describeVideo(moov, vt);
    const width = codedSize?.width ?? 0;
    const height = codedSize?.height ?? 0;
    const audio = audioTraks(moov);
    return {
      descriptor: {
        ftypLen: ftyp.length,
        moovLen: moov.length,
        payloadStart,
        payloadLen
      },
      moov,
      ftyp,
      file,
      fileName: file.name,
      fileSize: file.size,
      durationSec,
      bitrateMbps: durationSec > 0 ? file.size * 8 / durationSec / 1e6 : 0,
      width,
      height,
      fps: durationSec > 0 ? videoSamples / durationSec : 0,
      videoSamples,
      codec,
      profile,
      level,
      audioTrackCount: audio.length,
      hasAudio: audio.length > 0,
      needsFaststart: moovBox.pos > mdatBox.pos
    };
  }

  // src/lib/mp4/patch.ts
  var MAX_REAL_SAMPLES = 25e4;
  var buildStts = (e) => buildBox("stts", cat([be32(0), be32(e.length), cat(e.map(([c, d]) => cat([be32(c), be32(d)])))]));
  var buildStsc = (e) => buildBox("stsc", cat([be32(0), be32(e.length), cat(e.map((x) => cat([be32(x[0]), be32(x[1]), be32(x[2])])))]));
  function buildStsz(sizes) {
    const body = new Uint8Array(sizes.length * 4);
    for (let i = 0; i < sizes.length; i++) putU32(body, i * 4, sizes[i]);
    return buildBox("stsz", cat([be32(0), be32(0), be32(sizes.length), body]));
  }
  var SILENT_FRAME = new Uint8Array([33, 16, 4, 96, 140, 28]);
  var AAC_RATE = 44100;
  var AAC_FRAME = 1024;
  var AAC_ASC = new Uint8Array([18, 16]);
  var be16 = (n) => new Uint8Array([n >>> 8 & 255, n & 255]);
  var zeros = (n) => new Uint8Array(n);
  function buildSilentTrak(moov, mvhd, trackId, chunkOffset) {
    const v1 = moov[mvhd.pos + 8] === 1;
    const timescale = v1 ? u32(moov, mvhd.pos + 8 + 20) : u32(moov, mvhd.pos + 8 + 12);
    const duration2 = v1 ? u64(moov, mvhd.pos + 8 + 24) : u32(moov, mvhd.pos + 8 + 16);
    const seconds = timescale > 0 ? duration2 / timescale : 0;
    const frames = Math.max(1, Math.ceil(seconds * AAC_RATE / AAC_FRAME));
    if (!Number.isFinite(frames) || frames > MAX_REAL_SAMPLES) {
      throw new Mp4Error("too_long", "This video is longer than we can process. Try a shorter clip.");
    }
    const mediaDuration = frames * AAC_FRAME;
    const trackDuration = Math.round(mediaDuration / AAC_RATE * timescale);
    const bytes = new Uint8Array(frames * SILENT_FRAME.length);
    for (let i = 0; i < frames; i++) bytes.set(SILENT_FRAME, i * SILENT_FRAME.length);
    const tkhd = buildBox("tkhd", cat([
      be32(7),
      be32(0),
      be32(0),
      be32(trackId),
      be32(0),
      be32(trackDuration),
      zeros(8),
      be16(0),
      be16(0),
      be16(256),
      be16(0),
      be32(65536),
      be32(0),
      be32(0),
      be32(0),
      be32(65536),
      be32(0),
      be32(0),
      be32(0),
      be32(1073741824),
      be32(0),
      be32(0)
    ]));
    const mdhd = buildBox("mdhd", cat([
      be32(0),
      be32(0),
      be32(0),
      be32(AAC_RATE),
      be32(mediaDuration),
      be16(21956),
      be16(0)
    ]));
    const hdlr = buildBox("hdlr", cat([
      be32(0),
      be32(0),
      ascii("soun"),
      zeros(12),
      ascii("SoundHandler"),
      zeros(1)
    ]));
    const smhd = buildBox("smhd", cat([be32(0), be16(0), be16(0)]));
    const dinf = buildBox("dinf", buildBox("dref", cat([
      be32(0),
      be32(1),
      buildBox("url ", be32(1))
    ])));
    const dsi = cat([new Uint8Array([5, AAC_ASC.length]), AAC_ASC]);
    const dcdBody = cat([
      new Uint8Array([64, 21, 0, 6, 0]),
      // AAC, audio stream, buffer size
      be32(128e3),
      be32(128e3),
      // max / average bitrate (nominal)
      dsi
    ]);
    const dcd = cat([new Uint8Array([4, dcdBody.length]), dcdBody]);
    const sl = new Uint8Array([6, 1, 2]);
    const esBody = cat([be16(0), new Uint8Array([0]), dcd, sl]);
    const es = cat([new Uint8Array([3, esBody.length]), esBody]);
    const esds = buildBox("esds", cat([be32(0), es]));
    const mp4a = buildBox("mp4a", cat([
      zeros(6),
      be16(1),
      // reserved, data_reference_index
      be16(0),
      be16(0),
      be32(0),
      // version, revision, vendor
      be16(2),
      be16(16),
      be16(0),
      be16(0),
      // channels, sample size, compression id, packet size
      be32(AAC_RATE << 16),
      // sample rate, 16.16
      esds
    ]));
    const stsd = buildBox("stsd", cat([be32(0), be32(1), mp4a]));
    const stts = buildStts([[frames, AAC_FRAME]]);
    const stsc = buildStsc([[1, frames, 1]]);
    const stsz = buildStsz(new Array(frames).fill(SILENT_FRAME.length));
    const stco = buildBox("stco", cat([be32(0), be32(1), be32(chunkOffset)]));
    const stbl = buildBox("stbl", cat([stsd, stts, stsc, stsz, stco]));
    const minf = buildBox("minf", cat([smhd, dinf, stbl]));
    const mdia = buildBox("mdia", cat([mdhd, hdlr, minf]));
    const trak = buildBox("trak", cat([tkhd, mdia]));
    return { trak, bytes };
  }

  // src/lib/mp4/upload.ts
  var MAX_REAL_SAMPLES2 = 9e4;
  var RAW_PACKET = Uint8Array.of(0, 0, 0, 4, 0, 0, 0, 0);
  var SILENT_PACKET = Uint8Array.of(33, 16, 4, 96, 140, 28, 0, 0);
  var bytes64 = (n) => {
    const b = new Uint8Array(8);
    putU64(b, 0, n);
    return b;
  };
  var table = (name, rows) => buildBox(name, cat([
    be32(0),
    be32(rows.length),
    ...rows.map((row) => cat(row.map(be32)))
  ]));
  var durationAt = (data, box) => box.pos + (data[box.pos + 8] === 1 ? box.type === "tkhd" ? 36 : 32 : box.type === "tkhd" ? 28 : 24);
  var duration = (data, box) => data[box.pos + 8] === 1 ? u64(data, durationAt(data, box)) : u32(data, durationAt(data, box));
  var scale = (data, box) => u32(data, box.pos + (data[box.pos + 8] === 1 ? 28 : 20));
  function setDuration(data, box, ticks) {
    if (!Number.isSafeInteger(ticks) || ticks < 0) throw new Mp4Error("bad_duration", "This file has an unsupported track timeline.");
    const out = new Uint8Array(data.subarray(box.pos, box.pos + box.size));
    const versionOne = out[8] === 1;
    out.fill(0, 12, versionOne ? 28 : 20);
    const at = durationAt(data, box) - box.pos;
    if (versionOne) putU64(out, at, ticks);
    else {
      if (ticks > 4294967295) throw new Mp4Error("long_duration", "This track is too long to prepare.");
      putU32(out, at, ticks);
    }
    return out;
  }
  function unspecifiedMovieDuration(data, box) {
    const rest = data.subarray(box.pos + (data[box.pos + 8] === 1 ? 40 : 28), box.pos + box.size);
    return buildBox("mvhd", cat([
      be32(16777216),
      bytes64(0),
      bytes64(0),
      be32(scale(data, box)),
      new Uint8Array(8).fill(255),
      rest
    ]));
  }
  function metadata() {
    const item = (name, value) => buildBox(
      name,
      buildBox("data", cat([be32(1), be32(0), new TextEncoder().encode(value)]))
    );
    const handler = buildBox("hdlr", cat([be32(0), be32(0), ascii("mdir"), ascii("appl"), new Uint8Array(9)]));
    const fields = buildBox("ilst", cat([item("\xA9too", "Pristine"), item("\xA9cmt", "Prepared locally by Pristine")]));
    const namedHandler = buildBox("hdlr", cat([be32(0), be32(0), ascii("mdir"), new Uint8Array(13)]));
    return buildBox("udta", cat([
      buildBox("meta", cat([be32(4 + handler.length + fields.length), handler, fields])),
      buildBox("meta", cat([
        be32(0),
        namedHandler,
        buildBox("name", ascii("Pristine")),
        buildBox("ilst", item("\xA9cmt", "Prepared locally by Pristine"))
      ]))
    ]));
  }
  function audioDescription(data, box, bitrate) {
    const out = new Uint8Array(data.subarray(box.pos, box.pos + box.size));
    let peak = bitrate;
    for (let p = 20; p + 16 <= out.length; p++) {
      if (fourcc(out, p) !== "esds") continue;
      let at = p + 8;
      const readLength = () => {
        let n = 0;
        for (let i = 0; i < 4 && at < out.length; i++) {
          const b = out[at++];
          n = n * 128 + (b & 127);
          if (!(b & 128)) return n;
        }
        return n;
      };
      if (out[at++] !== 3) break;
      readLength();
      at += 2;
      const flags = out[at++];
      if (flags & 128) at += 2;
      if (flags & 64) at += 1 + out[at];
      if (flags & 32) at += 2;
      if (out[at++] !== 4) break;
      readLength();
      at += 5;
      if (at + 8 <= out.length) {
        peak = Math.max(bitrate, u32(out, at + 4));
        putU32(out, at, peak);
        putU32(out, at + 4, bitrate);
      }
      break;
    }
    for (let p = 20; p + 16 <= out.length; p++) if (fourcc(out, p) === "btrt") {
      putU32(out, p + 8, peak);
      putU32(out, p + 12, bitrate);
      break;
    }
    return out;
  }
  function hasStereoAacLc(data, desc) {
    if (u16(data, desc.pos + 40) !== 2) return false;
    const esds = findBox(data, "esds", desc.pos + 52, desc.pos + desc.size);
    if (!esds) return false;
    let at = esds.pos + 12;
    const tag = (expected) => {
      if (data[at++] !== expected) return false;
      for (let n = 0; n < 4 && at < esds.pos + esds.size; n++) if (!(data[at++] & 128)) return true;
      return false;
    };
    if (!tag(3)) return false;
    at += 2;
    const flags = data[at++];
    if (flags & 128) at += 2;
    if (flags & 64) at += 1 + data[at];
    if (flags & 32) at += 2;
    if (!tag(4)) return false;
    at += 13;
    if (!tag(5) || at + 2 > esds.pos + esds.size) return false;
    return data[at] >> 3 === 2 && (data[at + 1] >> 3 & 15) === 2;
  }
  function prepareUpload(scan, audioMode = "compatible", duplicateAudio = false, encodedFrameRate) {
    let data = scan.moov;
    let movie = findBox(data, "mvhd", 8, data.length);
    if (!movie) throw new Mp4Error("no_mvhd", "This MP4 has no movie header.");
    let suppliedAudio = new Uint8Array(0);
    if (audioTraks(data).length === 0) {
      const trackId = u32(data, nextTrackIdOffset(data, movie));
      const silent = buildSilentTrak(data, movie, trackId, scan.descriptor.payloadStart + scan.descriptor.payloadLen);
      data = buildBox("moov", cat([data.subarray(8), silent.trak]));
      suppliedAudio = silent.bytes;
      movie = findBox(data, "mvhd", 8, data.length);
      putU32(data, nextTrackIdOffset(data, movie), trackId + 1);
    }
    const audio = audioTraks(data);
    if (audio.length !== 1) throw new Mp4Error("multiple_audio", "Choose a clean export with one AAC audio track. This file may already be prepared.");
    const audioTrack = audio[0];
    const audioTable = findPath(data, ["mdia", "minf", "stbl"], audioTrack.pos + 8, audioTrack.pos + audioTrack.size);
    if (!audioTable) throw new Mp4Error("no_audio_table", "The audio sample table is missing.");
    const audioBox = (name) => findBox(data, name, audioTable.pos + 8, audioTable.pos + audioTable.size);
    const desc = audioBox("stsd"), sizesBox = audioBox("stsz"), timingBox = audioBox("stts");
    if (!desc || !sizesBox || !timingBox || fourcc(data, desc.pos + 20) !== "mp4a")
      throw new Mp4Error("aac_required", "Export your video with AAC audio before preparing it.");
    if (audioMode === "compatible" && !hasStereoAacLc(data, desc))
      throw new Mp4Error("stereo_required", "Export with stereo AAC-LC audio for this upload option.");
    const realSizes = parseStsz(data, sizesBox), audioTiming = parseStts(data, timingBox);
    const tail = audioTiming.at(-1);
    if (tail?.[1] === 1 && tail[0] > 100) throw new Mp4Error("already_prepared", "This video is already prepared. Start with its clean export.");
    if (!realSizes.length || realSizes.length > MAX_REAL_SAMPLES2)
      throw new Mp4Error("audio_too_long", "This audio track is too long to prepare in your browser.");
    const addedCount = realSizes.length * 9;
    const packet = audioMode === "compatible" ? SILENT_PACKET : RAW_PACKET;
    const extra = new Uint8Array(addedCount * packet.length);
    for (let p = 0; p < extra.length; p += packet.length) extra.set(packet, p);
    const movieScale = scale(data, movie);
    if (!movieScale) throw new Mp4Error("bad_timescale", "This MP4 has an invalid movie timescale.");
    const ftyp = buildBox("ftyp", cat([
      ascii("isom"),
      be32(512),
      ascii("isomiso2"),
      ...scan.codec === "H.264" ? [ascii("avc1")] : [],
      ascii("mp41")
    ]));
    const payloadSize = scan.descriptor.payloadLen + suppliedAudio.length;
    const mdatHeader = payloadSize + 8 <= 4294967295 ? cat([be32(payloadSize + 8), ascii("mdat")]) : cat([be32(1), ascii("mdat"), bytes64(payloadSize + 16)]);
    const trackList = traksOf(data);
    function rebuildTrack(track, shift, extraOffset, padAudio = true) {
      const pick = (names) => findPath(data, names, track.pos + 8, track.pos + track.size);
      const tkhd = pick(["tkhd"]), mdhd = pick(["mdia", "mdhd"]), stbl = pick(["mdia", "minf", "stbl"]);
      if (!tkhd || !mdhd || !stbl) throw new Mp4Error("incomplete_track", "An MP4 track has incomplete headers.");
      const audioHere = padAudio && track.pos === audioTrack.pos;
      const rate = scale(data, mdhd);
      let mediaTicks = duration(data, mdhd), movieTicks = duration(data, tkhd);
      let encodedTiming = null;
      const edit = pick(["edts", "elst"]);
      if (encodedFrameRate && track.pos !== audioTrack.pos) {
        const timing = findBox(data, "stts", stbl.pos + 8, stbl.pos + stbl.size);
        if (!timing) throw new Mp4Error("no_timing", "The video frame timing is missing.");
        const count = parseStts(data, timing).reduce((sum, [n]) => sum + n, 0);
        encodedTiming = [];
        for (let i = 0; i < count; i++) {
          const delta = Math.round((i + 1) * rate / encodedFrameRate) - Math.round(i * rate / encodedFrameRate);
          if (delta < 1) throw new Mp4Error("bad_timescale", "The video timescale is too low for this frame rate.");
          const last = encodedTiming.at(-1);
          if (last?.[1] === delta) last[0]++;
          else encodedTiming.push([1, delta]);
        }
        mediaTicks = Math.round(count * rate / encodedFrameRate);
        movieTicks = Math.round(mediaTicks * movieScale / rate);
      } else if (edit) {
        if (u32(data, edit.pos + 12) !== 1) throw new Mp4Error("complex_edits", "Export a flattened MP4 before preparing this edited timeline.");
        const v1 = data[edit.pos + 8] === 1;
        movieTicks = v1 ? u64(data, edit.pos + 16) : u32(data, edit.pos + 16);
        const startAt = edit.pos + (v1 ? 24 : 20);
        const start = u32(data, startAt) === 4294967295 ? 0 : v1 ? u64(data, startAt) : u32(data, startAt);
        mediaTicks = start + Math.round(movieTicks * rate / movieScale);
      }
      const replacements = /* @__PURE__ */ new Map([[tkhd.pos, setDuration(data, tkhd, movieTicks)], [mdhd.pos, setDuration(data, mdhd, mediaTicks)]]);
      const chunks = children(data, stbl.pos + 8, stbl.pos + stbl.size);
      const offsets = chunks.find((b) => b.type === "stco" || b.type === "co64");
      if (!offsets) throw new Mp4Error("no_offsets", "A track has no sample offsets.");
      for (const box of chunks) {
        if (box.type === "stts") {
          const entries = encodedTiming || parseStts(data, box), total = entries.reduce((s, [n, d]) => s + n * d, 0);
          const delta = mediaTicks - total;
          if (delta && entries.length) {
            const last = entries[entries.length - 1];
            if (last[1] + delta < 1 || last[1] + delta > 4294967295) throw new Mp4Error("bad_timing", "This file has an unsupported timing offset.");
            if (last[0] > 1) {
              last[0]--;
              entries.push([1, last[1] + delta]);
            } else last[1] += delta;
          }
          if (audioHere) entries.push([addedCount, 1]);
          replacements.set(box.pos, table("stts", entries));
        } else if (audioHere && box.type === "stsc") {
          const entries = parseStsc(data, box);
          entries.push([offsetCount(data, offsets) + 1, addedCount, entries.at(-1)?.[2] || 1]);
          replacements.set(box.pos, table("stsc", entries));
        } else if (audioHere && box.type === "stsz") {
          replacements.set(box.pos, buildBox("stsz", cat([
            be32(0),
            be32(0),
            be32(realSizes.length + addedCount),
            ...realSizes.map(be32),
            ...Array.from({ length: addedCount }, () => be32(packet.length))
          ])));
        } else if (box === offsets) {
          const values = Array.from({ length: offsetCount(data, box) }, (_, i) => readOffset(data, box, i) + shift);
          if (audioHere) values.push(extraOffset);
          const wide = values.some((n) => n > 4294967295);
          replacements.set(box.pos, buildBox(wide ? "co64" : "stco", cat([be32(0), be32(values.length), ...values.map(wide ? bytes64 : be32)])));
        } else if (audioHere && box.type === "stsd") {
          replacements.set(box.pos, audioDescription(data, box, Math.floor(realSizes.reduce((a, b) => a + b, 0) * 8 * rate / mediaTicks)));
        }
      }
      const rebuild = (box) => {
        const replacement = replacements.get(box.pos);
        if (replacement) return replacement;
        if (box.type === "edts" || box.type === "udta") return new Uint8Array(0);
        if (["trak", "mdia", "minf", "stbl"].includes(box.type))
          return buildBox(box.type, cat(children(data, box.pos + 8, box.pos + box.size).map(rebuild)));
        return data.subarray(box.pos, box.pos + box.size);
      };
      const result = rebuild(track);
      if (duplicateAudio && audioHere) {
        const header = findBox(result, "tkhd", 8, result.length);
        putU32(result, trackIdOffset(result, header), u32(data, nextTrackIdOffset(data, movie)));
      }
      return result;
    }
    let outputMoov = new Uint8Array(0);
    for (let attempt = 0; attempt < 8; attempt++) {
      const payloadAt = ftyp.length + outputMoov.length + mdatHeader.length;
      const next = buildBox("moov", cat([
        unspecifiedMovieDuration(data, movie),
        ...trackList.flatMap((track) => {
          const shift = payloadAt - scan.descriptor.payloadStart;
          const extraOffset = payloadAt + payloadSize;
          return duplicateAudio && track.pos === audioTrack.pos ? [rebuildTrack(track, shift, extraOffset, false), rebuildTrack(track, shift, extraOffset)] : [rebuildTrack(track, shift, extraOffset)];
        }),
        metadata()
      ]));
      const settled = next.length === outputMoov.length;
      outputMoov = next;
      if (duplicateAudio) {
        const mv = findBox(outputMoov, "mvhd", 8, outputMoov.length);
        putU32(outputMoov, nextTrackIdOffset(outputMoov, mv), u32(data, nextTrackIdOffset(data, movie)) + 1);
      }
      if (settled) break;
      if (attempt === 7) throw new Mp4Error("offset_layout", "Could not lay out this MP4 safely.");
    }
    return new File([
      ftyp,
      outputMoov,
      mdatHeader,
      scan.file.slice(scan.descriptor.payloadStart, scan.descriptor.payloadStart + scan.descriptor.payloadLen),
      suppliedAudio,
      extra
    ], `${scan.fileName.replace(/\.[^.]+$/, "")}-pristine.mp4`, { type: "video/mp4" });
  }

  // src/lib/mp4/extension-entry.ts
  async function patchFile(file, options = {}) {
    const scan = await scanFile(file);
    const audio = audioTraks(scan.moov)[0];
    const sizesBox = audio && findPath(scan.moov, ["mdia", "minf", "stbl", "stsz"], audio.pos + 8, audio.pos + audio.size);
    const timingBox = audio && findPath(scan.moov, ["mdia", "minf", "stbl", "stts"], audio.pos + 8, audio.pos + audio.size);
    const tail = timingBox && parseStts(scan.moov, timingBox).at(-1);
    if (scan.audioTrackCount === 1 && tail?.[1] === 1 && tail[0] > 100) {
      return { file, alreadyPrepared: true, real: 0, phantom: 0, clonedTrack: false, movedMoov: false };
    }
    const real = sizesBox ? parseStsz(scan.moov, sizesBox).length : 0;
    const fourK120 = Math.min(scan.width, scan.height) >= 2160 && scan.fps > 100;
    if (options.auto && fourK120 && scan.codec !== "HEVC") throw Error("For the 4K/120 preset, export using HEVC (H.265) first.");
    const separate = options.auto ? !fourK120 : !!options.separateAudio;
    return {
      file: prepareUpload(scan, options.mobile ? "mobile" : "compatible", separate),
      real,
      phantom: real * 9,
      clonedTrack: separate,
      movedMoov: scan.needsFaststart
    };
  }
  return __toCommonJS(extension_entry_exports);
})();
