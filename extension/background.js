'use strict';
/**
 * background.js — the extension's service worker.
 *
 * This is the hop that was missing. A fetch made from the PAGE world inherits
 * every restriction of https://www.tiktok.com, and a public-HTTPS page
 * reaching http://localhost is exactly the case Arc/Chrome silently block
 * (private-network / mixed-content). Every attempt to swap from the page died
 * here with no network request ever leaving the browser — the server log
 * proved it.
 *
 * The paid extension never fetches from the page. It posts a message, the
 * isolated-world script relays it, and its SERVICE WORKER does the real fetch
 * — which runs with the extension's own host_permissions and is exempt from
 * the page's CSP, PNA and mixed-content rules. This file is that worker.
 *
 * Protocol (from content.js):
 *   { type: 'tthd:process', id, name, options, bytes: ArrayBuffer }
 *     -> replies { ok, name, info, bytes: ArrayBuffer } or { ok:false, error }
 *   Progress is streamed back with chrome.tabs.sendMessage
 *     { type: 'tthd:progress', id, phase, pct, note }
 */

const SERVER = 'http://localhost:7654';
importScripts('mp4-inspect.js');

// The report is useful with player measurements alone. A small MP4 range adds
// container facts when the currently served URL is readable by the extension.
async function inspectDeliveredMp4(url) {
  if (!url || !/^https:\/\//i.test(url)) return { error: 'No direct HTTPS MP4 URL is available.' };
  const allowed = /(^|\.)(tiktok\.com|tiktokcdn\.com|tiktokcdn-us\.com|tiktokv\.com|tiktokv\.us|byteoversea\.com|cdninstagram\.com|fbcdn\.net)$/i;
  let host;
  try { host = new URL(url).hostname; } catch (_) { return { error: 'Invalid media URL.' }; }
  if (!allowed.test(host)) return { error: 'The media URL is outside the extension’s video CDN permissions.' };
  const cap = 4 * 1024 * 1024;
  async function read(range) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(url, {
        headers: { Range: range }, signal: controller.signal, cache: 'no-store',
        credentials: 'include', referrer: /cdninstagram\.com|fbcdn\.net/.test(host) ? 'https://www.instagram.com/' : 'https://www.tiktok.com/',
      });
      if (res.status !== 206 && res.status !== 200) return { error: 'CDN did not provide readable media (HTTP ' + res.status + ').' };
      const cr = res.headers.get('content-range') || '';
      const total = res.status === 206 ? Number(cr.split('/').pop()) : Number(res.headers.get('content-length'));
      const reader = res.body.getReader();
      const chunks = []; let count = 0;
      while (count < cap) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); count += value.length;
      }
      await reader.cancel().catch(() => {});
      const bytes = new Uint8Array(Math.min(count, cap));
      let at = 0;
      for (const chunk of chunks) { bytes.set(chunk.subarray(0, bytes.length - at), at); at += Math.min(chunk.length, bytes.length - at); }
      return { bytes, total: Number.isFinite(total) ? total : 0 };
    } catch (e) { return { error: String(e && e.message || e) }; }
    finally { clearTimeout(timeout); }
  }
  const head = await read('bytes=0-' + (cap - 1));
  if (head.bytes) {
    const info = inspectMp4Sample(head.bytes, head.total);
    if (info) return { info, sampledBytes: head.bytes.length };
  }
  const tail = await read('bytes=-' + cap);
  if (tail.bytes) {
    const info = inspectMp4Sample(tail.bytes, tail.total);
    if (info) return { info, sampledBytes: tail.bytes.length };
  }
  return { error: tail.error || head.error || 'Readable MP4 sample table was not in the bounded ranges.' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'tthd:localReport') return false;
  (async () => {
    try {
      const payload = msg.payload || {};
      const candidates = [
        { url: payload.pageVideo && payload.pageVideo.currentSrc, association: 'player source' },
        ...((payload.publication?.renditions || []).map(g => ({ url: g.url, association: 'current post rendition' }))),
        { url: payload.publication?.playUrl, association: 'current post rendition' },
        ...((payload.publication ? [] : payload.ladder || []).map(g => ({ url: g.url, association: 'unattributed rendition; may be another video' }))),
        ...((payload.media || []).slice(-6).reverse().map(url => ({ url, association: 'recent media request; may be a preloaded video' }))),
      ];
      const direct = candidates.find(x => typeof x.url === 'string' && /^https:\/\//i.test(x.url));
      const id = crypto.randomUUID();
      const report = { ...payload, probe: { status: 'pending' }, observedAt: new Date().toISOString() };
      await chrome.storage.session.set({ ['report_' + id]: report });
      await chrome.tabs.create({ url: chrome.runtime.getURL('report.html?id=' + id) });
      const inspect = async url => {
        try { return await inspectDeliveredMp4(url); }
        catch (e) { return { error: String(e && e.message || e) }; }
      };
      const [probe, downloadProbe] = await Promise.all([
        inspect(direct && direct.url),
        payload.publication?.downloadUrl ? inspect(payload.publication.downloadUrl)
          : Promise.resolve({ error: 'This page did not expose a saved-video URL.' }),
      ]);
      probe.association = direct ? direct.association : 'none';
      await chrome.storage.session.set({ ['report_' + id]: { ...report, probe, downloadProbe } });
      sendResponse({ ok: true });
    } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
  })();
  return true;
});

/**
 * Follows /api/progress/<id> and reports the encode's real position.
 *
 * The job does not exist until the whole upload body has arrived, so the first
 * few attempts get 404 and are retried. Reading is a manual SSE parse rather
 * than EventSource, which service workers do not have.
 */
async function followProgress(id, onPct, stop) {
  const deadline = Date.now() + 20 * 60 * 1000;
  while (!stop.done && Date.now() < deadline) {
    let res;
    try {
      res = await fetch(`${SERVER}/api/progress/${encodeURIComponent(id)}`, { cache: 'no-store' });
    } catch (_) { res = null; }

    if (!res || !res.ok || !res.body) {
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      let chunk;
      try { chunk = await reader.read(); } catch (_) { break; }
      if (chunk.done || stop.done) break;
      buf += dec.decode(chunk.value, { stream: true });

      // SSE frames are separated by a blank line.
      let cut;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        if (!/^event: progress/m.test(frame)) continue;
        const m = /^data: (.*)$/m.exec(frame);
        if (!m) continue;
        try {
          const d = JSON.parse(m[1]);
          if (typeof d.pct === 'number') onPct(d.pct);
        } catch (_) {}
      }
    }
    if (stop.done) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Fetch one rendition and hand the bytes to the local server for ffprobe.
 *
 * This runs in the worker because the PAGE cannot do it: tiktok.com's CSP
 * blocks a direct connection to the video CDN (observed as a TypeError from a
 * no-cors fetch, and MEDIA_ERR_SRC_NOT_SUPPORTED from a <video>). The worker is
 * exempt from page CSP and carries the extension's host_permissions, and
 * credentials:'include' keeps the session that the signed URLs expect.
 */
/**
 * Fetch /api/caps on behalf of the panel.
 *
 * The panel tries this itself first. On a site whose CSP refuses a connection
 * to localhost that attempt never leaves the page, and the panel cannot tell
 * that apart from a server that is not running — so it wrongly told the user to
 * start a server that was already running. The worker is exempt from page CSP.
 */
/*
 * A chunked upload relay, for sites whose CSP blocks the page from reaching
 * localhost. Bytes arrive as base64 in pieces because Chrome's message channel
 * is JSON — an ArrayBuffer sent whole arrives as {}.
 */
const pending = new Map();

const b64ToBytes = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const bytesToB64 = (bytes) => {
  let s = '';
  // Chunked because String.fromCharCode blows the argument limit on big inputs.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !String(msg.type || '').startsWith('tthd:up')) return false;

  (async () => {
    try {
      if (msg.type === 'tthd:upInit') {
        pending.set(msg.id, { parts: [], name: msg.name, options: msg.options, jobId: msg.jobId });
        return sendResponse({ ok: true });
      }

      if (msg.type === 'tthd:upChunk') {
        const job = pending.get(msg.id);
        if (!job) return sendResponse({ ok: false, error: 'no such upload' });
        job.parts.push(b64ToBytes(msg.b64));
        return sendResponse({ ok: true });
      }

      if (msg.type === 'tthd:upSend') {
        const job = pending.get(msg.id);
        if (!job) return sendResponse({ ok: false, error: 'no such upload' });

        const total = job.parts.reduce((a, p) => a + p.length, 0);
        const body = new Uint8Array(total);
        let off = 0;
        for (const p of job.parts) { body.set(p, off); off += p.length; }
        // Free the upload copy now; the result is about to need the room.
        job.parts = [];

        // The encode is the longest phase by far. Following it here is the only
        // way this path reports anything between "sent" and "done" -- the page
        // cannot open the progress stream itself, which is the whole reason it
        // is talking to the worker.
        const tabId = sender && sender.tab && sender.tab.id;
        const relayStop = { done: false };
        if (tabId != null && job.jobId) {
          followProgress(job.jobId, (pct) => {
            chrome.tabs.sendMessage(tabId, {
              type: 'tthd:progress', id: msg.id, phase: 'working',
              pct: 6 + Math.max(0, Math.min(100, pct)) * 0.86, note: '',
            }).catch(() => {});
          }, relayStop).catch(() => {});
        }

        /*
         * finally, not a plain assignment after the await.
         *
         * The progress poller above runs every 250ms until relayStop.done. If
         * this fetch THROWS — which is exactly what happens when the local
         * server is not running — the assignment below was skipped and the
         * poller kept going, producing a continuous stream of
         * ERR_CONNECTION_REFUSED against localhost. The one real failure the
         * user is most likely to hit turned into hundreds of logged errors.
         */
        let res;
        try {
          res = await fetch(SERVER + '/api/process', {
            method: 'POST',
            headers: {
              'x-filename': encodeURIComponent(job.name || 'video.mp4'),
              'x-options': JSON.stringify(job.options || {}),
              'x-job-id': job.jobId || '',
              'content-type': 'application/octet-stream',
            },
            body,
          });
        } finally {
          relayStop.done = true;
        }

        if (!res.ok) {
          pending.delete(msg.id);
          let err = 'HTTP ' + res.status;
          try { err = (await res.json()).error || err; } catch (_) {}
          return sendResponse({ ok: false, error: err });
        }

        const out = new Uint8Array(await res.arrayBuffer());
        const name = decodeURIComponent(res.headers.get('x-out-name') || job.name || 'video.mp4');
        let info = {};
        try { info = JSON.parse(decodeURIComponent(res.headers.get('x-out-info') || '{}')); } catch (_) {}

        // Parked here, NOT returned. Returning every chunk in one response is
        // what stalled this path: splitting the bytes and then sending all the
        // pieces together crosses exactly as much data as sending them whole.
        const CH = 3 * 1024 * 1024;
        job.out = [];
        for (let i = 0; i < out.length; i += CH) job.out.push(out.subarray(i, i + CH));
        job.name = name;
        job.info = info;
        job.bytes = out.length;

        return sendResponse({ ok: true, name, info, bytes: out.length, chunks: job.out.length });
      }

      // One piece per message. The page asks for them in order and stitches
      // them back together on its side.
      if (msg.type === 'tthd:upPull') {
        const job = pending.get(msg.id);
        if (!job || !job.out) return sendResponse({ ok: false, error: 'no such result' });
        const part = job.out[msg.index];
        if (!part) return sendResponse({ ok: false, error: 'no such chunk ' + msg.index });
        const b64 = bytesToB64(part);
        // Drop each piece as it leaves so a large result is not held twice.
        job.out[msg.index] = null;
        if (msg.index === job.out.length - 1) pending.delete(msg.id);
        return sendResponse({ ok: true, b64 });
      }

      sendResponse({ ok: false, error: 'unknown upload message' });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();

  return true;
});

/**
 * Posts a report on the page's behalf.
 *
 * The payload is already JSON and measured in kilobytes, so unlike the upload
 * it needs no chunking — it crosses the message channel whole.
 */
/**
 * Account connection lives in the worker, not the content script.
 *
 * chrome.identity is only available here, and a token has no business sitting
 * in a script that a page shares a window with.
 */
/*
 * Defensive, and deliberately not silent.
 *
 * importScripts runs at module scope. If it throws, every listener BELOW this
 * line never registers while the two above it do — so the extension answers
 * some messages and ignores others, with no error anywhere the user looks.
 * That is exactly the shape of failure that cost an afternoon: the panel
 * loaded, the page hooks ran, and every request to the local server simply
 * never happened.
 */
let importError = '';
try {
  importScripts('connect.js');
} catch (e) {
  importError = String((e && e.message) || e);
}

/*
 * Tell the local server this worker is alive.
 *
 * A service worker cannot be inspected without chrome://extensions, and its
 * failures are invisible from every page. One line to a server we already run
 * turns 'nothing happens' into a log entry naming the reason.
 */
try {
  fetch(SERVER + '/api/worker-alive', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: (chrome.runtime.getManifest() || {}).version || '?',
      importError,
    }),
  }).catch(() => {});
} catch (_) {}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !String(msg.type || '').startsWith('tthd:auth')) return false;

  (async () => {
    const C = self.TTHD_CONNECT;
    try {
      if (msg.type === 'tthd:authStatus') {
        const ids = ['tiktok', 'youtube', 'instagram'];
        const rows = await Promise.all(ids.map((id) => C.statusOf(id)));
        return sendResponse({ ok: true, rows, redirect: C.REDIRECT,
                              meta: Object.fromEntries(ids.map((id) => [id, {
                                label: C.PLATFORMS[id].label,
                                console: C.PLATFORMS[id].console,
                                steps: C.PLATFORMS[id].steps,
                                // Whether a person reads the app description.
                                review: C.PLATFORMS[id].review,
                                cost: C.PLATFORMS[id].cost,
                              }])) });
      }
      if (msg.type === 'tthd:authConnect') {
        return sendResponse({ ok: true, row: await C.connect(msg.id, msg.clientId) });
      }
      if (msg.type === 'tthd:authDisconnect') {
        return sendResponse({ ok: true, row: await C.disconnect(msg.id) });
      }
      sendResponse({ ok: false, error: 'unknown auth message' });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();

  return true;
});

/**
 * Opens the composers, and hands prepared files to the pages that need them.
 *
 * Both jobs are here for the same reason: a content script cannot do either.
 * Three window.open() calls get popup-blocked after the first, and a page-context
 * fetch to localhost is refused by these sites' content-security policies.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !String(msg.type || '').startsWith('tthd:prep')) return false;

  (async () => {
    try {
      if (msg.type === 'tthd:prepOpen') {
        const urls = msg.urls || [];
        const made = [];
        for (const u of urls) {
          const t = await chrome.tabs.create({ url: u, active: u === urls[0] });
          made.push(t.id);
        }
        return sendResponse({ ok: true, opened: made.length });
      }

      if (msg.type === 'tthd:prepFetch') {
        const r = await fetch(SERVER + '/api/prepared/' + encodeURIComponent(msg.file));
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const buf = new Uint8Array(await r.arrayBuffer());
        // Same chunked hand-off as the upload relay: the message channel is
        // JSON, so bytes cross as base64 and one piece per message.
        const CH = 3 * 1024 * 1024;
        const parts = [];
        for (let i = 0; i < buf.length; i += CH) parts.push(buf.subarray(i, i + CH));
        pending.set(msg.id, { out: parts, bytes: buf.length });
        return sendResponse({ ok: true, bytes: buf.length, chunks: parts.length });
      }

      if (msg.type === 'tthd:prepPull') {
        const job = pending.get(msg.id);
        if (!job || !job.out) return sendResponse({ ok: false, error: 'no such transfer' });
        const part = job.out[msg.index];
        if (!part) return sendResponse({ ok: false, error: 'no such chunk' });
        const b64 = bytesToB64(part);
        job.out[msg.index] = null;
        if (msg.index === job.out.length - 1) pending.delete(msg.id);
        return sendResponse({ ok: true, b64 });
      }

      sendResponse({ ok: false, error: 'unknown prep message' });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'tthd:report') return false;

  (async () => {
    try {
      const res = await fetch(SERVER + '/api/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(msg.payload || {}),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.error) throw new Error(d.error || 'HTTP ' + res.status);
      sendResponse({ ok: true, url: d.url });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'tthd:stage') return false;

  (async () => {
    try {
      // The page cannot ask loopback itself; this worker can. Same relay the
      // prepared-file fetch already uses.
      const r = await fetch(SERVER + '/api/stage', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      sendResponse({ ok: true, file: d.file || null });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'tthd:caps') return false;

  (async () => {
    try {
      const res = await fetch(SERVER + '/api/caps', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      sendResponse({ ok: true, caps: await res.json() });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'tthd:probeRendition') return false;

  (async () => {
    try {
      /*
       * TikTok's CDN checks the referrer. Without one every rendition came back
       * 403 — eight of eight on a real report — which left the ladder measurable
       * only by the in-page sampler, and that yields estimates rather than exact
       * frame counts. Referer is a forbidden header so it cannot be set through
       * `headers`; fetch's own referrer option is the way in, and a service
       * worker is allowed to use it.
       *
       * A ranged request is tried first because a rendition can be hundreds of
       * megabytes and the moov is all that is needed. Some edges refuse Range
       * outright, so a 403 is retried whole before being believed.
       */
      /*
       * THE CAP IS SET HERE, NOT BY THE CALLER.
       *
       * This used to read `msg.maxBytes`, and no caller ever set it —
       * content.js sends only {type, url}. So `withRange && msg.maxBytes` was
       * always falsy, the Range header was never sent, and every probe pulled
       * the ENTIRE rendition. Two of those per report, at 200-300 MB each,
       * through the same connection TikTok's player is measuring for its
       * bandwidth estimate.
       *
       * That estimate is what picks the rung, it is shared across the tab, and
       * it persists. So running a few reports demoted every video in the
       * browser to the lowest rung — including other creators' videos, which no
       * upload of ours can possibly have changed. The instrument was altering
       * the thing it existed to measure, and it did it silently.
       *
       * ffprobe needs the moov box, not the picture data. For a faststart file
       * that is at the front and a few hundred KB; 16 MB is generous enough to
       * cover an unusual one while still being ~5% of a full download.
       */
      const CAP = Number(msg.maxBytes) || 16 * 1024 * 1024;

      const attempt = (range) => fetch(msg.url, {
        credentials: 'include',
        cache: 'no-store',
        referrer: 'https://www.tiktok.com/',
        referrerPolicy: 'unsafe-url',
        headers: range ? { range } : {},
      });

      const readProbe = async (res) => {
        if (!res.ok && res.status !== 206) return null;
        const buf = await res.arrayBuffer();
        if (!buf.byteLength) return null;
        /*
         * Hand over the TRUE file size, not just the bytes being sent.
         *
         * ffprobe derives bitrate from the size of the file it is given. Since
         * the range cap above sends only the first 16 MB, that made every
         * probed rendition report roughly a ninth of its real bitrate — a
         * 39.55 Mbps passthrough was measured as 4.47 Mbps and read as heavy
         * compression. Frames, dimensions and frame rate all come from the
         * moov and stayed correct, which is exactly what made the wrong number
         * look plausible.
         *
         * A 206 answers with `content-range: bytes 0-16777215/148583424`; the
         * figure after the slash is what bitrate has to be computed from.
         */
        const cr = res.headers.get('content-range') || '';
        const slash = cr.lastIndexOf('/');
        const total = slash > 0 ? Number(cr.slice(slash + 1)) : 0;
        const probe = await fetch(SERVER + '/api/probe-bytes', {
          method: 'POST',
          headers: {
            'content-type': 'application/octet-stream',
            'x-total-bytes': String(Number.isFinite(total) && total > 0 ? total : 0),
          },
          body: buf,
        });
        const j = await probe.json().catch(() => ({}));
        if (!probe.ok || !j.info) return null;
        return { info: j.info, bytes: buf.byteLength, partial: res.status === 206 };
      };

      // Head first — moov is at the front of anything faststart. Then the tail,
      // for a file written moov-last. Only if the CDN refuses ranged requests
      // altogether is the whole file worth pulling, and that is now the rare
      // path rather than the only one.
      let out = await readProbe(await attempt('bytes=0-' + (CAP - 1)));
      if (!out) out = await readProbe(await attempt('bytes=-' + CAP));
      if (!out) {
        const whole = await attempt('');
        if (!whole.ok && whole.status !== 206) throw new Error('CDN returned HTTP ' + whole.status);
        out = await readProbe(whole);
      }
      if (!out) throw new Error('rendition fetched but ffprobe could not read it');
      sendResponse({ ok: true, info: out.info, bytes: out.bytes, partial: out.partial });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'tthd:process') return false;
  const tabId = sender && sender.tab && sender.tab.id;

  const progress = (phase, pct, note) => {
    if (tabId == null) return;
    chrome.tabs.sendMessage(tabId, { type: 'tthd:progress', id: msg.id, phase, pct, note }).catch(() => {});
  };

  // The id is ours, so the progress stream can be opened before the response
  // exists. Without this the encode — the longest phase — reports nothing.
  const jobId = 'j' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  const stop = { done: false };

  (async () => {
    try {
      progress('working', 1, '');

      followProgress(jobId, (encodePct) => {
        // The encode owns 6-92; sending owns the first 6, receiving the last 8.
        progress('working', 6 + Math.max(0, Math.min(100, encodePct)) * 0.86, '');
      }, stop).catch(() => {});

      // fetch from the worker — this is the privileged context.
      const res = await fetch(SERVER + '/api/process', {
        method: 'POST',
        headers: {
          'x-filename': encodeURIComponent(msg.name || 'video.mp4'),
          'x-options': JSON.stringify(msg.options || {}),
          'x-job-id': jobId,
          'content-type': 'application/octet-stream',
        },
        body: msg.bytes,
      });

      if (!res.ok) {
        let err = 'HTTP ' + res.status;
        try { err = (await res.json()).error || err; } catch (_) {}
        throw new Error(err);
      }

      stop.done = true;   // the encode is finished; the stream has nothing left to say

      // Stream the body so we can report download progress for large outputs.
      const total = Number(res.headers.get('content-length')) || 0;
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.byteLength;
        if (total) progress('working', 92 + (got / total) * 8, '');
      }
      const out = new Uint8Array(got);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.byteLength; }

      const name = decodeURIComponent(res.headers.get('x-out-name') || msg.name || 'video.mp4');
      let info = {};
      try { info = JSON.parse(decodeURIComponent(res.headers.get('x-out-info') || '{}')); } catch (_) {}

      progress('done', 100, `${info.width}×${info.height} · ${info.fps}fps`);
      sendResponse({ ok: true, name, info, bytes: out.buffer });
    } catch (e) {
      stop.done = true;
      const m = String(e && e.message || e);
      progress('error', 0, m);
      sendResponse({ ok: false, error: m });
    }
  })();

  return true; // keep the message channel open for the async reply
});
