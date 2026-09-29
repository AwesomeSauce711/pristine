'use strict';
/**
 * inject.js — runs in the PAGE world at document_start, before TikTok's own
 * scripts, so it can wrap the APIs they would use.
 *
 * What this is actually for:
 *   A browser extension can only stop compression that happens IN the browser.
 *   If the page hands your file's original bytes to the network untouched, then
 *   all the compression is server-side and no extension can reach it.
 *   So the job here is to measure which of those two is true, by:
 *     1. recording the exact size of the file you picked, and
 *     2. counting the bytes actually put on the wire.
 *   If bytes-sent >= file size, your original was uploaded verbatim and there
 *   was never any client-side compression to bypass.
 *
 * It also watches the APIs a page WOULD have to use to re-encode video in the
 * browser (WebCodecs, MediaRecorder, canvas capture). If any of them touch
 * video while an upload is staged, that is real client-side compression — and
 * guard mode will break it rather than let it run.
 */

(() => {
  if (window.__tthdInstalled) return;
  window.__tthdInstalled = true;

  const state = {
    file: null,          // { name, size, type }
    bytesSent: 0,        // bytes pushed to the network in large bodies
    bytesFromBodies: 0,  // counted from request bodies
    bytesFromStreams: 0, // counted from raw stream reads (may observe the same upload)
    diffParts: [],       // upload payload reassembled for container comparison
    diffBytes: 0,
    diffTimer: null,
    requests: 0,
    encoders: [],        // client-side encoding APIs actually invoked
    media: [],           // video URLs TikTok's own player fetched, newest last
    reqs: [],            // upload-related requests, credentials redacted
    ladder: [],          // TikTok's own declared renditions, from bitrateInfo
    pageVideo: null,     // direct measurement of the video playing on this page
    // The video on screen right now, sampled continuously. Distinct from
    // pageVideo, which is a one-shot measurement taken for a report.
    live: null,
    measuring: false,    // a measurement is in flight; result not yet valid
    measureSeq: 0,       // discards results from a superseded measurement
    ladderMeasured: null, // every rendition, measured in-page rather than probed
    ladderProgress: '',   // "3/8" while a ladder sweep runs
    originalMoov: null,  // moov box of the file as picked, before anyone touched it
    diff: null,          // byte-level differences between picked file and upload
    hookTamper: [],      // APIs re-wrapped by something after us
    // Headers on upload requests, credential-shaped values already removed.
    // Instagram's ingest parameters live here rather than in the URL or body.
    uploadHeaders: [],
    // Declared-params patch merged into X-Instagram-Rupload-Params on its way
    // out. Empty means send exactly what the page composed.
    ingestOverride: null,
    // Every application actually performed, so the report can distinguish a
    // rewrite that happened from one that was only asked for.
    ingestApplied: [],
    route: [],           // ordered trace of where the file physically went
    hostBytes: {},       // per-host request/byte totals, independent of the reqs ring
    codecs: [],          // what the decoder was actually configured with
    codecProbe: null,    // why codecs is empty, when it is
    decode: null,        // what this browser says it can decode smoothly
    sps: [],             // full sequence parameter sets, parsed
    /*
     * Which build of THIS file is running in the page.
     *
     * inject.js runs in the MAIN world at document_start. Reloading the
     * extension replaces content.js and background.js immediately, but an
     * already-open tab keeps the inject.js it was loaded with until the page
     * itself reloads. So a tab can run new panel code against an old page
     * hook, and the only symptom is a report card quietly missing — which
     * reads as 'that could not be measured' rather than 'that code is not
     * loaded'. Twice that cost a full round-trip to diagnose.
     *
     * content.js compares this against its own constant and the report says
     * so, rather than leaving it to be inferred from which cards are absent.
     */
    build: '2.8.0',
    guard: false,
  };

  try { state.guard = localStorage.getItem('__tthd_guard') === '1'; } catch (_) {}

  const BIG = 512 * 1024; // bodies under this are API chatter, not video payload

  function post(kind) {
    try {
      window.postMessage({ __tthd: true, kind, state: {
        file: state.file,
        bytesSent: state.bytesSent,
        requests: state.requests,
        encoders: state.encoders.slice(),
        media: state.media.slice(),
        reqs: state.reqs.slice(),
        ladder: state.ladder.slice(),
        diff: state.diff,
        pageVideo: state.pageVideo,
        live: state.live,
        uploadHeaders: state.uploadHeaders,
        ingestOverride: state.ingestOverride,
        ingestApplied: state.ingestApplied,
        ladderMeasured: state.ladderMeasured,
        ladderProgress: state.ladderProgress,
        measuring: state.measuring,
        hookTamper: state.hookTamper.slice(),
        route: state.route.slice(),
        hostBytes: Object.assign({}, state.hostBytes),
        codecs: state.codecs.slice(),
        codecProbe: state.codecProbe,
        decode: state.decode,
        sps: state.sps.slice(),
        build: state.build,
        hasOriginal: !!state.originalMoov,
        guard: state.guard,
        swapEnabled: swapEnabled,
        swap: state.swap || null,
      } }, '*');
    } catch (_) {}
  }

  /**
   * One leg of the file's journey. Ordered and timestamped so the report can
   * show, in sequence: what was dropped, that it went to 127.0.0.1 and not to
   * TikTok, what came back, and only then which TikTok host received it.
   */
  function logRoute(step, dest, detail) {
    state.route.push({ step, dest: dest || '', detail: detail || null, at: Date.now() });
    post('route');
  }

  function note(api, detail) {
    state.encoders.push({ api, detail: detail || '', at: Date.now() });
    post('encoder');
  }

  /* ---------------------------------------------------------- body sizing */

  function sizeOf(body) {
    if (!body) return 0;
    try {
      if (typeof body === 'string') return body.length;
      if (body instanceof Blob) return body.size;                 // File extends Blob
      if (body instanceof ArrayBuffer) return body.byteLength;
      if (ArrayBuffer.isView(body)) return body.byteLength;
      if (body instanceof FormData) {
        let n = 0;
        for (const [, v] of body.entries()) n += (v instanceof Blob) ? v.size : String(v).length;
        return n;
      }
      if (body instanceof URLSearchParams) return String(body).length;
    } catch (_) {}
    return 0;
  }

  /* ------------------------------------------------- delivered media URLs */

  // The URLs TikTok's own player pulls when it plays a video back. Probing one
  // of these is the only way to see what TikTok actually delivers, as opposed
  // to what you uploaded.
  // Must look like real user content. A bare ".mp4" match is far too loose — it
  // picks up TikTok's own bundled UI placeholder (webapp-desktop/playback1.mp4)
  // and reports it as if it were the uploaded video.
  const MEDIA_RE = /\/video\/tos\/|mime_type=video_mp4|\/aweme\/v\d|v\d{2}-webapp|tiktokcdn[^/]*\/video\//i;

  // Static frontend assets, never user media.
  const NOT_MEDIA_RE = /\/obj\/tiktok-web-tx\/|\/webapp-desktop\/|\/webapp\/main\/|\/static\/|placeholder|playback\d*\.mp4/i;

  function noteMedia(url) {
    if (!url || typeof url !== 'string') return;
    if (!/^https?:/i.test(url)) return;
    if (NOT_MEDIA_RE.test(url) || !MEDIA_RE.test(url)) return;
    // /aweme/v1/play/ is only a real rendition when it carries the ids that
    // identify one. Without them it is a bare endpoint that answers HTTP 400,
    // which showed up as a permanent failure row in every report.
    if (/\/aweme\/v\d\/play\//i.test(url) && !/[?&](video_id|file_id)=/i.test(url)) return;
    if (state.media.includes(url)) return;
    state.media.push(url);
    if (state.media.length > 24) state.media.shift();
    post('media');
  }

  /**
   * TikTok's item-detail JSON carries the whole adaptive ladder in `bitrateInfo`
   * — every rendition it can serve, not just the one the player chose. Reading
   * that is the only way to see the real top rung, since the web player will
   * happily settle on a low bandwidth-saver rung and make delivery look far
   * worse than it is.
   */
  function scanBody(text) {
    if (!text || typeof text !== 'string') return;
    if (text.length > 8e6) return;               // don't chew through huge payloads
    if (!/playAddr|bitrateInfo|UrlList|video\/tos/i.test(text)) return;
    // TikTok escapes slashes as / inside JSON strings.
    const flat = text.replace(/\\u002F/gi, '/').replace(/\\\//g, '/');

    extractLadder(flat);

    const re = /https?:\/\/[^"'\\\s]+/g;
    let m, n = 0;
    while ((m = re.exec(flat)) && n < 300) { n++; noteMedia(m[0]); }
  }

  /**
   * Pulls TikTok's own declared rendition ladder out of a `bitrateInfo` array.
   * Each entry names a gear (e.g. normal_1080_0), its bitrate and dimensions.
   * This is what TikTok *claims* it built; probing the URLs afterwards is what
   * proves whether the claim is true.
   */
  function extractLadder(text) {
    let from = 0;
    for (let guard = 0; guard < 6; guard++) {
      const key = text.indexOf('"bitrateInfo"', from);
      if (key < 0) return;
      const open = text.indexOf('[', key);
      if (open < 0) return;
      from = open + 1;

      // Walk brackets to find the matching close, ignoring those inside strings.
      let depth = 0, end = -1, inStr = false, esc = false;
      for (let i = open; i < text.length && i - open < 400000; i++) {
        const c = text[i];
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '[') depth++;
        else if (c === ']') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end < 0) continue;

      let arr = null;
      const slice = text.slice(open, end + 1);
      try { arr = JSON.parse(slice); }
      catch (_) { try { arr = JSON.parse(slice.replace(/\\"/g, '"')); } catch (_) {} }
      if (!Array.isArray(arr)) continue;

      for (const e of arr) {
        if (!e || typeof e !== 'object') continue;
        const pa = e.PlayAddr || e.play_addr || {};
        const urls = pa.UrlList || pa.url_list || [];
        const entry = {
          gear: e.GearName || e.gear_name || '',
          bitrate: Number(e.Bitrate || e.bitrate) || 0,
          declaredFps: Number(e.BitrateFPS || e.bitrate_fps) || 0,
          width: Number(pa.Width || pa.width) || 0,
          height: Number(pa.Height || pa.height) || 0,
          size: Number(pa.DataSize || pa.data_size) || 0,
          url: urls.find((u) => typeof u === 'string') || '',
        };
        if (!entry.url) continue;
        if (state.ladder.some((x) => x.gear === entry.gear && x.bitrate === entry.bitrate)) continue;
        state.ladder.push(entry);
        noteMedia(entry.url);
      }
      if (state.ladder.length) post('ladder');
    }
  }

  /* ------------------------------------------------ MP4 container diffing */

  /**
   * Walks the top-level MP4 box table to locate `moov`, reading only 16-byte
   * headers and seeking with Blob.slice — which is lazy, so this costs almost
   * nothing even on a multi-gigabyte file. `moov` is where every header field a
   * client-side validator reads lives (mvhd, mdhd, stts), so it is the only
   * region worth capturing.
   */
  async function readMoov(blob) {
    let off = 0;
    const total = blob.size;
    for (let guard = 0; guard < 4096 && off + 8 <= total; guard++) {
      const head = await blob.slice(off, off + 16).arrayBuffer();
      if (head.byteLength < 8) break;
      const dv = new DataView(head);
      let size = dv.getUint32(0);
      const type = String.fromCharCode(dv.getUint8(4), dv.getUint8(5), dv.getUint8(6), dv.getUint8(7));
      let hs = 8;
      if (size === 1) {
        if (head.byteLength < 16) break;
        size = Number(dv.getBigUint64(8)); hs = 16;
      } else if (size === 0) {
        size = total - off;
      }
      if (size < hs) break;
      if (type === 'moov') {
        const cap = Math.min(size, 48 * 1024 * 1024);
        return { offset: off, size, bytes: new Uint8Array(await blob.slice(off, off + cap).arrayBuffer()) };
      }
      off += size;
    }
    return null;
  }

  const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta', 'mvex', 'dinf']);

  /** Names the deepest box containing a byte offset, e.g. "moov/trak/mdia/mdhd +20". */
  function boxPathAt(bytes, target) {
    let best = 'unknown';
    (function walk(start, end, prefix) {
      let o = start;
      for (let guard = 0; guard < 8192 && o + 8 <= end; guard++) {
        const dv = new DataView(bytes.buffer, bytes.byteOffset + o, Math.min(16, end - o));
        let size = dv.getUint32(0);
        let hs = 8;
        const type = String.fromCharCode(dv.getUint8(4), dv.getUint8(5), dv.getUint8(6), dv.getUint8(7));
        if (size === 1 && end - o >= 16) { size = Number(dv.getBigUint64(8)); hs = 16; }
        else if (size === 0) size = end - o;
        if (size < hs) return;
        if (target >= o && target < o + size) {
          const p = prefix + '/' + type;
          best = p + ' +' + (target - o);
          if (CONTAINER_BOXES.has(type)) walk(o + hs, Math.min(o + size, end), p);
          return;
        }
        o += size;
      }
    })(0, bytes.length, '');
    return best;
  }

  const hex = (arr) => Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join(' ');

  function diffBytes(a, b) {
    const diffs = [];
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n && diffs.length < 40; i++) {
      if (a[i] === b[i]) continue;
      let j = i;
      while (j < n && a[j] !== b[j] && j - i < 24) j++;
      diffs.push({
        offset: i,
        box: boxPathAt(a, i),
        before: hex(a.slice(i, j)),
        after: hex(b.slice(i, j)),
        beforeU32: i + 4 <= a.length ? new DataView(a.buffer, a.byteOffset + i, 4).getUint32(0) : null,
        afterU32: i + 4 <= b.length ? new DataView(b.buffer, b.byteOffset + i, 4).getUint32(0) : null,
      });
      i = j;
    }
    return diffs;
  }

  /** Compare what is going on the wire against the file the user actually picked. */
  async function compareUpload(blob) {
    try {
      if (!state.originalMoov || !blob || typeof blob.slice !== 'function') return;
      if (state.diff && state.diff.done) return;               // only the first real upload

      const sent = await readMoov(blob);
      if (!sent) {
        // Chunked upload: moov may simply not have arrived yet. Only give up
        // once enough payload has accumulated that it should have appeared.
        if (state.diffBytes < 24 * 1024 * 1024 &&
            (!state.file || state.diffBytes < state.file.size)) return;
        state.diff = {
          done: true,
          note: `No moov box found in ${(state.diffBytes / 1048576).toFixed(1)} MB of uploaded payload — ` +
                `the upload is chunked or re-wrapped, so the container could not be compared directly.`,
        };
        return post('diff');
      }

      const a = state.originalMoov.bytes, b = sent.bytes;
      const diffs = diffBytes(a, b);
      state.diff = {
        done: true,
        originalSize: state.file ? state.file.size : 0,
        sentSize: blob.size,
        moovOffsetOriginal: state.originalMoov.offset,
        moovOffsetSent: sent.offset,
        moovSizeOriginal: state.originalMoov.size,
        moovSizeSent: sent.size,
        identical: diffs.length === 0 && a.length === b.length,
        diffs,
      };
      post('diff');
    } catch (e) {
      state.diff = { done: true, note: 'diff failed: ' + e.message };
      post('diff');
    }
  }

  /* ------------------------------------------- upload request inspection */

  // Endpoints involved in staging and committing an upload. Whatever controls
  // the transcode profile — if anything client-settable does — is in here.
  const UPLOAD_RE = /upload|applyupload|commit|\/aweme\/|video\/create|publish|post\/(publish|create)/i;

  // Never surface anything credential-shaped in the panel.
  const SECRET_RE = /token|sig|signature|auth|cookie|session|secuid|sec_uid|device_id|iid|odin|passport|ticket|key/i;

  function redact(v) {
    const s = String(v);
    if (s.length > 180) return s.slice(0, 50) + `…‹${s.length} chars›`;
    return s;
  }

  // Instagram's ingest header. The value is JSON, so it is decoded into pairs
  // rather than shown as one long unreadable string.
  const RUPLOAD_HDR = /^x-instagram-rupload-params$/i;
  // Headers worth keeping. Everything else on an upload request is transport
  // noise, and some of it is credentials.
  const HDR_KEEP = /^(x-instagram-|x-ig-|x-entity-|x-fb-|offset|content-type|content-length|segment-)/i;

  function decodeRupload(value) {
    try {
      const o = JSON.parse(String(value));
      if (!o || typeof o !== 'object') return null;
      return Object.keys(o).map((k) => [k, SECRET_RE.test(k) ? '‹redacted›' : redact(
        typeof o[k] === 'object' ? JSON.stringify(o[k]) : o[k])]);
    } catch (_) { return null; }
  }

  /**
   * Applies the declared-params patch to an outgoing rupload header.
   *
   * Returns the value to send, unchanged when there is nothing to apply or the
   * blob will not parse -- a header that cannot be understood is passed through
   * untouched rather than replaced with a guess.
   */
  function applyIngestOverride(value) {
    const patch = state.ingestOverride;
    if (!patch || !Object.keys(patch).length) return value;
    let o;
    try { o = JSON.parse(String(value)); } catch (_) { return value; }
    if (!o || typeof o !== 'object') return value;

    const changed = [];
    for (const k of Object.keys(patch)) {
      const before = o[k];
      const after = patch[k];
      if (String(before) === String(after)) continue;
      o[k] = after;
      changed.push({ key: k, from: before === undefined ? '‹absent›' : String(before),
                     to: String(after) });
    }
    if (!changed.length) return value;
    state.ingestApplied.push({ at: Date.now(), changed });
    post('ingest');
    return JSON.stringify(o);
  }

  function noteHeader(target, name, value) {
    try {
      if (!HDR_KEEP.test(String(name))) return;
      const safe = SECRET_RE.test(String(name)) ? '‹redacted›' : redact(value);
      const entry = { name: String(name), value: safe };
      if (RUPLOAD_HDR.test(String(name))) {
        const pairs = decodeRupload(value);
        if (pairs) entry.decoded = pairs;
      }
      (target.__tthdHeaders = target.__tthdHeaders || []).push(entry);
    } catch (_) {}
  }

  function noteRequest(url, method, body, headers) {
    try {
      if (!url || !UPLOAD_RE.test(String(url))) return;
      const u = new URL(String(url), location.href);

      const params = [];
      for (const [k, v] of u.searchParams) {
        params.push([k, SECRET_RE.test(k) ? '‹redacted›' : redact(v)]);
      }

      const bodyParams = [];
      if (body instanceof FormData) {
        for (const [k, v] of body.entries()) {
          bodyParams.push([k, v instanceof Blob
            ? `‹binary ${v.size} bytes›`
            : (SECRET_RE.test(k) ? '‹redacted›' : redact(v))]);
        }
      } else if (typeof body === 'string' && body.length < 20000) {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (_) {}
        if (parsed && typeof parsed === 'object') {
          for (const k of Object.keys(parsed)) {
            bodyParams.push([k, SECRET_RE.test(k) ? '‹redacted›' : redact(
              typeof parsed[k] === 'object' ? JSON.stringify(parsed[k]) : parsed[k])]);
          }
        } else {
          bodyParams.push(['(raw)', redact(body)]);
        }
      } else if (body instanceof Blob) {
        bodyParams.push(['(binary)', `‹${body.size} bytes›`]);
      }

      // A large upload sends ~40 binary chunk POSTs to one host. A single FIFO
      // ring of 40 therefore evicted every API call before the report was
      // taken — including CommitUploadInner, which is the only request that
      // could plausibly carry a client-declared duration. Prune the two classes
      // separately so the API calls always survive the chunk storm.
      const binary = bodyParams.some(([k]) => k === '(binary)');
      const hdrs = Array.isArray(headers) ? headers : [];
      state.reqs.push({ url: u.origin + u.pathname, method: method || 'GET',
                        params, bodyParams, binary, headers: hdrs });

      // Kept separately as well. The reqs ring is pruned for display, and the
      // ingest parameters are the one thing that must survive that pruning --
      // they are the whole reason this is being recorded.
      const ing = hdrs.filter((h) => RUPLOAD_HDR.test(h.name) && h.decoded);
      if (ing.length) {
        state.uploadHeaders.push({ url: u.origin + u.pathname, at: Date.now(), params: ing[0].decoded });
        if (state.uploadHeaders.length > 8) state.uploadHeaders.shift();
        post('ingest');
      }

      // Per-host totals are accumulated here rather than derived from the reqs
      // ring, so pruning the ring for display cannot change the byte accounting
      // the route card reports.
      {
        const h = state.hostBytes[u.hostname] || (state.hostBytes[u.hostname] = { n: 0, bytes: 0 });
        h.n++;
        for (const [k, v] of bodyParams) {
          if (k !== '(binary)') continue;
          const m = /(\d[\d,]*)/.exec(String(v));
          if (m) h.bytes += Number(m[1].replace(/,/g, '')) || 0;
        }
      }

      const dropOldest = (pred, keep) => {
        let n = state.reqs.reduce((a, r) => a + (pred(r) ? 1 : 0), 0);
        while (n > keep) {
          const i = state.reqs.findIndex(pred);
          if (i < 0) break;
          state.reqs.splice(i, 1);
          n--;
        }
      };
      // Chunks are interchangeable — a handful is enough to prove the route and
      // count the bytes. API calls are each unique and worth keeping.
      dropOldest((r) => r.binary, 8);
      dropOldest((r) => !r.binary, 60);
      post('req');
    } catch (_) {}
  }

  function record(url, body) {
    // Nothing to attribute bytes to until the user has actually picked a file.
    // TikTok's page fires telemetry and asset POSTs on load, and counting those
    // showed "Bytes uploaded 1.0 MB" before any video was chosen — misleading
    // and wrong. Gate on a staged file.
    if (!state.file) return;
    const n = sizeOf(body);
    if (n < BIG) {
      // Even small parts matter for reassembling the container.
      if (n > 0) collectForDiff(body);
      return;
    }
    // Request bodies and raw stream reads can both observe the same upload, so
    // track them separately and report the larger rather than the sum —
    // otherwise a streamed upload double-counts and reads over 100% of source.
    state.bytesFromBodies += n;
    state.bytesSent = Math.max(state.bytesFromBodies, state.bytesFromStreams);
    state.requests++;
    post('bytes');
    collectForDiff(body);
  }

  /**
   * Accumulates whatever the page is actually putting on the wire so the
   * container can be reassembled and compared. TikTok's uploader chunks the
   * file and may hand over ArrayBuffers rather than Blobs, so a Blob-only
   * check misses the upload entirely.
   */
  function collectForDiff(body) {
    if (state.diff || !state.originalMoov) return;
    if (state.diffBytes > 32 * 1024 * 1024) return;

    let part = null;
    if (body instanceof Blob) part = body;
    else if (body instanceof ArrayBuffer) part = new Blob([body]);
    else if (ArrayBuffer.isView(body)) part = new Blob([body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)]);
    else if (body instanceof FormData) {
      for (const [, v] of body.entries()) if (v instanceof Blob) { part = v; break; }
    }
    if (!part || !part.size) return;

    state.diffParts.push(part);
    state.diffBytes += part.size;

    clearTimeout(state.diffTimer);
    state.diffTimer = setTimeout(() => {
      compareUpload(new Blob(state.diffParts)).catch(() => {});
    }, 700);
  }

  /* -------------------------------------------- intercept-and-swap upload */

  /**
   * Route the picked file through the local transcoder before TikTok sees it.
   *
   * This is the same mechanism the paid "Editing Enhancer" uses, reconstructed
   * from its bundle: a capture-phase listener on the file input, stop the
   * event so TikTok's own handler never fires on the original, process the
   * file, then rebuild `input.files` via DataTransfer and re-dispatch a
   * synthetic change event (with a guard so our own listener ignores the
   * replay). TikTok's handler then runs on the replacement.
   *
   * Theirs ships the file to v2.editingnews.com (50 MB free / 90 MB paid);
   * this ships it to http://localhost:7654 and your own GPU, with no cap.
   */
  let swapEnabled = false;
  let swapBusy = false;
  let ignoreNextChange = false;   // the re-entrancy guard

  // Deliberately NOT restored from localStorage. An earlier version did, and a
  // single toggle-on then silently re-armed on every later page load — and
  // swallowed the very first file pick before our own detection saw it. The
  // panel (content.js) owns the remembered preference and re-sends it via the
  // 'swap' command on each load; the page-world copy always starts off.

  function isVideoFile(f) {
    return f && (String(f.type || '').startsWith('video/') || /\.(mp4|mov|m4v|mkv|webm|avi)$/i.test(f.name || ''));
  }

  function setSwapStatus(s) { state.swap = s; post('swap'); }

  /**
   * Hand the file to the extension's service worker for transcoding.
   *
   * This used to XHR straight to localhost from here — the page world — and
   * every attempt died silently: a public-HTTPS page reaching http://localhost
   * is blocked by the browser before any request leaves (the server log never
   * saw a single hit). The service worker has its own host_permissions and is
   * exempt from the page's rules, so the request goes page -> content.js ->
   * background.js -> localhost. Same relay the paid extension uses.
   */
  async function processLocally(file) {
    setSwapStatus({ phase: 'working', pct: 0, note: '' });
    const opts = state.swapOptions || {};
    const id = 'p' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    const bytes = await file.arrayBuffer();
    setSwapStatus({ phase: 'working', pct: 3, note: '' });

    const res = await new Promise((resolve, reject) => {
      const onMsg = (e) => {
        const d = e.data;
        if (!d || !d.__tthd || d.id !== id) return;
        if (d.kind === 'processProgress') {
          setSwapStatus({ phase: d.phase, pct: d.pct, note: d.note });
          return;
        }
        if (d.kind === 'processResult') {
          window.removeEventListener('message', onMsg);
          clearTimeout(timer);
          if (!d.ok) return reject(new Error(d.error || 'transcode failed'));
          resolve(d);
        }
      };
      window.addEventListener('message', onMsg);
      // Generous ceiling: a long 4K file on CPU can take minutes.
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        reject(new Error('transcode timed out after 20 minutes'));
      }, 20 * 60 * 1000);

      // Transfer the buffer (not copy) — it's only needed once.
      logRoute('sent-to-local-transcoder', 'http://127.0.0.1:7654/api/process', {
        name: file.name, size: file.size, bytes: bytes.byteLength,
      });
      window.postMessage({ __tthdCmd: true, cmd: 'process', id, name: file.name, options: opts, bytes }, '*', [bytes]);
    });

    const info = res.info || {};
    logRoute('returned-from-local-transcoder', 'http://127.0.0.1:7654/api/process', {
      name: res.name || file.name,
      size: (res.bytes && res.bytes.byteLength) || 0,
      width: info.width, height: info.height, fps: info.fps,
      frames: info.frames, encoder: info.encoder || '', ms: info.ms || 0,
      ghost: info.ghost || null,
    });
    setSwapStatus({ phase: 'done', pct: 100, note: `${info.width}×${info.height} · ${info.fps}fps`, out: info });
    return new File([res.bytes], res.name || file.name, { type: 'video/mp4', lastModified: Date.now() });
  }

  /**
   * Patch the file in this tab and hand it straight back. No server involved.
   *
   * This is the phantom-sample method: a decoy audio track is given roughly ten
   * times the samples it really has, which makes TikTok skip its re-encode and
   * serve the upload untouched. See docs/phantom-sample-method.md.
   *
   * Unlike processLocally it does not transcode, so the picture is bit-identical
   * to what the user chose and there is nothing to wait for — a 222 MB file is
   * patched in about 40 ms. The media payload is never read into memory: the
   * replacement File is assembled from a Blob slice of the original, which the
   * browser keeps as a reference to those bytes rather than a copy.
   */
  async function processPhantom(file) {
    const method = (state.swapOptions || {}).method;
    const single = ['single', 'single-mobile', 'separate-audio'].includes(method);
    const P = single ? window.PristineUpload : window.__tthdMp4Patch;
    if (!P) throw new Error('mp4patch.js did not load — reload the extension');

    setSwapStatus({ phase: 'working', pct: 10, note: 'patching container' });
    logRoute('patching-in-browser', 'this tab — no upload, no server', {
      name: file.name, size: file.size,
    });

    const t0 = Date.now();
    const opts = state.swapOptions || {};
    const r = await P.patchFile(file, { multiplier: Number(opts.phantomX) || 10, mobile: method === 'single-mobile', separateAudio: method === 'separate-audio', auto: method === 'single' });
    const ms = Date.now() - t0;

    /*
     * The edit-list line is not cosmetic. An inherited elst on the decoy clamps
     * the phantom ticks straight back out of the presented timeline and TikTok
     * re-encodes the upload — a patched-looking file that silently does nothing.
     * Saying which files needed that fix is the only way to tell the two apart
     * after the fact.
     */
    const note = r.alreadyPrepared ? 'Already prepared — video passed through unchanged' : r.real + ' + ' + r.phantom + ' added audio samples; original video frames preserved' +
      (r.clonedTrack ? ', decoy track added' : '') +
      (r.neutralisedEdts ? ', decoy edit list neutralised' : '') +
      (r.movedMoov ? ', moov moved to front' : '');
    logRoute('patched', 'this tab', {
      name: r.file.name, size: r.file.size, ms,
      real: r.real, phantom: r.phantom,
      clonedTrack: r.clonedTrack, movedMoov: r.movedMoov,
      neutralisedEdts: r.neutralisedEdts,
      fillerBytes: r.fillerBytes,
    });
    setSwapStatus({ phase: 'done', pct: 100, note, out: {
      phantom: true, real: r.real, phantoms: r.phantom, ms,
      clonedTrack: r.clonedTrack, movedMoov: r.movedMoov,
      neutralisedEdts: r.neutralisedEdts,
    } });
    return r.file;
  }

  async function interceptFile(original, input) {
    swapBusy = true;
    state.route = [];
    logRoute('picked', 'browser', {
      name: original.name, size: original.size, type: original.type,
    });
    try {
      // 'phantom' is handled entirely in this tab; every other method still
      // goes out to the local transcoder.
      const usePhantom = ['phantom', 'single', 'single-mobile', 'separate-audio'].includes((state.swapOptions || {}).method);
      let replacement = null;
      try { replacement = usePhantom ? await processPhantom(original) : await processLocally(original); }
      catch (e) {
        // Do NOT fall back to the original. The old behaviour — swallow the
        // error and hand TikTok the untouched file — is exactly how three
        // rounds of "it went straight to TikTok" hid the real failure, and it
        // made the progress overlay flash for a split second before TikTok's
        // page took over. If the user asked for a transcode and it failed, the
        // only honest outcome is to STOP, keep the page where it is, and show
        // the error. They can untick the toggle to upload the original.
        setSwapStatus({ phase: 'error', pct: 0, note: String(e.message) });
        return;
      }

      const target = input && input.isConnected ? input : document.querySelector('input[type="file"]');
      if (!target) {
        setSwapStatus({ phase: 'error', pct: 0, note: 'transcode succeeded but TikTok\'s file input disappeared — reload the page and try again' });
        return;
      }

      // Sanity: the replacement must be a real, non-empty video before we hand
      // it to TikTok. A zero-byte or tiny file means something upstream lied.
      if (!replacement || !replacement.size || replacement.size < 1024) {
        setSwapStatus({ phase: 'error', pct: 0, note: `transcoder returned an invalid file (${replacement ? replacement.size : 0} bytes) — not handing it to TikTok` });
        return;
      }

      const dt = new DataTransfer();
      dt.items.add(replacement);
      target.files = dt.files;
      logRoute('swapped-into-input', location.hostname + ' upload form', {
        name: replacement.name, size: replacement.size,
      });

      // Record what actually went in, so the panel's byte accounting is right.
      const f = target.files[0];
      if (f) takeOriginal(f);

      ignoreNextChange = true;
      target.dispatchEvent(new Event('change', { bubbles: true }));
    } finally {
      swapBusy = false;
    }
  }

  window.addEventListener('change', (e) => {
    if (ignoreNextChange) { ignoreNextChange = false; return; }
    if (!swapEnabled || swapBusy) return;
    const t = e.target;
    if (!t || t.tagName !== 'INPUT' || t.type !== 'file' || !t.files || !t.files.length) return;
    const f = t.files[0];
    if (!isVideoFile(f)) return;
    // Record the ORIGINAL pick first. We're about to swallow this event, so
    // the bubble-phase detection in takeOriginal would otherwise never see it
    // and file name / size / byte accounting would all be missing.
    takeOriginal(f);
    // Ours runs in the capture phase, before TikTok's handler. Stop it here.
    e.stopImmediatePropagation();
    interceptFile(f, t);
  }, true);

  // Drag-and-drop is a separate event path that never touches the file input's
  // change event. The first real test dropped a file and it sailed straight
  // past the change listener into TikTok untouched — so this MUST be hooked
  // too. Their extension hooks both; so do we. preventDefault stops the
  // browser navigating to the dropped file; stopImmediatePropagation stops
  // TikTok's own drop handler from ever seeing the original.
  window.addEventListener('drop', (e) => {
    if (!swapEnabled || swapBusy) return;
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    const f = files[0];
    if (!isVideoFile(f)) return;
    takeOriginal(f);
    e.preventDefault();
    e.stopImmediatePropagation();
    // Hand the result to the page's file input — that is the one channel
    // TikTok reliably consumes, whether the user dropped or clicked.
    const input = document.querySelector('input[type="file"]');
    interceptFile(f, input);
  }, true);

  /* ------------------------------------------------------- file selection */

  // Catch the file the moment it is chosen, however it is chosen.
  /**
   * Reads duration and dimensions off the picked file. Without this there is
   * nothing to correlate a delivered rendition against, and the report will
   * confidently measure whatever unrelated video the page happened to load.
   */
  function measureSource(f) {
    (async () => {
      if (typeof window.inspectMp4Sample !== 'function') return;
      const cap = 4 * 1024 * 1024;
      const head = new Uint8Array(await f.slice(0, cap).arrayBuffer());
      let info = window.inspectMp4Sample(head, f.size);
      if (!info && f.size > cap) {
        const tail = new Uint8Array(await f.slice(-cap).arrayBuffer());
        info = window.inspectMp4Sample(tail, f.size);
      }
      if (info && state.file && state.file.name === f.name && state.file.size === f.size) {
        state.file.container = info;
        post('file');
      }
    })().catch(() => {});
    try {
      const url = _createObjectURL.call(URL, f);
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      v.onloadedmetadata = () => {
        if (state.file && state.file.name === f.name) {
          state.file.duration = v.duration;
          state.file.width = v.videoWidth;
          state.file.height = v.videoHeight;
          post('file');
        }
        try { URL.revokeObjectURL(url); } catch (_) {}
      };
      v.onerror = () => { try { URL.revokeObjectURL(url); } catch (_) {} };
      v.src = url;
    } catch (_) {}
  }

  function takeOriginal(f) {
    if (!f) return;
    /*
     * An upload starts here, so the hooks that only matter during one are
     * installed here — and nowhere else. Outside an upload this extension
     * replaces no network function at all, which is what keeps it out of the
     * call stack of TikTok's own blocked telemetry.
     *
     * send() needs no installer: open() attaches a per-request wrapper for as
     * long as state.file is set, which begins on the next line.
     */
    watchFetch();
    watchStreams();
    watchEncoders();
    state.file = { name: f.name, size: f.size, type: f.type };
    measureSource(f);
    state.bytesSent = 0; state.bytesFromBodies = 0; state.bytesFromStreams = 0;
    state.requests = 0;
    state.originalMoov = null; state.diff = null;
    state.diffParts = []; state.diffBytes = 0; clearTimeout(state.diffTimer);
    post('file');
    // Snapshot the pristine container before anything else can rewrite it.
    readMoov(f).then((m) => { state.originalMoov = m; post('file'); }).catch(() => {});
  }

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || t.tagName !== 'INPUT' || t.type !== 'file') return;
    takeOriginal(t.files && t.files[0]);
  }, true);

  document.addEventListener('drop', (e) => {
    takeOriginal(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
  }, true);

  /* ------------------------------------------------------------ transport */

  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__tthdUrl = u;
    this.__tthdMethod = m;
    try { noteMedia(String(u)); } catch (_) {}
    /*
     * Wrap send on THIS REQUEST, not on the prototype.
     *
     * A prototype-level wrapper puts an inject.js frame in the call stack of
     * every XHR the page makes. TikTok's own telemetry posts to
     * mon.tiktokv.com, which TikTok's own connect-src forbids, so those
     * requests are blocked — and because our frame is on the stack, Chrome
     * files the violation against this extension. The result is a wall of
     * errors in the extension list that we did not cause and cannot prevent,
     * on pages with no upload at all. An earlier fix deferred the wrapping
     * until a file was picked, which helped but still caught every telemetry
     * request for the rest of that page's life.
     *
     * Attaching an own-property send only to requests we actually account
     * for removes us from every other request's stack permanently. Nothing
     * about the accounting changes: the same requests are recorded, because
     * record() was already gated on a staged file.
     */
    try {
      if (state.file) {
        this.send = function (body) {
          record(this.__tthdUrl, body);
          noteRequest(this.__tthdUrl, this.__tthdMethod, body, this.__tthdHeaders);
          return _send.apply(this, arguments);
        };
        /*
         * setRequestHeader gets the same treatment, for the same reason. It
         * was left on the prototype when send came off — four lines apart, in
         * the same block — so an inject.js frame still sat in the stack of
         * every header the page set on every request, including the telemetry
         * ones that are always blocked.
         */
        this.setRequestHeader = function (name, value) {
          let out = value;
          try {
            if (this.__tthdUrl && UPLOAD_RE.test(String(this.__tthdUrl))) {
              if (RUPLOAD_HDR.test(String(name))) out = applyIngestOverride(value);
              noteHeader(this, name, out);
            }
          } catch (_) {}
          return _setHeader.call(this, name, out);
        };
      }
    } catch (_) {}
    try {
      this.addEventListener('load', function () {
        try {
          const ct = this.getResponseHeader('content-type') || '';
          if (/json|text/i.test(ct) && (this.responseType === '' || this.responseType === 'text')) {
            scanBody(this.responseText);
          }
        } catch (_) {}
      });
    } catch (_) {}
    return _open.apply(this, arguments);
  };
  // setRequestHeader is where Instagram's ingest parameters are composed, so it
  // is both the place to read them and the last place to change them. The
  // original is captured here; the wrapper is attached per request in open().
  const _setHeader = XMLHttpRequest.prototype.setRequestHeader;

  /*
   * XMLHttpRequest.prototype.send is deliberately NOT wrapped here.
   * See the per-request wrapper installed in open() above for why.
   */

  const _fetch = window.fetch;
  /*
   * Wrapped ONLY while an upload is staged — never at page load.
   *
   * Same reasoning as the per-request send wrapper above. A global
   * window.fetch replacement puts an inject.js frame in the call stack of
   * every fetch the page makes, so when TikTok's telemetry to mon.tiktokv.com
   * is blocked by TikTok's own connect-src, Chrome files the violation against
   * this extension. Fixing that for XHR while leaving fetch patched would have
   * moved the errors rather than removed them.
   *
   * What this hook is FOR — byte accounting, the upload request log, the
   * ingest header rewrite — only exists during an upload. What it was also
   * doing incidentally, discovering rendition URLs and the bitrate ladder from
   * response bodies, is now done without hooking anything: see scanEmbedded()
   * and the PerformanceObserver below.
   */
  const ourFetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const body = (init && init.body) || (input && input.body);
      noteMedia(url);
      record(url, body);

      // Instagram's uploader has used both transports across builds, so the
      // header work has to happen on this path too or a rewrite silently
      // applies to only half the uploads.
      const bag = { __tthdHeaders: null };
      if (UPLOAD_RE.test(String(url))) {
        const h = (init && init.headers) || (input && input.headers);
        const each = (k, v) => {
          let out = v;
          if (RUPLOAD_HDR.test(String(k))) {
            out = applyIngestOverride(v);
            if (out !== v) {
              // Write the rewritten value back, or the capture would report a
              // change that never reached the wire.
              if (h instanceof Headers) h.set(k, out);
              else if (h && typeof h === 'object') h[k] = out;
            }
          }
          noteHeader(bag, k, out);
        };
        try {
          if (h instanceof Headers) [...h.entries()].forEach(([k, v]) => each(k, v));
          else if (Array.isArray(h)) h.forEach(([k, v]) => each(k, v));
          else if (h && typeof h === 'object') Object.keys(h).forEach((k) => each(k, h[k]));
        } catch (_) {}
      }
      noteRequest(url, (init && init.method) || (input && input.method) || 'GET',
                  body, bag.__tthdHeaders);
    } catch (_) {}
    return _fetch.apply(this, arguments).then((resp) => {
      try {
        const ct = (resp.headers && resp.headers.get('content-type')) || '';
        if (/json|text/i.test(ct)) resp.clone().text().then(scanBody).catch(() => {});
      } catch (_) {}
      return resp;
    });
  };
  let fetchWrapped = false;
  /*
   * Installed on file pick, and given back on navigation.
   *
   * Deferring the patch until an upload starts was only half the fix: nothing
   * ever restored it, and TikTok is a single-page app, so one file pick left
   * an inject.js frame in every request's stack for the rest of the tab's
   * life. Restoring on navigation bounds it to the upload it was taken for.
   */
  function watchFetch() {
    if (fetchWrapped) return;
    window.fetch = ourFetch;
    fetchWrapped = true;
    /*
     * Re-baseline the tamper detector. It snapshots window.fetch at load to
     * notice a THIRD party replacing it; installing our own wrapper later
     * would otherwise be reported as somebody tampering with the page.
     * Guarded because `mine` is declared further down the file.
     */
    try { mine['window.fetch'] = ourFetch; } catch (_) {}
  }

  /*
   * Rendition discovery that hooks nothing.
   *
   * The fetch wrapper used to find the ladder by reading every JSON response
   * that went past. That worked, but it is not worth being in the stack of
   * every request on the page for. Two replacements, both passive:
   *
   *   - TikTok embeds the whole item — including video.bitrateInfo, which IS
   *     the ladder — in a script tag in the served HTML. Reading the DOM costs
   *     nothing and cannot appear in anyone's stack.
   *   - PerformanceObserver reports every resource the page loads, by URL,
   *     after the fact. buffered:true also hands over the ones that finished
   *     before this ran.
   *
   * XHR responses are still read, via the load listener attached in open() —
   * a listener is not on the request's stack, so it was never part of this
   * problem.
   */
  function scanEmbedded() {
    try {
      for (const id of ['__UNIVERSAL_DATA_FOR_REHYDRATION__', 'SIGI_STATE']) {
        const el = document.getElementById(id);
        if (el && el.textContent) scanBody(el.textContent);
      }
    } catch (_) {}
  }

  /*
   * Read fetch response bodies WITHOUT being in the fetch call's stack.
   *
   * Unhooking window.fetch removes us from every blocked request's stack, but
   * it also removed the one useful thing that hook did outside an upload:
   * reading TikTok's item-detail JSON, which is where the bitrate ladder comes
   * from. On a single-page navigation that JSON arrives by fetch and is not in
   * the embedded script tag, so scanEmbedded() alone would lose the ladder for
   * every video after the first.
   *
   * Response.prototype.json and .text run AFTER a request has already
   * succeeded. A request blocked by CSP rejects before any Response exists, so
   * these can never appear in the stack of a failure — which is the entire
   * property that made the fetch hook a problem. Same data, none of the blame.
   */
  for (const m of ['json', 'text']) {
    const orig = window.Response && Response.prototype[m];
    if (!orig) continue;
    Response.prototype[m] = function () {
      const p = orig.apply(this, arguments);
      try {
        p.then((v) => {
          try {
            if (typeof v === 'string') scanBody(v);
            // Re-serialising a parsed body is only worth it for objects that
            // could plausibly hold a ladder; scanBody bails on anything else
            // almost immediately anyway.
            else if (v && typeof v === 'object') scanBody(JSON.stringify(v));
          } catch (_) {}
        }, () => {});
      } catch (_) {}
      return p;
    };
  }

  if (window.PerformanceObserver) {
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          try { noteMedia(e.name); } catch (_) {}
        }
      }).observe({ type: 'resource', buffered: true });
    } catch (_) {}
  }

  /*
   * TikTok is a single-page app: navigating between videos never reloads, so
   * every rendition URL seen since the tab opened stayed in state. A report on
   * one video then listed rungs belonging to four others, and the strongest-
   * looking row — often an old ghost-patched post — sat at the top being read
   * as the verdict.
   *
   * A change of video id is a change of subject. Drop what belonged to the last
   * one rather than carrying it forward and filtering it out later.
   */
  const videoId = () => {
    const p = location.pathname;
    const i = p.indexOf('/video/');
    return i < 0 ? p : p.slice(i + 7).split('/')[0];
  };
  let lastVideo = videoId();
  /*
   * Hand back everything that was only borrowed for an upload.
   *
   * Called on navigation, which is the natural end of an upload's life: by
   * the time the video id changes the bytes have been counted and the diff
   * has been taken. Leaving the patches in place past that point is what made
   * 'defer until a file is picked' an incomplete fix.
   */
  function restoreUploadHooks() {
    try {
      if (fetchWrapped) {
        window.fetch = _fetch;
        fetchWrapped = false;
        try { mine['window.fetch'] = _fetch; } catch (_) {}
      }
      if (streamsWrapped && _rsGetReader) {
        ReadableStream.prototype.getReader = _rsGetReader;
        streamsWrapped = false;
      }
    } catch (_) {}
  }

  setInterval(() => {
    const now = videoId();
    if (now === lastVideo) return;
    lastVideo = now;
    restoreUploadHooks();
    state.ladder = [];
    state.media = [];
    state.ladderProbed = null;
    state.ladderMeasured = null;
    state.live = null;
    post('nav');
    // The new video's ladder is already in the page. Read it immediately
    // rather than waiting for the next sweep.
    scanEmbedded();
  }, 1000);

  // The player often sets a plain src on a <video> rather than fetching it, so
  // sweep the DOM too. Cheap, and it catches what the network hooks miss.
  setInterval(() => {
    try {
      for (const v of document.querySelectorAll('video')) {
        if (v.currentSrc) noteMedia(v.currentSrc);
        if (v.src) noteMedia(v.src);
      }
    } catch (_) {}
    // The ladder is in the page's own embedded JSON. Re-read it here as well
    // as on navigation: a single-page app rewrites that script tag in place.
    scanEmbedded();
  }, 2000);

  /*
   * Chunked uploads sometimes stream through a ReadableStream instead.
   *
   * Installed lazily for the same reason as fetch and send: patching
   * ReadableStream.prototype.getReader at load time puts us in the stack of
   * every streamed response the page reads, and the accounting it feeds is
   * meaningless outside an upload — the counter it increments is already
   * gated on state.file.
   */
  let streamsWrapped = false;
  const _rsGetReader = window.ReadableStream && ReadableStream.prototype.getReader;
  function watchStreams() {
    if (streamsWrapped || !window.ReadableStream) return;
    streamsWrapped = true;
    ReadableStream.prototype.getReader = function () {
      const reader = _rsGetReader.apply(this, arguments);
      const _read = reader.read;
      reader.read = function () {
        return _read.apply(this, arguments).then((r) => {
          if (state.file && r && r.value && r.value.byteLength >= BIG) {
            state.bytesFromStreams += r.value.byteLength;
            state.bytesSent = Math.max(state.bytesFromBodies, state.bytesFromStreams);
            post('bytes');
          }
          return r;
        });
      };
      return reader;
    };
  }

  /*
   * What codec the player was actually handed.
   *
   * TikTok streams its high rungs through MediaSource, so currentSrc is a blob
   * and the rendition URL never appears — every server-side probe of another
   * creator's 4K/120 video returned 403, leaving the codec unknown. Which meant
   * two days of reasoning about whether their file was H.264 level 6.0 or HEVC
   * from how it behaved on weak phones, which is not evidence.
   *
   * addSourceBuffer() is handed the answer directly. The codec string carries
   * profile AND level: avc1.640034 is H.264 High at level 0x34 = 52,
   * avc1.64003C is level 60, hvc1.1.6.L156 is HEVC level 156/30 = 5.2. That is
   * exactly the field we could not otherwise see.
   */
  /*
   * Read the codec from the BYTES, not from the mime string.
   *
   * addSourceBuffer's type argument is what the player asked for and is the
   * easy read, but it does not always fire where we can see it — a player may
   * use ManagedMediaSource, or buffer inside a worker. The init segment cannot
   * hide: it carries the real avcC or hvcC box, and those carry profile and
   * level as fixed bytes.
   *
   *   avcC body: [0] version [1] profile_idc [2] compat [3] level_idc
   *   hvcC body: [0] version [1] tier/profile [2..5] compat [6..11] constraints
   *              [12] general_level_idc     (level = idc / 30)
   */
  function readCodecBytes(buf) {
    try {
      const b = buf instanceof ArrayBuffer ? new Uint8Array(buf)
        : (ArrayBuffer.isView(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : null);
      if (!b || b.length < 32) return false;
      const limit = b.length - 24;
      // The four ASCII bytes alone are not proof: a media segment is
      // compressed picture data and will contain them by chance. A real box
      // carries a plausible size immediately before the name, and its first
      // body byte is configurationVersion == 1.
      // ver is the expected first body byte. avcC and hvcC both start with
      // configurationVersion 1; av1C starts with a marker bit set alongside
      // its version, so 0x81.
      const boxOk = (i, min, ver) => {
        if (i < 4) return false;
        const size = (b[i - 4] << 24 | b[i - 3] << 16 | b[i - 2] << 8 | b[i - 1]) >>> 0;
        return size >= min && size <= 4096 && b[i + 4] === ver;
      };
      for (let i = 0; i < limit; i++) {
        const a = b[i], c = b[i + 1], d2 = b[i + 2], e = b[i + 3];
        // 'avcC'
        if (a === 0x61 && c === 0x76 && d2 === 0x63 && e === 0x43 && boxOk(i, 15, 1)) {
          const prof = b[i + 5], lvl = b[i + 7];
          // level_idc 0 is not a level. A row reading 'level 0.0' appeared in a
          // real report, which means either a byte run that passed the box test
          // by chance or a box carrying nothing useful. Either way it is not an
          // answer, and printing it as one is worse than printing nothing —
          // keep scanning for a box that does declare something.
          if (lvl < 10 || lvl > 255) continue;
          const name = { 66: 'Baseline', 77: 'Main', 100: 'High' }[prof] || ('profile ' + prof);
          noteCodec('H.264 ' + name + ' @ level ' + (lvl / 10).toFixed(1) +
                    '  (avcC profile_idc=' + prof + ', level_idc=' + lvl + ')');
          /*
           * avcC body: [4] lengthSizeMinusOne, [5] numOfSequenceParameterSets
           * in the low five bits, then u16 length + NAL for each. The SPS is
           * therefore already in hand — no second fetch needed.
           */
          try {
            const body = i + 4;
            const num = b[body + 5] & 0x1f;
            let p = body + 6;
            for (let k = 0; k < num && p + 2 <= b.length; k++) {
              const len = (b[p] << 8) | b[p + 1];
              p += 2;
              if (len > 4 && p + len <= b.length) noteSps(b.subarray(p, p + len), 'avcC');
              p += len;
            }
          } catch (_) {}
          return true;
        }
        // 'hvcC'
        if (a === 0x68 && c === 0x76 && d2 === 0x63 && e === 0x43 && boxOk(i, 23, 1)) {
          const lvl = b[i + 16];
          // HEVC stores level x 30, so the lowest real value is 30 (level 1.0).
          // Zero means the box declares no level; do not render it as '0.0'.
          if (lvl < 30) continue;
          // body[1] packs three fields: profile_space in bits 7-6, tier_flag in
          // bit 5, profile_idc in bits 4-0. Tier is not cosmetic — Main tier at
          // level 5.2 caps at 40 Mbps, so a 58 Mbps stream is necessarily High
          // tier, and High tier is the less widely decoded of the two.
          const tier = (b[i + 5] & 0x20) ? 'High tier' : 'Main tier';
          const pid = b[i + 5] & 0x1f;
          const pname = { 1: 'Main', 2: 'Main 10', 3: 'Main Still Picture' }[pid] || ('profile ' + pid);
          noteCodec('HEVC ' + pname + ' profile, ' + tier + ' @ level ' + (lvl / 30).toFixed(1) +
                    '  (hvcC general_level_idc=' + lvl + ')');
          return true;
        }
        // 'av1C'
        //   body[0] marker(1)+version(7)  = 0x81
        //   body[1] seq_profile(3) + seq_level_idx_0(5)
        //   body[2] seq_tier_0(1) + high_bitdepth(1) + twelve_bit(1) + ...
        //
        // AV1 numbers its levels as an index, not as the level itself:
        // X = 2 + (idx >> 2), Y = idx & 3. Index 19 is level 6.3, not 1.9.
        if (a === 0x61 && c === 0x76 && d2 === 0x31 && e === 0x43 && boxOk(i, 12, 0x81)) {
          const idx = b[i + 5] & 0x1f;
          // Indices 24..30 are reserved; 31 is the legitimate 'no level' value
          // and is handled below. Anything reserved is a misread.
          if (idx > 23 && idx !== 31) continue;
          const prof = b[i + 5] >> 5;
          const pname = { 0: 'Main', 1: 'High', 2: 'Professional' }[prof] || ('profile ' + prof);
          const tier = (b[i + 6] & 0x80) ? 'High tier' : 'Main tier';
          const depth = (b[i + 6] & 0x40) ? ((b[i + 6] & 0x20) ? 12 : 10) : 8;
          // 31 means 'maximum parameters' — the encoder declined to claim a
          // level at all, which is legal and says nothing about the content.
          const lvlText = idx === 31 ? 'no declared level'
            : 'level ' + (2 + (idx >> 2)) + '.' + (idx & 3);
          noteCodec('AV1 ' + pname + ' profile, ' + tier + ' @ ' + lvlText +
                    ', ' + depth + '-bit  (av1C seq_level_idx=' + idx + ')');
          return true;
        }
      }
      return false;
    } catch (_) { return false; }
  }
  /*
   * Named noteCodec, NOT record.
   *
   * `record(url, body)` already exists in this scope for byte accounting. A
   * second `function record` here silently replaced it for the entire IIFE,
   * because a later function declaration wins — so every send() and fetch()
   * was calling this with a URL, and bytes/requests/diff all stopped being
   * counted while state.codecs filled with request URLs. Nothing threw.
   */

  /*
   * The whole SPS, not just the level.
   *
   * Two H.264 files can both announce avc1.64003c and be nothing alike. The
   * codec string carries profile and level and stops there; the SPS carries the
   * fields a transcoder actually reads — how many reference frames the stream
   * needs, how deep the reorder buffer has to be, what frame rate it declares
   * in VUI timing, whether it constrains itself at all. When one 4K/120 upload
   * is graded into a full ladder and another gets one cheap fallback rung, the
   * difference has to be expressible somewhere, and this is the richest place
   * it could be hiding.
   *
   * The SPS is sitting inside avcC already: [5] holds the SPS count in its low
   * five bits, then each one is a u16 length followed by the NAL. So nothing
   * extra has to be fetched to read it.
   *
   * Syntax per ITU-T H.264 7.3.2.1.1 and Annex E for VUI.
   */
  function bitReader(b) {
    // Emulation prevention: 00 00 03 inside a NAL means the 03 is padding and
    // is not part of the syntax. Parsing without stripping it silently skews
    // every field after the first occurrence.
    const raw = [];
    for (let i = 0; i < b.length; i++) {
      if (i > 1 && b[i] === 3 && b[i - 1] === 0 && b[i - 2] === 0) continue;
      raw.push(b[i]);
    }
    let pos = 0;
    const bit = () => {
      const byte = raw[pos >> 3];
      if (byte === undefined) throw new Error('SPS ended early');
      const v = (byte >> (7 - (pos & 7))) & 1;
      pos++;
      return v;
    };
    const u = (n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + bit(); return v; };
    const ue = () => {
      let z = 0;
      while (bit() === 0) { z++; if (z > 32) throw new Error('bad exp-golomb'); }
      return z ? (1 << z) - 1 + u(z) : 0;
    };
    const se = () => { const k = ue(); return (k & 1) ? (k + 1) / 2 : -(k / 2); };
    return { u, ue, se, bit, left: () => raw.length * 8 - pos };
  }

  function skipScalingList(r, size) {
    let last = 8, next = 8;
    for (let j = 0; j < size; j++) {
      if (next) { next = (last + r.se() + 256) % 256; }
      last = next || last;
    }
  }

  function skipHrd(r) {
    const cpb = r.ue() + 1;
    r.u(4); r.u(4);
    for (let i = 0; i < cpb; i++) { r.ue(); r.ue(); r.bit(); }
    r.u(5); r.u(5); r.u(5); r.u(5);
  }

  function parseSps(bytes) {
    // bytes starts at the NAL header (0x67); the syntax begins after it.
    const r = bitReader(bytes.subarray ? bytes.subarray(1) : bytes.slice(1));
    const o = {};
    o.profile_idc = r.u(8);
    const c = r.u(8);
    o.constraints = [7, 6, 5, 4, 3, 2].map((b2, i) => (c >> (7 - i)) & 1).join('');
    o.level_idc = r.u(8);
    o.sps_id = r.ue();
    o.chroma_format_idc = 1;
    o.bit_depth_luma = 8;
    o.bit_depth_chroma = 8;
    o.scaling_matrix = false;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].indexOf(o.profile_idc) >= 0) {
      o.chroma_format_idc = r.ue();
      if (o.chroma_format_idc === 3) o.separate_colour_plane = r.bit();
      o.bit_depth_luma = r.ue() + 8;
      o.bit_depth_chroma = r.ue() + 8;
      o.qpprime_bypass = r.bit();
      o.scaling_matrix = !!r.bit();
      if (o.scaling_matrix) {
        const n = o.chroma_format_idc !== 3 ? 8 : 12;
        for (let i = 0; i < n; i++) if (r.bit()) skipScalingList(r, i < 6 ? 16 : 64);
      }
    }
    o.log2_max_frame_num = r.ue() + 4;
    o.pic_order_cnt_type = r.ue();
    if (o.pic_order_cnt_type === 0) {
      o.log2_max_poc_lsb = r.ue() + 4;
    } else if (o.pic_order_cnt_type === 1) {
      r.bit(); r.se(); r.se();
      const n = r.ue();
      for (let i = 0; i < n; i++) r.se();
    }
    // The two that matter most for a downstream encoder's memory planning.
    o.max_num_ref_frames = r.ue();
    o.gaps_in_frame_num_allowed = r.bit();
    const wMbs = r.ue() + 1;
    const hMapUnits = r.ue() + 1;
    o.frame_mbs_only = r.bit();
    if (!o.frame_mbs_only) o.mb_adaptive_frame_field = r.bit();
    o.direct_8x8_inference = r.bit();
    o.width = wMbs * 16;
    o.height = (2 - o.frame_mbs_only) * hMapUnits * 16;
    if (r.bit()) {
      const cl = r.ue(), cr = r.ue(), ct = r.ue(), cb = r.ue();
      // Crop units depend on chroma format and field coding.
      const sx = o.chroma_format_idc === 3 ? 1 : 2;
      const sy = (o.chroma_format_idc === 1 ? 2 : 1) * (2 - o.frame_mbs_only);
      o.width -= (cl + cr) * sx;
      o.height -= (ct + cb) * sy;
      o.cropped = true;
    }
    o.vui = null;
    if (r.bit()) {
      const v = {};
      if (r.bit()) { const idc = r.u(8); if (idc === 255) { v.sar_width = r.u(16); v.sar_height = r.u(16); } else v.aspect_ratio_idc = idc; }
      if (r.bit()) v.overscan_appropriate = r.bit();
      if (r.bit()) {
        v.video_format = r.u(3);
        v.full_range = r.bit();
        if (r.bit()) { v.colour_primaries = r.u(8); v.transfer = r.u(8); v.matrix = r.u(8); }
      }
      if (r.bit()) { v.chroma_loc_top = r.ue(); v.chroma_loc_bottom = r.ue(); }
      if (r.bit()) {
        v.num_units_in_tick = r.u(32);
        v.time_scale = r.u(32);
        v.fixed_frame_rate = r.bit();
        // Two ticks per frame for progressive: time_scale / (2 * units).
        if (v.num_units_in_tick) v.declared_fps =
          Math.round((v.time_scale / (2 * v.num_units_in_tick)) * 1000) / 1000;
      }
      const nal = r.bit(); if (nal) skipHrd(r);
      const vcl = r.bit(); if (vcl) skipHrd(r);
      v.hrd = !!(nal || vcl);
      if (nal || vcl) v.low_delay = r.bit();
      v.pic_struct_present = r.bit();
      if (r.bit()) {
        v.motion_vectors_over_pic_boundaries = r.bit();
        v.max_bytes_per_pic_denom = r.ue();
        v.max_bits_per_mb_denom = r.ue();
        v.log2_max_mv_length_horizontal = r.ue();
        v.log2_max_mv_length_vertical = r.ue();
        // How many frames a decoder must be able to hold and reorder. A
        // transcoder sizing its own DPB reads exactly this.
        v.max_num_reorder_frames = r.ue();
        v.max_dec_frame_buffering = r.ue();
        v.bitstream_restriction = true;
      }
      o.vui = v;
    }
    return o;
  }

  function noteSps(bytes, where) {
    try {
      const o = parseSps(bytes);
      o.where = where;
      const key = JSON.stringify(o);
      if (state.sps.some((x) => JSON.stringify(x) === key)) return;
      state.sps.push(o);
      if (state.sps.length > 6) state.sps.shift();
      post('sps');
    } catch (e) {
      const msg = 'SPS parse failed: ' + ((e && e.message) || e);
      if (!state.sps.some((x) => x.error === msg)) {
        state.sps.push({ error: msg, where: where });
        post('sps');
      }
    }
  }

  function noteCodec(text) {
    if (state.codecs.includes(text)) return;
    state.codecs.push(text);
    if (state.codecs.length > 12) state.codecs.shift();
    post('codecs');
  }

  if (window.SourceBuffer && SourceBuffer.prototype.appendBuffer) {
    const _append = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function (buf) {
      readCodecBytes(buf);
      return _append.apply(this, arguments);
    };
  }

  // ManagedMediaSource is the newer API and has its own prototype.
  for (const MS of [window.MediaSource, window.ManagedMediaSource]) {
    if (!MS || !MS.prototype || !MS.prototype.addSourceBuffer) continue;
    const _a = MS.prototype.addSourceBuffer;
    MS.prototype.addSourceBuffer = function (mime) {
      try { if (mime) noteCodec(String(mime)); } catch (_) {}
      return _a.apply(this, arguments);
    };
  }

  /*
   * MSE is not the only way TikTok delivers, and on this site it is not the
   * reachable one.
   *
   * The appendBuffer hook reads the init segment, which only exists when the
   * player streams through MediaSource. It fired on nothing: the player's src
   * is a blob:, so MSE IS in use, but the SourceBuffer it feeds is not on this
   * realm's prototype — a player that runs its media pipeline in a Worker gets
   * a different SourceBuffer object entirely and the main-world patch never
   * sees it.
   *
   * The bytes are still reachable another way. TikTok's item-detail JSON
   * lists the whole rendition ladder, and those urls demonstrably work: the
   * report already loads seven of eight into hidden <video> elements. Fetch
   * the front of one and the avcC / hvcC box is right there.
   *
   * This runs IN THE PAGE, so the request carries the session cookies and the
   * tiktok.com origin the service worker lacked when all eight renditions came
   * back 403. TikTok's own connect-src allows *.us.tiktok.com and
   * *.tiktokcdn*.com, so the CSP permits it.
   */
  const codecProbed = new Set();
  const codecAttempts = [];

  function noteAttempt(url, gear, note) {
    codecAttempts.push({ url: String(url).slice(0, 160), gear: gear || '', note });
    state.codecProbe = { attempts: codecAttempts.slice(-8) };
    post('codecs');
  }

  /**
   * Fetches enough of one rendition to read its avcC / hvcC box.
   *
   * 512 KB, not the whole file: the box sits in moov, moov is at the front of
   * anything faststart, and pulling 200 MB to read 150 bytes would be absurd.
   * bytes=-524288 covers the other case, a file written moov-last.
   *
   * Uncredentialed FIRST. A CDN answering `Access-Control-Allow-Origin: *`
   * refuses a credentialed request outright, so trying cookies first would fail
   * on exactly the servers most likely to work.
   */
  async function probeCodecBytes(url, gear) {
    if (!url || codecProbed.has(url)) return false;
    codecProbed.add(url);

    const ranges = [['bytes=0-524287', 'first 512 KB'], ['bytes=-524288', 'last 512 KB']];
    const modes = [['omit', 'without cookies'], ['include', 'with cookies']];

    let last = '';
    for (const m of modes) {
      for (const rg of ranges) {
        try {
          const r = await _fetch.call(window, url, {
            credentials: m[0],
            headers: { Range: rg[0] },
            referrer: location.href,
            referrerPolicy: 'unsafe-url',
            cache: 'no-store',
          });
          if (!r.ok && r.status !== 206) {
            last = 'HTTP ' + r.status + ' for the ' + rg[1] + ', ' + m[1];
            continue;
          }
          if (readCodecBytes(await r.arrayBuffer())) return true;
          last = 'read the ' + rg[1] + ' but it holds no avcC or hvcC box';
        } catch (e) {
          /*
           * fetch rejects with a bare TypeError for a CORS refusal and for a
           * dead network alike, and will not say which. On this site the
           * ambiguity is already resolved: the same urls load successfully in
           * a hidden <video>, and playing bytes needs no CORS while reading
           * them does. So a rejection here means the response carried no
           * Access-Control-Allow-Origin, not that the file is unreachable.
           */
          last = 'refused before any bytes could be read (' + m[1] + ') — the ' +
                 'response carried no Access-Control-Allow-Origin, so the page ' +
                 'may play these bytes but not read them';
        }
      }
    }
    noteAttempt(url, gear, last || 'no response');
    return false;
  }

  /*
   * Which url to ask.
   *
   * The player's own src is a blob:, so there is nothing to fetch there — and
   * the appendBuffer hook that should have covered the MSE case fired on
   * nothing, because a SourceBuffer created in a Worker is not on this realm's
   * prototype. The ladder urls out of TikTok's item-detail JSON are the way in:
   * the report already loads them into hidden <video> elements successfully,
   * so they are known-good and known-reachable with this session.
   *
   * Biggest rung first — its codec is the only one that decides anything.
   */
  let codecBusy = false;
  async function probeCodecs() {
    if (codecBusy || state.codecs.length || codecAttempts.length >= 4) return;
    codecBusy = true;
    try {
      const cands = [];
      for (const e of state.ladder || []) {
        if (e && e.url) cands.push({ url: e.url, gear: e.gear || '',
                                     px: (Number(e.width) || 0) * (Number(e.height) || 0) });
      }
      cands.sort((a, b) => b.px - a.px);
      for (const u of state.media || []) cands.push({ url: u, gear: '' });
      try {
        for (const v of document.querySelectorAll('video')) {
          const s = String(v.currentSrc || v.src || '');
          if (/^https?:/i.test(s)) cands.push({ url: s, gear: 'playing on the page' });
        }
      } catch (_) {}

      for (const c of cands) {
        if (codecProbed.has(c.url)) continue;
        if (await probeCodecBytes(c.url, c.gear)) return;
        // Four refusals from one CDN is an answer, not a reason to keep asking.
        if (codecAttempts.length >= 4) return;
      }
    } finally { codecBusy = false; }
  }

  setInterval(() => { probeCodecs().catch(() => {}); }, 3000);

  /*
   * What THIS browser says it can decode — the question an adaptive player
   * asks before it picks a rung.
   *
   * canPlayType answers 'probably' for anything the codec is registered for
   * and says nothing about size or frame rate, which is why it has never
   * explained a single demotion. mediaCapabilities.decodingInfo takes the
   * resolution, the frame rate and the bitrate, and returns three separate
   * answers: supported, smooth, powerEfficient.
   *
   * `supported: true, smooth: false` is the interesting shape. It means the
   * browser will decode the stream but expects to drop frames doing it — and
   * a player reading that has every reason to hand the viewer a smaller rung
   * instead. If one codec answers smooth here and another does not, that is a
   * concrete, local, upload-free explanation for why two 4K/120 videos behave
   * differently in the same tab on the same connection.
   *
   * Tier is testable here too: the letter in an hvc1 string is the tier, L for
   * Main and H for High, so the two can be asked separately.
   */
  const DECODE_TESTS = [
    ['H.264 High, level 5.2, 60fps',   'avc1.640034',      60],
    ['H.264 High, level 6.0, 120fps',  'avc1.64003c',     120],
    ['HEVC Main tier, level 5.2, 120fps', 'hvc1.1.6.L156.B0', 120],
    ['HEVC High tier, level 5.2, 120fps', 'hvc1.1.6.H156.B0', 120],
    ['AV1 Main tier, level 5.2, 120fps',  'av01.0.14M.08',   120],
    ['AV1 Main tier, level 5.1, 60fps',   'av01.0.13M.08',    60],
  ];

  async function probeDecode() {
    const mc = navigator.mediaCapabilities;
    if (!mc || !mc.decodingInfo) {
      state.decode = [{ label: 'navigator.mediaCapabilities is unavailable in this browser',
                        unavailable: true }];
      return post('decode');
    }
    const rows = [];
    for (const t of DECODE_TESTS) {
      const row = { label: t[0], codec: t[1] };
      try {
        // media-source, not file: TikTok streams its high rungs through MSE,
        // and the two can answer differently.
        const r = await mc.decodingInfo({
          type: 'media-source',
          video: {
            contentType: 'video/mp4; codecs="' + t[1] + '"',
            width: 2160, height: 3840,
            bitrate: 54000000,
            framerate: t[2],
          },
        });
        row.supported = !!r.supported;
        row.smooth = !!r.smooth;
        row.efficient = !!r.powerEfficient;
      } catch (e) {
        row.error = String((e && e.message) || e);
      }
      rows.push(row);
    }
    state.decode = rows;
    post('decode');
  }
  probeDecode().catch(() => {});

  /* ----------------------------------------- client-side encoding watchers */

  // WebCodecs. This is the only realistic way a page re-encodes video today.
  if (window.VideoEncoder) {
    const Orig = window.VideoEncoder;
    window.VideoEncoder = new Proxy(Orig, {
      construct(target, args) {
        note('WebCodecs VideoEncoder', 'page constructed a video encoder');
        if (state.guard) throw new Error('[TikTok Upload Inspector] VideoEncoder blocked by guard mode');
        return Reflect.construct(target, args);
      },
    });
    // isConfigSupported() is how a page feature-detects; failing it makes the
    // page fall back to uploading the original rather than re-encoding.
    if (state.guard && Orig.isConfigSupported) {
      window.VideoEncoder.isConfigSupported = () =>
        Promise.resolve({ supported: false, config: {} });
    }
  }

  if (window.MediaRecorder) {
    const Orig = window.MediaRecorder;
    window.MediaRecorder = new Proxy(Orig, {
      construct(target, args) {
        note('MediaRecorder', (args[1] && args[1].mimeType) || '');
        if (state.guard) throw new Error('[TikTok Upload Inspector] MediaRecorder blocked by guard mode');
        return Reflect.construct(target, args);
      },
    });
    window.MediaRecorder.isTypeSupported = state.guard
      ? () => false
      : Orig.isTypeSupported.bind(Orig);
  }

  /*
   * The re-encode watchers, installed only while a file is staged.
   *
   * These answer one question — did the PAGE re-encode the file before
   * uploading it — and that question only exists during an upload. Patched at
   * load they sat in the stack of every canvas export on the page, and both
   * toBlob and convertToBlob throw SecurityError on a canvas tainted by a
   * cross-origin image, which on TikTok is most of them.
   *
   * VideoEncoder and MediaRecorder are deliberately NOT moved here. A page
   * bundle can capture those constructors into a module local at load, before
   * any file is picked, and a Proxy installed later would never be seen — so
   * deferring them would trade a cosmetic problem for a real blind spot. They
   * are construct-time only and do not sit in any request's stack.
   */
  /*
   * Captured at LOAD, even though the patch is installed later.
   *
   * measureSource() calls this directly to make a blob URL for the picked
   * file, so it must exist from the start — and calling it directly is also
   * what stops our own metadata probe being recorded as page behaviour.
   */
  const _createObjectURL = URL.createObjectURL;

  let encodersWrapped = false;
  function watchEncoders() {
    if (encodersWrapped) return;
    encodersWrapped = true;
  if (window.HTMLCanvasElement) {
    const _cap = HTMLCanvasElement.prototype.captureStream;
    if (_cap) {
      HTMLCanvasElement.prototype.captureStream = function () {
        note('canvas.captureStream', this.width + 'x' + this.height);
        return _cap.apply(this, arguments);
      };
    }
    const _toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function () {
      // Only interesting at video-ish sizes; thumbnails are normal and harmless.
      if (this.width >= 640 && this.height >= 640) note('canvas.toBlob', this.width + 'x' + this.height);
      return _toBlob.apply(this, arguments);
    };
  }

  if (window.OffscreenCanvas && OffscreenCanvas.prototype.convertToBlob) {
    const _conv = OffscreenCanvas.prototype.convertToBlob;
    OffscreenCanvas.prototype.convertToBlob = function () {
      if (this.width >= 640 && this.height >= 640) note('OffscreenCanvas.convertToBlob', this.width + 'x' + this.height);
      return _conv.apply(this, arguments);
    };
  }

  // A page that re-encodes must first decode. Seeing the picked file wrapped in
  // an object URL and fed to a <video> is the tell-tale first step. The
  // original is captured at load — measureSource() calls it directly so that
  // our own probe never shows up as page behaviour.
  URL.createObjectURL = function (obj) {
    try {
      if (obj instanceof Blob && obj.type && obj.type.startsWith('video/') && obj.size >= BIG) {
        note('URL.createObjectURL', 'video blob ' + (obj.size / 1048576).toFixed(1) + ' MB');
      }
    } catch (_) {}
    return _createObjectURL.apply(this, arguments);
  };
  }

  /* ------------------------------------------ measure the video on the page */

  /**
   * Measures the video actually playing here, rather than probing TikTok's CDN.
   * The CDN URLs are session-signed and refuse server-side requests, and a page
   * often holds several videos — so asking the element itself is both more
   * reliable and unambiguous about *which* video is being reported.
   *
   * Frame rate comes from getVideoPlaybackQuality().totalVideoFrames, which
   * counts DECODED frames. That matters: requestVideoFrameCallback counts
   * PRESENTED frames, which a 60 Hz display caps at 60 regardless of the
   * content, and would report every 120 fps video as 60.
   */
  /**
   * Asks the site's own player what it thinks it is serving.
   *
   * The decoder counter above says what ARRIVED; this says what the site
   * believes it SENT. When those disagree, the gap is the decimation — and
   * naming it is the whole point of trying one method against another.
   *
   * YouTube exposes getStatsForNerds(), whose `resolution` field reads
   * "1920x1080@120 / 1920x1080@120" (current / optimal). That @-suffix is the
   * served frame rate straight from the horse's mouth. Key names have moved
   * between player builds, so every pair is kept rather than trusting one to
   * exist. Instagram publishes no equivalent, and does not need to: the
   * decoder measurement is platform-agnostic.
   */
  function readPlayerStats() {
    try {
      // Shorts does not use #movie_player, and a watch page can hold several
      // player elements of which only one is live. Take the first that both
      // exposes the stats API and actually answers with dimensions.
      const cands = [
        document.getElementById('movie_player'),
        ...document.querySelectorAll('.html5-video-player'),
        ...document.querySelectorAll('#shorts-player, ytd-reel-video-renderer .html5-video-player'),
      ].filter((el) => el && typeof el.getStatsForNerds === 'function');

      let p = null;
      for (const c of cands) {
        try {
          const st = c.getStatsForNerds() || {};
          const res = String(st.resolution || st.dims_and_frames || '');
          if (/[1-9]\d*\s*x\s*[1-9]\d*/.test(res)) { p = c; break; }
        } catch (_) {}
      }
      if (!p) p = cands[0] || null;
      if (!p || typeof p.getStatsForNerds !== 'function') return null;

      const s = p.getStatsForNerds() || {};
      const out = { site: 'youtube', raw: {} };
      for (const k of Object.keys(s)) out.raw[k] = String(s[k]).slice(0, 300);

      const res = String(s.resolution || s.dims_and_frames || '');
      out.resolution = res;
      out.codecs = String(s.codecs || '');
      out.bandwidthKbps = String(s.bandwidth_kbps || '');
      out.droppedOfTotal = String(s.dropped_frames || s.drops || '');

      // "1920x1080@120 / 1920x1080@120" -> served 120, optimal 120.
      const at = res.match(/@\s*(\d+(?:\.\d+)?)/g) || [];
      if (at.length) out.servedFps = parseFloat(at[0].replace(/[@\s]/g, ''));
      if (at.length > 1) out.optimalFps = parseFloat(at[1].replace(/[@\s]/g, ''));
      const dim = res.match(/(\d+)\s*x\s*(\d+)/);
      if (dim) { out.servedWidth = +dim[1]; out.servedHeight = +dim[2]; }

      // The itag identifies the exact rendition YouTube chose. 299/303 are the
      // 1080p high-frame-rate rungs; seeing 137/248 instead IS the decimation.
      const itag = res.match(/itag[^0-9]*(\d+)/i) ||
                   String(s.mystery_text || '').match(/itag[^0-9]*(\d+)/i);
      if (itag) out.itag = +itag[1];

      try { out.qualityLevels = (p.getAvailableQualityLevels() || []).slice(0, 12); } catch (_) {}
      try { out.quality = String(p.getPlaybackQuality() || ''); } catch (_) {}
      return out;
    } catch (_) { return null; }
  }

  /**
   * Keeps a running measurement of the video currently on screen.
   *
   * Picks the largest playing video, which on a feed is the one filling the
   * viewport. Accumulates decoded frames against media time over a rolling
   * window and resets whenever the source changes — a swipe to the next post
   * must not average two videos together.
   */
  function currentVideoCandidates() {
    // On a post permalink TikTok preloads other creators' videos alongside it.
    // Never substitute one of them when the requested post failed to decode.
    if (/tiktok\.com$/.test(location.hostname) && /\/video\/\d+/.test(location.pathname)) {
      return [...document.querySelectorAll('#media-card-0 video')];
    }
    return [...document.querySelectorAll('video')].filter(v => {
      const r = v.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
    });
  }

  (function liveLoop() {
    let src = '', frames = 0, secs = 0, pf = 0, pt = 0;

    const pick = () => {
      const vids = currentVideoCandidates()
        .filter((v) => v.videoWidth > 0 && v.readyState >= 2);
      if (!vids.length) return null;
      const playing = vids.filter((v) => !v.paused);
      const pool = playing.length ? playing : vids;
      return pool.sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight)[0];
    };

    setInterval(() => {
      try {
        const v = pick();
        if (!v || !v.getVideoPlaybackQuality) {
          if (state.live) { state.live = null; post('live'); }
          return;
        }

        const now = String(v.currentSrc || v.src || '');
        if (now !== src) {
          // A different video. Everything accumulated belongs to the old one.
          src = now; frames = 0; secs = 0;
          pf = v.getVideoPlaybackQuality().totalVideoFrames;
          pt = v.currentTime;
          state.live = { width: v.videoWidth, height: v.videoHeight, fps: 0, settling: true };
          post('live');
          return;
        }

        const nf = v.getVideoPlaybackQuality().totalVideoFrames;
        const nt = v.currentTime;
        const df = nf - pf, dt = nt - pt;
        pf = nf; pt = nt;
        // Only forward progress counts: a short clip looping mid-window would
        // otherwise report a negative interval as a frame-rate spike.
        if (dt > 0 && df >= 0) { frames += df; secs += dt; }

        // Rolling: keep the window recent so a rate change is visible rather
        // than diluted across the whole watch.
        if (secs > 6) { frames *= 0.6; secs *= 0.6; }

        const fps = secs > 0.7 ? Math.round((frames / secs) * 100) / 100 : 0;
        state.live = {
          width: v.videoWidth, height: v.videoHeight,
          fps, settling: !fps,
          duration: Number.isFinite(v.duration) ? Math.round(v.duration * 100) / 100 : 0,
        };
        post('live');
      } catch (_) {}
    }, 1000);
  })();

  async function measurePageVideo(sampleMs) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const vids = currentVideoCandidates().filter((v) => v.videoWidth > 0);
    if (!vids.length) return { error: 'The current video has not decoded. Preloaded videos are excluded.' };

    let v = vids.find((x) => !x.paused && x.readyState >= 2);
    if (!v) v = vids.sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight)[0];

    const out = {
      width: v.videoWidth,
      height: v.videoHeight,
      duration: Number.isFinite(v.duration) ? v.duration : 0,
      currentSrc: String(v.currentSrc || v.src || ''),
      videoCount: vids.length,
    };

    if (!v.getVideoPlaybackQuality) { out.error = 'getVideoPlaybackQuality unavailable'; return out; }
    if (v.paused) { try { await v.play(); } catch (_) {} }
    const initialSource = String(v.currentSrc || v.src || '');
    let presentationCallback = null, presented = 0, presentationTime = 0, previousPresentation = null;
    const onPresented = (_now, metadata) => {
      if (previousPresentation && metadata.mediaTime > previousPresentation.mediaTime) {
        presented += Math.max(0, metadata.presentedFrames - previousPresentation.presentedFrames);
        presentationTime += metadata.mediaTime - previousPresentation.mediaTime;
      }
      previousPresentation = metadata;
      presentationCallback = v.requestVideoFrameCallback(onPresented);
    };
    if (v.requestVideoFrameCallback) presentationCallback = v.requestVideoFrameCallback(onPresented);

    // Sample in small steps and accumulate only forward progress, so a short
    // clip looping mid-measurement doesn't corrupt the result.
    let frames = 0, secs = 0;
    const firstQuality = v.getVideoPlaybackQuality();
    let pf = firstQuality.totalVideoFrames, pt = v.currentTime;
    const steps = Math.max(4, Math.round((sampleMs || 4000) / 250));
    for (let i = 0; i < steps; i++) {
      await sleep(250);
      const nf = v.getVideoPlaybackQuality().totalVideoFrames, nt = v.currentTime;
      const df = nf - pf, dt = nt - pt;
      if (dt > 0 && df >= 0) { frames += df; secs += dt; }
      pf = nf; pt = nt;
    }

    out.decodedFrames = frames;
    if (presentationCallback !== null) v.cancelVideoFrameCallback(presentationCallback);
    if (String(v.currentSrc || v.src || '') !== initialSource || !v.isConnected)
      return { error: 'The selected video changed during measurement. Run the report again.' };
    out.presentedFrames = presented;
    out.presentationSeconds = presentationTime;
    out.presentedFps = presentationTime > .5 ? Math.round(presented / presentationTime * 100) / 100 : null;
    out.sampledSeconds = Math.round(secs * 1000) / 1000;
    out.measuredFps = secs > 0 ? Math.round((frames / secs) * 100) / 100 : 0;
    out.totalDecoded = pf;
    out.droppedFrames = Math.max(0, v.getVideoPlaybackQuality().droppedVideoFrames - firstQuality.droppedVideoFrames);
    if (out.duration && out.measuredFps) out.impliedTotalFrames = Math.round(out.measuredFps * out.duration);
    if (!secs) out.error = 'Video never advanced — is it playing?';

    // Read this AFTER sampling: the player's own numbers settle once playback
    // has been running, and an early read reports the startup rung.
    const ps = readPlayerStats();
    if (ps) out.player = ps;
    return out;
  }

  /* ------------------------------- measure a specific rendition, in-page */

  /**
   * Loads one rendition URL into a throwaway <video> and measures it here,
   * inside the page. TikTok's CDN URLs are session-signed and refuse
   * server-side probing, but the page already holds that session — so this
   * reaches renditions an external ffprobe cannot touch.
   *
   * getVideoPlaybackQuality() works on cross-origin media (it exposes counters,
   * not pixels), so no CORS grant is needed.
   */
  /**
   * Loads one rendition URL into a throwaway <video> and measures it here,
   * inside the page.
   *
   * When it fails, it says WHY. MediaError.code plus Chrome's MediaError
   * .message (which carries the real pipeline reason -- DEMUXER_ERROR_COULD_NOT_OPEN
   * vs PIPELINE_ERROR_DECODE vs DEMUXER_ERROR_NO_SUPPORTED_STREAMS), whether an
   * `encrypted` event fired, whether CSP refused the URL, and whether the bytes
   * were reachable at all. A bare "failed to load" cannot tell a DRM-wrapped
   * rendition from a 403 from an HEVC rung this build cannot decode -- and
   * those three want three different fixes.
   *
   * crossOrigin is deliberately NOT set. TikTok's video CDN returns no
   * Access-Control-Allow-Origin on its signed URLs, so crossOrigin='anonymous'
   * converts a working no-cors media load into a guaranteed CORS failure.
   * getVideoPlaybackQuality() exposes counters, not pixels, so measuring frame
   * rate needs no CORS grant.
   */
  async function measureUrl(url, sampleMs, opts) {
    const o = opts || {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const LOAD_MS = o.loadTimeoutMs || 12000;

    const ERRNAME = {
      1: 'MEDIA_ERR_ABORTED', 2: 'MEDIA_ERR_NETWORK',
      3: 'MEDIA_ERR_DECODE', 4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
    };
    const NETSTATE = ['NETWORK_EMPTY', 'NETWORK_IDLE', 'NETWORK_LOADING', 'NETWORK_NO_SOURCE'];

    /* --------------------------------------------------- one load attempt */

    function open(target, label) {
      const v = document.createElement('video');
      v.muted = true;
      v.defaultMuted = true;
      v.setAttribute('muted', '');        // Chrome's muted-autoplay allowance
      v.playsInline = true;               // reads the attribute, not only the
      v.setAttribute('playsinline', '');  // property, on some paths
      v.preload = 'auto';
      v.disableRemotePlayback = true;
      v.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;' +
                        'opacity:0.01;pointer-events:none;z-index:-1';

      const ac = new AbortController();
      const on = (type, fn, node) =>
        (node || v).addEventListener(type, fn, { signal: ac.signal });

      const trace = [];
      const info = { attempt: label, url: target, events: trace, encrypted: false, cspBlocked: false };

      let settle;
      const done = new Promise((r) => { settle = r; });

      // Every handler is attached BEFORE src is assigned. Resource selection
      // only queues its tasks, so a property handler set on the very next line
      // would in fact still catch them -- but any `await` slipped in between
      // loses the error silently, and never losing an error is the whole point.
      for (const t of ['loadstart', 'progress', 'suspend', 'stalled', 'abort', 'emptied'])
        on(t, () => { if (trace[trace.length - 1] !== t) trace.push(t); });
      on('loadedmetadata', () => { trace.push('loadedmetadata'); settle('ok'); });
      on('error', () => { trace.push('error'); settle('error'); });

      // An encrypted stream with no MediaKeys attached is the leading reason a
      // URL the page itself plays fine dies in a freshly created element: the
      // page's player called setMediaKeys, this one did not.
      on('encrypted', (e) => {
        info.encrypted = true;
        info.initDataType = e.initDataType || '';
        trace.push('encrypted');
      });
      on('waitingforkey', () => { info.encrypted = true; trace.push('waitingforkey'); });

      // A CSP media-src refusal leaves MediaError uninformative; the violation
      // event is the only place the directive is named.
      on('securitypolicyviolation', (e) => {
        if (String(e.blockedURI || '').split('?')[0] !== target.split('?')[0]) return;
        info.cspBlocked = true;
        info.cspDirective = e.violatedDirective || e.effectiveDirective || '';
        trace.push('csp:' + info.cspDirective);
      }, document);

      (document.body || document.documentElement).appendChild(v);
      v.src = target;
      v.load();

      return { v, ac, info, done };
    }

    function snapshot(v, info) {
      const me = v.error;
      info.errorCode = me ? me.code : 0;
      info.errorName = me ? (ERRNAME[me.code] || 'code ' + me.code) : '';
      info.errorMessage = me ? String(me.message || '') : '';
      info.networkState = NETSTATE[v.networkState] || v.networkState;
      info.readyState = v.readyState;
      return info;
    }

    const kill = (h) => {
      try { h.ac.abort(); } catch (_) {}
      try { h.v.pause(); h.v.removeAttribute('src'); h.v.load(); h.v.remove(); } catch (_) {}
    };

    const race = async (h, ms) => {
      let t;
      const r = await Promise.race([h.done, new Promise((s) => { t = setTimeout(() => s('timeout'), ms); })]);
      clearTimeout(t);   // the old code left one live 12s timer per rendition
      return r;
    };

    /* ------------------------------------------------------- fallback aids */

    // String surgery, never URLSearchParams: re-serialising this query through
    // URLSearchParams percent-encodes '~' (present in TikTok's `ft` token) and
    // collapses TikTok's literal '&&', both of which change the signed string
    // and turn a valid URL into a guaranteed 403.
    const stripDrm = (u) => {
      const out = u.replace(/([?&])(?:dpk|dpm|ply_type|policy)=[^&]*/g,
                            (m, lead) => (lead === '?' ? '?' : ''));
      return out !== u ? out : null;
    };

    // Turns "failed to load" into "the bytes never arrived" vs "the bytes
    // arrived and the pipeline rejected them". no-cors keeps the request in
    // exactly the mode a media element uses (cookies and Referer, no Origin
    // header), so it does not perturb the CDN's hotlink check. The response is
    // opaque, so a resolved promise proves reachability but never the status
    // code -- read the status from the extension's service worker, which holds
    // host_permissions for *://*.tiktok.com/*, when you need the number.
    async function reachable(u) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 8000);
      try {
        await fetch(u, { method: 'GET', mode: 'no-cors', credentials: 'include',
                         cache: 'no-store', redirect: 'follow', signal: ac.signal });
        return 'reached';
      } catch (e) {
        return (e && e.name === 'AbortError') ? 'no response in 8s' : 'blocked (' + (e && e.name) + ')';
      } finally { clearTimeout(t); }
    }

    // Two rungs of the same gear are usually h264 and bytevc1 (HEVC). If this
    // build cannot decode HEVC, that rung errors instantly with code 4 and
    // looks identical to a dead URL.
    const codecSupport = () => {
      const p = document.createElement('video');
      return {
        h264: p.canPlayType('video/mp4; codecs="avc1.640028"') || 'no',
        hvc1: p.canPlayType('video/mp4; codecs="hvc1.1.6.L120.B0"') || 'no',
        hev1: p.canPlayType('video/mp4; codecs="hev1.1.6.L120.B0"') || 'no',
      };
    };

    const explain = (info) => {
      if (info.cspBlocked) return 'blocked by Content-Security-Policy (' + info.cspDirective + ')';
      if (info.encrypted) {
        return 'DRM: the stream is encrypted (' + (info.initDataType || 'cenc') +
               ') and this element has no MediaKeys, while the page player has. Not a dead URL.';
      }
      if (info.outcome === 'timeout') {
        return 'no metadata within ' + LOAD_MS + 'ms (networkState ' + info.networkState + ')';
      }
      const bits = [info.errorName || 'load failed'];
      if (info.errorMessage) bits.push(info.errorMessage);
      if (info.transport) bits.push('transport: ' + info.transport);
      return bits.join(' -- ');
    };

    /* --------------------------------------------------------------- run it */

    const diag = [];
    let h = open(url, 'direct');
    let outcome = await race(h, LOAD_MS);
    snapshot(h.v, h.info);
    h.info.outcome = outcome;

    if (outcome !== 'ok') {
      diag.push(h.info);
      kill(h);

      // Did the bytes reach us at all? Ask before retrying, so a retry that
      // also fails is still explained.
      h.info.transport = await reachable(url);

      // Fallback: drop the DRM decoration. The signature covers path and
      // expiry, not these parameters, so a rendition often serves cleartext
      // once dpk/dpm/policy/ply_type are gone.
      const plain = (h.info.encrypted || /[?&]dp[km]=/.test(url)) ? stripDrm(url) : null;
      if (plain) {
        const h2 = open(plain, 'drm-stripped');
        const o2 = await race(h2, LOAD_MS);
        snapshot(h2.v, h2.info);
        h2.info.outcome = o2;
        if (o2 === 'ok') { h = h2; outcome = 'ok'; }
        else { diag.push(h2.info); kill(h2); }
      }
    }

    if (outcome !== 'ok') {
      const first = diag[0];
      return {
        url,
        error: explain(first),
        errorCode: first.errorCode,
        errorName: first.errorName,
        errorMessage: first.errorMessage,
        encrypted: first.encrypted,
        cspBlocked: first.cspBlocked,
        cspDirective: first.cspDirective,
        networkState: first.networkState,
        readyState: first.readyState,
        transport: first.transport,
        events: first.events.join(','),
        codecSupport: codecSupport(),
        attempts: diag,
      };
    }

    /* --------------------------------------------------------- measure it */

    const v = h.v;
    const out = {
      url: h.info.url,
      width: v.videoWidth,
      height: v.videoHeight,
      duration: Number.isFinite(v.duration) ? v.duration : 0,
      attempt: h.info.attempt,
      encrypted: h.info.encrypted,
    };

    // Autoplay policy rejects play(); it never produces a load error. Record
    // the rejection so a zero-fps result is attributable.
    try { await v.play(); }
    catch (e) { out.playRejected = (e && e.name) + ': ' + (e && e.message); }

    if (!v.getVideoPlaybackQuality) { kill(h); out.error = 'no playback quality API'; return out; }

    let frames = 0, secs = 0;
    let pf = v.getVideoPlaybackQuality().totalVideoFrames, pt = v.currentTime;
    const steps = Math.max(4, Math.round((sampleMs || 3000) / 250));
    for (let i = 0; i < steps; i++) {
      await sleep(250);
      if (v.error) break;                     // a decode failure AFTER metadata
      const q = v.getVideoPlaybackQuality();
      const nf = q.totalVideoFrames, nt = v.currentTime;
      const df = nf - pf, dt = nt - pt;
      if (dt > 0 && df >= 0) { frames += df; secs += dt; }
      pf = nf; pt = nt;
      out.droppedFrames = q.droppedVideoFrames;
    }

    out.decodedFrames = frames;
    out.sampledSeconds = Math.round(secs * 1000) / 1000;
    out.measuredFps = secs > 0 ? Math.round((frames / secs) * 100) / 100 : 0;
    if (out.duration && out.measuredFps) out.impliedTotalFrames = Math.round(out.measuredFps * out.duration);

    /*
     * The deep pass: play the rendition to the end and read the decoder's own
     * totals rather than extrapolating a 2.5-second window.
     *
     * This exists for renditions the CDN refuses to hand over. Every probe of
     * another creator's 4K/120 video returned 403, so ffprobe never saw the
     * bytes and the only numbers available were estimates from ~2 seconds of
     * playback — which cannot distinguish genuine high-frame-rate content from
     * a padded sample table.
     *
     * A whole-file decode can. Ghost padding is 8-byte filler NALUs that carry
     * no picture: the decoder errors on them and totalVideoFrames does not
     * advance. So decoded frames over the full duration lands near
     * duration x real rate for genuine content, and far below the DECLARED
     * frame count for a padded file. corruptedVideoFrames is the other tell.
     */
    if (opts && opts.deep && !v.error) {
      const cap = opts.deepCapMs || 120000;
      const t0 = Date.now();
      let last = v.currentTime, stalls = 0;
      while (!v.ended && Date.now() - t0 < cap) {
        await sleep(500);
        if (v.error) break;
        // A rendition that stops advancing is not going to finish. Give it four
        // seconds of no progress before calling it, so a slow buffer is not
        // mistaken for a stall.
        if (v.currentTime <= last + 0.001) { if (++stalls >= 8) break; } else stalls = 0;
        last = v.currentTime;
      }
      const q = v.getVideoPlaybackQuality();
      out.deep = {
        totalDecoded: q.totalVideoFrames,
        dropped: q.droppedVideoFrames,
        corrupted: q.corruptedVideoFrames || 0,
        playedTo: Math.round(v.currentTime * 1000) / 1000,
        ended: !!v.ended,
        stalled: stalls >= 8,
        // What the frame count SHOULD be if the rate measured over the short
        // window holds for the whole file. A large shortfall against this is
        // the padding signature.
        expected: (out.duration && out.measuredFps)
          ? Math.round(out.duration * out.measuredFps) : 0,
      };
    }

    if (v.error) {
      snapshot(v, h.info);
      out.error = 'decode failed after metadata -- ' + explain(h.info);
      out.errorCode = h.info.errorCode;
      out.errorName = h.info.errorName;
      out.errorMessage = h.info.errorMessage;
    } else if (!secs) {
      out.error = document.hidden
        ? 'Playback never advanced -- this tab was in the background. Keep it in front while measuring.'
        : 'Playback never advanced -- the rendition loaded but would not play.' +
          (out.playRejected ? ' play() rejected: ' + out.playRejected : '');
    }
    if (diag.length) out.recoveredFrom = diag;
    kill(h);
    return out;
  }


  /**
   * Measures every rendition TikTok declared, original-quality gears first —
   * those are the ones that would carry an untranscoded frame rate.
   */
  async function measureLadder(sampleMs) {
    const entries = [];
    for (const g of state.ladder) if (g.url) entries.push({ gear: g.gear || '', url: g.url, declared: g });
    for (const u of state.media) if (!entries.some((e) => e.url === u)) entries.push({ gear: '', url: u, declared: null });

    // "original" first: if TikTok kept an untranscoded copy, that is the answer.
    entries.sort((a, b) => (/origin/i.test(b.gear) ? 1 : 0) - (/origin/i.test(a.gear) ? 1 : 0));

    const out = [];
    for (const e of entries.slice(0, 8)) {
      state.ladderProgress = `${out.length + 1}/${Math.min(entries.length, 8)}`;
      post('ladderProgress');
      const m = await measureUrl(e.url, sampleMs || 2500);
      out.push(Object.assign({ gear: e.gear, declaredWidth: e.declared && e.declared.width,
                               declaredBitrate: e.declared && e.declared.bitrate }, m));
    }
    // One deep pass, on the gear that matters. Doing it for all eight would
    // take minutes and only the original-quality rung is ever in question.
    const target = out
      .map((m, i) => ({ m, i }))
      .filter((x) => /origin/i.test(x.m.gear || '') && x.m.width && !x.m.error)
      .sort((a, b) => (b.m.width * b.m.height) - (a.m.width * a.m.height) ||
                      ((b.m.duration || 0) - (a.m.duration || 0)))[0];

    if (target) {
      state.ladderProgress = 'deep sample';
      post('ladderProgress');
      const e = entries[target.i];
      const cap = Math.min(150000, Math.max(20000, ((out[target.i].duration || 30) + 12) * 1000));
      const d = await measureUrl(e.url, 1200, { deep: true, deepCapMs: cap });
      if (d && d.deep) out[target.i].deep = d.deep;
    }

    state.ladderProgress = '';
    return out;
  }

  /* ------------------------------------------------ detect other tampering */

  // If a second extension wraps the same APIs after us, the installed function
  // is no longer ours. That is a direct signal that something else is
  // intercepting the upload path — which is exactly what we want to know when
  // running alongside another tool.
  const mine = {
    'URL.createObjectURL': URL.createObjectURL,
    'XMLHttpRequest.prototype.send': XMLHttpRequest.prototype.send,
    'XMLHttpRequest.prototype.open': XMLHttpRequest.prototype.open,
    'window.fetch': window.fetch,
    'Blob.prototype.slice': Blob.prototype.slice,
    'File.prototype.slice': (window.File && File.prototype.slice) || null,
  };

  setInterval(() => {
    const now = {
      'URL.createObjectURL': URL.createObjectURL,
      'XMLHttpRequest.prototype.send': XMLHttpRequest.prototype.send,
      'XMLHttpRequest.prototype.open': XMLHttpRequest.prototype.open,
      'window.fetch': window.fetch,
      'Blob.prototype.slice': Blob.prototype.slice,
      'File.prototype.slice': (window.File && File.prototype.slice) || null,
    };
    let changed = false;
    for (const k of Object.keys(mine)) {
      if (mine[k] && now[k] !== mine[k] && !state.hookTamper.includes(k)) {
        state.hookTamper.push(k);
        mine[k] = now[k];   // re-baseline so we report each change once
        changed = true;
      }
    }
    if (changed) post('tamper');
  }, 1500);

  /* --------------------------------------------------------------- bridge */

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || !d.__tthdCmd) return;
    if (d.cmd === 'sync') post('sync');
    if (d.cmd === 'swap') {
      swapEnabled = !!d.value;
      if (d.options) state.swapOptions = d.options;
      state.swapEnabled = swapEnabled;
      post('sync');
    }
    if (d.cmd === 'measureLadder') {
      state.ladderMeasured = null;
      state.measuring = true;
      post('ladder');
      const seq = ++state.measureSeq;
      measureLadder(d.sampleMs).then(
        (rows) => { if (seq !== state.measureSeq) return;
                    state.ladderMeasured = rows; state.measuring = false; post('ladder'); },
        (e) => { if (seq !== state.measureSeq) return;
                 state.ladderMeasured = [{ error: String(e.message) }]; state.measuring = false; post('ladder'); }
      );
    }
    if (d.cmd === 'measure') {
      // Clear first. Otherwise a caller polling for "a result" latches onto the
      // previous measurement and reports a stale video as the current one —
      // which is exactly how a wrong frame rate survives across pages.
      state.pageVideo = null;
      state.measuring = true;
      post('pageVideo');
      const started = ++state.measureSeq;
      measurePageVideo(d.sampleMs).then(
        (m) => { if (started !== state.measureSeq) return;
                 state.pageVideo = Object.assign({ seq: started }, m); state.measuring = false; post('pageVideo'); },
        (e) => { if (started !== state.measureSeq) return;
                 state.pageVideo = { seq: started, error: String(e.message) }; state.measuring = false; post('pageVideo'); }
      );
    }
    if (d.cmd === 'ingest') {
      // null or {} restores whatever the page composes on its own.
      state.ingestOverride = (d.value && typeof d.value === 'object' && Object.keys(d.value).length)
        ? d.value : null;
      state.ingestApplied = [];
      post('ingest');
    }
    if (d.cmd === 'guard') {
      state.guard = !!d.value;
      try { localStorage.setItem('__tthd_guard', state.guard ? '1' : '0'); } catch (_) {}
      post('sync');
    }
    if (d.cmd === 'reset') {
      state.file = null; state.bytesSent = 0; state.requests = 0;
      state.bytesFromBodies = 0; state.bytesFromStreams = 0;
      state.encoders = []; state.media = []; state.reqs = []; state.ladder = [];
      state.originalMoov = null; state.diff = null; state.hookTamper = [];
      state.route = []; state.hostBytes = {};
      state.uploadHeaders = []; state.ingestApplied = [];
      state.diffParts = []; state.diffBytes = 0; clearTimeout(state.diffTimer);
      // Invalidate any in-flight measurement too, so its result cannot land
      // after the reset and masquerade as fresh.
      state.pageVideo = null; state.measuring = false; state.measureSeq++;
      state.ladderMeasured = null; state.ladderProgress = '';
      post('sync');
    }
  });

  post('ready');
})();
