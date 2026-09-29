'use strict';
/**
 * content.js — isolated world. Renders the on-page readout and relays
 * guard-mode changes down to the page-world hooks in inject.js.
 */

let panel, els = {}, last = null;

// Pre-flight: is the local transcoder reachable? Probed once on load and
// whenever the toggle is turned on, so the "armed" indicator can be honest —
// green only if a dropped file actually has somewhere to go.
let serverReachable = null;  // null = unknown, true/false once probed
let ghostAvailable = null;   // null = unknown, false = server cannot run it
let profiles = null;         // per-platform behaviour, fetched from the server
// Which probe path answered, and why the others did not. Kept because "not
// connected" has twice meant something other than a server that is not running.
let probeTrace = { page: null, worker: null, via: null };
// The technique for the current site, taken from the server's profile. Not a
// user setting: which one to use is a question the tool should answer.
let currentMethod = null;

/**
 * Is the local transcoder reachable, and what can it do?
 *
 * Tried directly first — cheapest, and it works on most sites. Instagram's CSP
 * refuses a page-side connection to localhost, and a refused connection is
 * indistinguishable from a server that is not running, so the panel used to
 * tell the user to start something that was already running. The service worker
 * is exempt from page CSP, so it answers when the page cannot.
 */
async function probeServer() {
  if (PLATFORM.id === 'tiktok') {
    serverReachable = true; ghostAvailable = true;
    probeTrace = { page: null, worker: null, via: 'browser' };
    profiles = {
      tiktok: { method: 'single', methods: ['single', 'single-mobile', 'separate-audio'],
        maxLabel: 'Prepare locally', proven: null,
        tried: { phantom: { verdict: 'failed' }, ghost: { verdict: 'failed' }, none: { verdict: 'failed' } },
        research: '4K/60 plays on the test phone. Camera-roll playback remains under investigation; 120 fps file storage does not guarantee 120 fps display.',
        hint: 'Preserves your video frames. Local preparation needs no server. Check the published post.' },
      __methods: {
        single: { label: 'Automatic preset', what: 'Separate audio for 4K/60 or 1080p/120; HEVC single-audio layout for 4K/120. Preserves video frames. Stored fps does not guarantee displayed fps.', inBrowser: true },
        'single-mobile': { label: 'Original test B', what: 'Phone-tested 4K/60 layout; desktop and saved-video playback can fail.', inBrowser: true },
        'separate-audio': { label: 'Separate audio — test J', what: 'Normal first audio track, padded second audio track. Saved file reported as 4K/60; playback compatibility remains uncertain.', inBrowser: true },
      },
    };
    if (!['single', 'single-mobile', 'separate-audio'].includes(currentMethod)) currentMethod = 'single';
    applyProfile(); applyGhostAvailability(); if (last) render(last);
    return;
  }
  let caps = null;
  probeTrace = { page: null, worker: null, via: null };

  try {
    const r = await fetch('http://localhost:7654/api/caps', { method: 'GET', cache: 'no-store' });
    if (r.ok) { caps = await r.json(); probeTrace.via = 'page'; }
    else probeTrace.page = 'HTTP ' + r.status;
  } catch (e) {
    // A page whose CSP refuses localhost lands here, and so does a server that
    // is genuinely down. They are indistinguishable from inside the page, which
    // is exactly why the worker gets a turn.
    probeTrace.page = String(e && e.message || e);
  }

  if (!caps) {
    try {
      const r = await askWorker({ type: 'tthd:caps' });
      if (r && r.ok) { caps = r.caps; probeTrace.via = 'worker'; }
      else probeTrace.worker = (r && r.error) || 'no reply';
    } catch (e) {
      probeTrace.worker = String(e && e.message || e);
    }
  }

  serverReachable = !!caps;
  ghostAvailable = caps ? caps.ghost !== false : null;
  if (caps && caps.profiles) { profiles = caps.profiles; applyProfile(); }

  applyGhostAvailability();
  if (last) render(last);
}

/**
 * Labels the panel with what THIS platform can actually deliver, and redraws
 * the cadence strip at that platform's decimation ratio.
 *
 * Called when the server answers, because the numbers live there. Until then
 * the panel shows the resolution only — better a short label than a wrong one.
 */
function applyProfile() {
  if (!panel || !profiles) return;
  const p = profiles[PLATFORM.id];
  if (!p) return;

  const label = panel.querySelector('#tthd-hdlabel');
  if (label) label.textContent = p.maxLabel || (p.height >= 1920 ? '1080p' : '');

  const hint = panel.querySelector('#tthd-hint');
  if (hint) hint.textContent = p.hint || '';

  if (!currentMethod) currentMethod = p.method;

  /*
   * A remembered choice that has since been MEASURED FAILING is stale, not a
   * preference, and it must not outlive the measurement.
   *
   * This is not hypothetical: TikTok's default moved from ghost frames to
   * phantom audio, and anyone who had used the panel before that had
   * `method_tiktok: 'ghost'` saved. Without this they would keep uploading with
   * the eliminated method — which reaches the original gear and then plays at
   * quarter speed — while the panel showed the new default as recommended.
   */
  const triedHere = p.tried || {};
  if (currentMethod !== p.method &&
      triedHere[currentMethod] && ['failed', 'unverified'].includes(triedHere[currentMethod].verdict)) {
    currentMethod = p.method;
    rememberSetting({ ['method_' + PLATFORM.id]: currentMethod });
  }

  // Settled sites get a readout; unsettled ones get the picker, because there
  // the choice is a real experiment and the user is the one running it.
  const box = panel.querySelector('#tthd-methods');
  if (box && box.dataset.for !== PLATFORM.id + ':' + currentMethod) {
    box.dataset.for = PLATFORM.id + ':' + currentMethod;
    const all = profiles.__methods || {};
    const tried = p.tried || {};

    if (p.proven) {
      const m = all[p.method] || { label: p.method };
      box.innerHTML =
        '<div class="tthd-mlabel">Method</div>' +
        `<div class="tthd-mname">${m.label}<i>measured</i></div>` +
        `<div class="tthd-mwhat">${m.what || ''}</div>`;
    } else {
      // A method that needs a passthrough gear cannot work on a platform whose
      // measured ladder has none — and ghost specifically does harm there, so
      // this is a warning rather than a greyed-out button.
      const noPassthrough = p.research && p.research.passthroughRung === false;
      const unsuitable = (id) => noPassthrough && (all[id] || {}).needsPassthrough;

      const list = (p.methods || []).map((id) => {
        const m = all[id] || { label: id };
        const t = tried[id];
        const mark = t
          ? `<i class="tthd-tried tthd-${t.verdict === 'works' ? 'ok' : 'no'}">${t.fps} fps</i>`
          : (id === p.method ? '<i class="tthd-tried tthd-rec">use this</i>' : '');
        const cls = 'tthd-m' +
          (id === currentMethod ? ' tthd-m-on' : '') +
          (id === p.method ? ' tthd-m-rec' : '') +
          (unsuitable(id) ? ' tthd-m-risk' : '') +
          (t && t.verdict !== 'works' ? ' tthd-m-out' : '');
        const tip = unsuitable(id) ? (m.hazard || 'Not suitable here.') : (m.what || '');
        return `<button type="button" class="${cls}" data-m="${id}" ` +
          `title="${String(tip).replace(/"/g, '')}">${m.label}${mark}</button>`;
      }).join('');

      const t = tried[currentMethod];
      const cur = all[currentMethod] || {};
      // Why the recommended one is recommended, in the panel rather than only
      // in a comment — the survey is the reason and it should be readable.
      const why = currentMethod === p.method && p.research
        ? ` <b>Chosen from ${p.research.surveyed} measured ${p.label} ladders.</b>`
        : '';
      const risk = unsuitable(currentMethod)
        ? `<div class="tthd-mrisk">${cur.hazard || ''} This platform re-encodes — ` +
          `no passthrough gear was found in ${(p.research || {}).surveyed || 'the'} measured ladders.</div>`
        : '';

      box.innerHTML =
        `<div class="tthd-mlabel">Method — ${p.method ? 'suggested below' : 'not settled here'}</div>` +
        `<div class="tthd-mrow">${list}</div>` +
        risk +
        `<div class="tthd-mwhat">${cur.what || ''}${why}` +
        (t ? ` <b>Already tried: delivered ${t.fps} fps — ${t.note}.</b>` : '') + '</div>';

      box.querySelectorAll('.tthd-m').forEach((b) => {
        b.addEventListener('click', () => {
          currentMethod = b.dataset.m;
          rememberSetting({ ['method_' + PLATFORM.id]: currentMethod });
          box.dataset.for = '';
          applyProfile();
          sendSwapConfigRef();
        });
      });
    }
  }

  // The strip shows what a 120fps source becomes on THIS site: without the
  // tool, and with it. Where those are the same — YouTube and Instagram both
  // cap at 60 either way — the strip must not fill in, because the tool is
  // improving the frames rather than adding any.
  const cad = p.cadence || { off: 4, on: 1 };
  const cadence = panel.querySelector('#tthd-cadence');
  const sig = cad.off + '/' + cad.on;
  if (cadence && cadence.dataset.cad !== sig) {
    cadence.dataset.cad = sig;
    cadence.innerHTML = Array.from({ length: CADENCE_TICKS }, (_, i) =>
      `<i style="--i:${i}"` +
      (i % cad.off === 0 ? ' class="tthd-keep"' : '') +
      (i % cad.on === 0 ? ' data-on="1"' : '') + '></i>').join('');
  }
}

// applyProfile can run before build() has closed over sendSwapConfig, so the
// handler is published rather than captured.
let sendSwapConfigRef = () => {};

/**
 * The container patch needs Python 3.10+ on the server side. Saying so here
 * costs nothing; discovering it after a two-minute 4K transcode does not.
 */
function applyGhostAvailability() {
  if (!panel) return;
  const box = panel.querySelector('#tthd-hd');
  const note = panel.querySelector('#tthd-ghostnote');
  if (!box || !note) return;
  // Without the container patch there is no 120fps, so a switch labelled
  // "1080p / 120fps" would be lying. Disable it and say why.
  if (ghostAvailable === false) {
    box.checked = false;
    box.disabled = true;
    note.textContent = 'Needs Python 3.10+ on the local server.';
    panel.classList.remove('tthd-hd-on');
  } else {
    box.disabled = false;
    note.textContent = '';
    panel.classList.toggle('tthd-hd-on', box.checked);
  }
}

/**
 * Inline SVG so the marks need no network fetch and no web_accessible_resources
 * entry, and so they inherit currentColor with the rest of the panel.
 */
const MARKS = {
  tiktok:
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M16.6 5.82A4.28 4.28 0 0 1 15.54 3h-3.09v12.4a2.59 2.59 0 0 1-2.59 2.5 2.59 2.59 0 1 1 .77-5.06v-3.1a5.66 5.66 0 0 0-.77-.05A5.66 5.66 0 1 0 15.54 15.4V9.01a7.35 7.35 0 0 0 4.3 1.38V7.3a4.28 4.28 0 0 1-3.24-1.48z"/></svg>',
  youtube:
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M21.6 7.2a2.5 2.5 0 0 0-1.75-1.77C18.25 5 12 5 12 5s-6.25 0-7.85.43A2.5 2.5 0 0 0 2.4 7.2 26 26 0 0 0 2 12a26 26 0 0 0 .4 4.8 2.5 2.5 0 0 0 1.75 1.77C5.75 19 12 19 12 19s6.25 0 7.85-.43a2.5 2.5 0 0 0 1.75-1.77A26 26 0 0 0 22 12a26 26 0 0 0-.4-4.8zM10 15V9l5.2 3z"/></svg>',
  instagram:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
    '<rect x="3" y="3" width="18" height="18" rx="5"/>' +
    '<circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1.2" fill="currentColor" stroke="none"/></svg>',
};

/**
 * The sites this runs on, and how each one is branded.
 *
 * Deliberately inline. This lived in a shared platforms.js that set a global
 * for content.js to read; the logic was right but the global did not survive
 * the content-script sandbox, so every site resolved to the TikTok default.
 * inject.js never used it, so the shared file bought nothing and cost a whole
 * class of failure. The numbers still come from the server — this is only
 * branding and hostname matching.
 */
const SITES = {
  tiktok:    { id: 'tiktok',    label: 'TikTok',    host: /(^|\.)tiktok\.com$/i,    accent: '#25f4ee' },
  youtube:   { id: 'youtube',   label: 'YouTube',   host: /(^|\.)youtube\.com$/i,   accent: '#ff0033' },
  instagram: { id: 'instagram', label: 'Instagram', host: /(^|\.)instagram\.com$/i, accent: '#e1306c' },
};

/** Which site is this page? Null when the extension has no business here. */
/**
 * chrome.storage dies with the same context. These are preferences, not
 * results, so a failed write is worth swallowing — losing a remembered toggle
 * must never take down the panel that is mid-upload.
 */
function rememberSetting(obj) {
  try { if (extAlive()) chrome.storage.local.set(obj); } catch (_) {}
}

/**
 * The read half of the same guard, and it was missing.
 *
 * Writes were already protected by extAlive(), but every chrome.storage.local
 * .get() call was made directly. Reloading the extension orphans every content
 * script that is already injected — chrome.runtime.id goes undefined and any
 * chrome.* call throws 'Extension context invalidated'. During development
 * that is not an edge case, it is what happens on every single reload with a
 * TikTok tab open, and each orphaned tab contributed its own error to the
 * extension's error list.
 *
 * A read that cannot happen is not worth taking the panel down for: these are
 * remembered preferences, and the defaults are correct.
 */
function readSetting(keys, cb) {
  try {
    if (!extAlive()) return;
    chrome.storage.local.get(keys, (v) => {
      // The callback runs later, by which point the context may have gone.
      // Touching chrome.runtime.lastError here also clears it, which is what
      // stops Chrome logging 'Unchecked runtime.lastError' on its own.
      try {
        if (chrome.runtime.lastError) return;
        cb(v || {});
      } catch (_) {}
    });
  } catch (_) {}
}

function detectSite(hostname) {
  const h = String(hostname || '').toLowerCase();
  for (const s of Object.values(SITES)) if (s.host.test(h)) return s;
  return null;
}

// Falls back to TikTok only when the hostname genuinely matches nothing, which
// should not happen given the manifest's match patterns.
const PLATFORM = detectSite(location.hostname) || SITES.tiktok;

/**
 * Frames drawn on the cadence strip. One second of 120fps content would be 120
 * ticks; 48 reads cleanly at panel width while still dividing by four, which is
 * the ratio that matters — a platform decimating 120 to 30 keeps every fourth.
 */
const CADENCE_TICKS = 48;

/**
 * Stars in the field. Enough to read as a sky at 340px wide without turning the
 * panel into noise behind the text.
 */
const STAR_COUNT = 72;
// Redrawn from the server's profile once it answers; 4 is TikTok's ratio and
// the safe default for the moment before that.
const KEEP_EVERY = 4;

function fmt(b) {
  if (!b) return '0 MB';
  if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}

/**
 * Loads this site's prepared file into its upload form, if one is waiting.
 *
 * The composer's file input often does not exist at page load — Instagram's
 * lives behind a Create button, TikTok Studio renders its own after a moment —
 * so this watches for one to appear rather than looking once and giving up.
 * The entry is cleared as soon as it is used, so a file is never attached twice.
 */
async function attachPending() {
  let store;
  try { store = await chrome.storage.local.get(['pendingStage']); } catch (_) { return; }
  const pending = (store && store.pendingStage) || {};
  let mine = pending[PLATFORM.id];
  // Anything older than an hour is a leftover, not an intention.
  if (mine && mine.file && Date.now() - (mine.at || 0) > 3600e3) mine = null;

  /*
   * Nothing queued in the extension's own storage? Ask the server.
   *
   * The chrome.storage queue can only be written from the panel, which means
   * a file sitting in the output folder had no way to reach a composer without
   * someone driving the UI. /api/stage is the other half: it hands over one
   * name and forgets it, so this cannot re-attach on a later page load.
   */
  let fromServer = false;
  if ((!mine || !mine.file) && PLATFORM.id === 'tiktok') {
    /*
     * Retry, because the first attempt races the service worker.
     *
     * On a cold Chrome the MV3 worker is not running when a content script
     * fires at document_start. sendMessage is supposed to wake it, but it can
     * reject with 'Receiving end does not exist' before it comes up — and the
     * original version caught that and returned silently, which looked
     * identical to nothing being staged.
     */
    let lastErr = '';
    for (let attempt = 0; attempt < 5 && !fromServer; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 900));
      try {
        const s = await askWorker({ type: 'tthd:stage' });
        if (s && s.ok) {
          if (s.file) { mine = { file: s.file, at: Date.now() }; fromServer = true; }
          else { lastErr = ''; break; }   // reached the server, nothing staged
        } else {
          lastErr = (s && s.error) || 'worker returned nothing';
        }
      } catch (e) { lastErr = String((e && e.message) || e); }
    }
    if (lastErr) {
      // Visible, not swallowed. An empty composer with no explanation is
      // indistinguishable from the extension not running.
      els.verdict.className = 'tthd-verdict tthd-warn';
      els.verdict.textContent = 'Could not reach the staging server: ' + lastErr.slice(0, 90);
    }
  }
  if (!mine || !mine.file) return;

  // Through the worker. A page-context fetch to localhost is refused by these
  // sites' CSP — the failure that left every composer empty, silently.
  let bytes;
  try {
    const id = 'p' + Math.random().toString(36).slice(2, 10);
    const head = await askWorker({ type: 'tthd:prepFetch', id, file: mine.file });
    const out = new Uint8Array(head.bytes);
    let off = 0;
    for (let i = 0; i < head.chunks; i++) {
      const piece = await askWorker({ type: 'tthd:prepPull', id, index: i });
      const bin = atob(piece.b64);
      for (let k = 0; k < bin.length; k++) out[off++] = bin.charCodeAt(k);
    }
    bytes = out.buffer;
  } catch (e) {
    // Say so. An empty composer with no explanation is indistinguishable from
    // the extension not running at all.
    els.verdict.className = 'tthd-verdict tthd-bad';
    els.verdict.textContent = 'Could not load the prepared file: ' +
      String(e && e.message || e).slice(0, 90);
    return;
  }

  const file = new File([bytes], mine.file, { type: 'video/mp4' });

  const tryAttach = () => {
    /*
     * The SITE's input, never our own.
     *
     * The panel contains a file input of its own for drag-and-drop, and it is
     * earlier in the DOM than TikTok's, so querySelector('input[type=file]')
     * returned ours. The prepared file was dutifully attached to the
     * extension's own drop zone and the composer stayed empty, with every
     * status message reporting success.
     */
    const input = [...document.querySelectorAll('input[type=file]')]
      .find((i) => !i.closest('#tthd-panel'));
    if (!input) return false;
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  if (tryAttach()) { clearPending(); return; }

  els.verdict.className = 'tthd-verdict tthd-warn';
  els.verdict.textContent = 'Prepared file ready — open the upload picker and it will attach itself.';

  // Watch for the input to appear, and stop watching once it has.
  const obs = new MutationObserver(() => { if (tryAttach()) { obs.disconnect(); clearPending(); } });
  obs.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => obs.disconnect(), 120000);

  function clearPending() {
    // A server-staged file was already consumed by the GET that reported it,
    // so there is nothing in storage to clear for that path.
    if (fromServer) {
      els.verdict.className = 'tthd-verdict tthd-good';
      els.verdict.textContent = 'Your prepared file is attached. Check the cover, then post.';
      return;
    }
    const rest = Object.assign({}, pending);
    delete rest[PLATFORM.id];
    rememberSetting({ pendingStage: rest });
    els.verdict.className = 'tthd-verdict tthd-good';
    els.verdict.textContent = 'Your prepared file is attached. Check the cover, then post.';
  }
}

/* ------------------------------------------------------- the publish tab */

/**
 * The file dropped onto the panel, and the frames decoded from it.
 *
 * This is a real File — dropped here rather than picked through the site's
 * upload form — so its bytes are available for scrubbing. Files that go through
 * the site's own form reach us as metadata only, which is why the cover picker
 * lives on this path and not that one.
 */
let pubFile = null;
let pubUrl = null;
let pubDur = 0;
let coverMs = 0;

const STRIP_FRAMES = 8;

/** True while the Publish tab is the visible one. */
function publishTabOpen() {
  return !!(els.panePublish && !els.panePublish.hidden);
}

function switchTab(which) {
  const pub = which === 'publish';
  els.paneInspect.hidden = pub;
  els.panePublish.hidden = !pub;
  els.tabInspect.classList.toggle('tthd-tab-on', !pub);
  els.tabPublish.classList.toggle('tthd-tab-on', pub);
  els.tabInspect.setAttribute('aria-selected', String(!pub));
  els.tabPublish.setAttribute('aria-selected', String(pub));
}

/** Paints one frame into a canvas, fitted rather than stretched. */
function paint(canvas, video) {
  const ctx = canvas.getContext('2d');
  const s = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
  const w = Math.round(video.videoWidth * s), h = Math.round(video.videoHeight * s);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(video, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
}

/** Seeks a detached video once and hands back the frame. */
function frameAt(ms) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    const bail = () => resolve(null);
    v.addEventListener('error', bail, { once: true });
    v.addEventListener('loadeddata', () => {
      v.currentTime = Math.min(ms / 1000, Math.max(0, (v.duration || 0) - 0.05));
    }, { once: true });
    v.addEventListener('seeked', () => resolve(v), { once: true });
    v.src = pubUrl;
  });
}

/**
 * Builds the filmstrip: evenly spaced thumbnails across the clip.
 *
 * Decoded once and kept as canvases. Re-seeking on every drag event would make
 * the scrubber lurch, which is exactly what a cover picker must not do.
 */
async function buildStrip() {
  els.strip.innerHTML = '';
  const cells = [];
  for (let i = 0; i < STRIP_FRAMES; i++) {
    const c = document.createElement('canvas');
    c.width = 34; c.height = 60;
    c.className = 'tthd-stripcell';
    els.strip.appendChild(c);
    cells.push(c);
  }
  for (let i = 0; i < STRIP_FRAMES; i++) {
    const at = (pubDur * 1000) * (i + 0.5) / STRIP_FRAMES;
    const v = await frameAt(at);
    if (v) paint(cells[i], v);
  }
}

/** Moves the cover to a position along the strip, 0..1. */
async function setCoverFrac(frac) {
  const f = Math.max(0, Math.min(1, frac));
  coverMs = Math.round(f * pubDur * 1000);
  els.covat.textContent = (coverMs / 1000).toFixed(2) + 's';
  els.strip.style.setProperty('--at', (f * 100).toFixed(2) + '%');
  const v = await frameAt(coverMs);
  if (v) paint(els.covmain, v);
}

/** Accepts a dropped or chosen file and opens the picker on it. */
function stageForPublish(file) {
  if (!file) return;
  if (!/^video\//i.test(file.type) && !/\.(mp4|mov|mkv|webm|m4v)$/i.test(file.name)) {
    els.pubmsg.textContent = 'That is not a video file.';
    return;
  }
  if (pubUrl) { try { URL.revokeObjectURL(pubUrl); } catch (_) {} }
  pubFile = file;
  pubUrl = URL.createObjectURL(file);
  els.pubmsg.textContent = '';
  els.pubout.innerHTML = '';
  els.pubname.textContent = file.name + ' · ' + fmt(file.size);
  els.pub.hidden = false;
  // No switchTab here: the only ways to reach this are a drop while Publish is
  // already open, or the picker inside it. Both mean the tab is showing.

  const v = document.createElement('video');
  v.preload = 'metadata';
  v.addEventListener('loadedmetadata', async () => {
    pubDur = Number(v.duration) || 0;
    els.pubname.textContent =
      file.name + ' · ' + v.videoWidth + '×' + v.videoHeight + ' · ' + pubDur.toFixed(2) + 's';
    await buildStrip();
    // A third of the way in: past an intro card, before most edits have moved on.
    await setCoverFrac(1 / 3);
  }, { once: true });
  v.src = pubUrl;
}

/**
 * Account rows.
 *
 * Nothing is connected, and saying so plainly is better than a button that
 * looks live and does nothing. Posting needs each platform's official API and
 * an OAuth app registered by whoever owns the account — there is no shortcut
 * that does not mean driving a logged-in session with someone's cookies.
 */
let authRows = null;
let authMeta = null;
let authRedirect = '';
let setupOpen = null;

async function refreshAccounts() {
  try {
    const r = await askWorker({ type: 'tthd:authStatus' });
    authRows = r.rows; authMeta = r.meta; authRedirect = r.redirect;
  } catch (_) { authRows = null; }
  renderAccounts();
}

/**
 * One row per platform: a name and a button.
 *
 * The setup instructions stay folded away until Connect is pressed on a
 * platform with no client ID yet. Showing three API walkthroughs at once, to
 * someone who wanted to press a button, is how a tool feels like homework.
 */
function renderAccounts() {
  if (!els.accts) return;
  const ids = ['tiktok', 'youtube', 'instagram'];

  els.accts.innerHTML = ids.map((id) => {
    const label = (authMeta && authMeta[id] && authMeta[id].label) ||
                  (profiles && profiles[id] && profiles[id].label) || id;
    const row = authRows && authRows.find((x) => x.id === id);
    const on = row && row.connected;
    const needsId = !row || !row.clientId;
    const open = setupOpen === id;

    const state = on
      ? `<span class="tthd-acctname">${escHtml(row.name || 'Connected')}</span>`
      : (row && row.expired ? '<span class="tthd-acctexp">session expired</span>' : '');

    const meta = (authMeta && authMeta[id]) || {};
    const setup = open && authMeta && authMeta[id] ? `
      <div class="tthd-setup">
        <div class="tthd-cost${meta.review ? ' tthd-cost-slow' : ''}">${escHtml(meta.cost || '')}</div>
        <ol class="tthd-steps">
          ${authMeta[id].steps.map((t) => `<li>${escHtml(t)}</li>`).join('')}
        </ol>
        <label class="tthd-setuplab">Redirect URI — paste this into the app</label>
        <input class="tthd-setupin mono" id="tthd-redir-${id}" readonly value="${escHtml(authRedirect)}">
        <label class="tthd-setuplab">Client ID from the console</label>
        <input class="tthd-setupin mono" id="tthd-cid-${id}" placeholder="paste it here"
               value="${escHtml((row && row.clientId) || '')}">
        <div class="tthd-setuprow">
          <a class="tthd-setuplink" href="${escHtml(authMeta[id].console)}" target="_blank" rel="noopener">Open the console ↗</a>
          <button class="tthd-btn tthd-btn-sm" data-go="${id}">Sign in</button>
        </div>
      </div>` : '';

    return `<div class="tthd-acct${on ? ' tthd-acct-on' : ''}">
      <div class="tthd-acctrow">
        <span class="tthd-acctplat">${escHtml(label)}</span>
        ${state}
        <button class="tthd-conn${on ? ' tthd-conn-on' : ''}" data-conn="${id}">
          ${on ? 'Connected' : (needsId && !open ? 'Connect' : (open ? 'Cancel' : 'Connect'))}
        </button>
      </div>
      ${setup}
    </div>`;
  }).join('');

  els.accts.querySelectorAll('[data-conn]').forEach((b) => {
    b.addEventListener('click', async () => {
      const id = b.dataset.conn;
      const row = authRows && authRows.find((x) => x.id === id);
      if (row && row.connected) {
        await askWorker({ type: 'tthd:authDisconnect', id });
        return refreshAccounts();
      }
      setupOpen = setupOpen === id ? null : id;
      renderAccounts();
    });
  });

  els.accts.querySelectorAll('[data-go]').forEach((b) => {
    b.addEventListener('click', async () => {
      const id = b.dataset.go;
      const input = els.accts.querySelector('#tthd-cid-' + id);
      const clientId = (input && input.value || '').trim();
      if (!clientId) { els.pubmsg.textContent = 'Paste the client ID first.'; return; }
      b.disabled = true; b.textContent = 'Signing in…';
      try {
        await askWorker({ type: 'tthd:authConnect', id, clientId });
        setupOpen = null;
        els.pubmsg.textContent = '';
      } catch (e) {
        els.pubmsg.textContent = String(e && e.message || e).slice(0, 180);
      }
      await refreshAccounts();
    });
  });

  els.accts.querySelectorAll('.tthd-setupin[readonly]').forEach((i) => {
    i.addEventListener('focus', () => i.select());
  });
}

/** Panel text is built by hand, so anything from outside gets escaped here. */
function escHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function build() {
  if (panel || !document.body) return;
  panel = document.createElement('div');
  panel.id = 'tthd-panel';
  panel.innerHTML = `
    <div class="tthd-head">
      <span class="tthd-brand">${MARKS[PLATFORM.id] || ''}</span>
      <span class="tthd-titles">
        <span class="tthd-title">${PLATFORM.label}</span>
        <span class="tthd-sub">Upload Inspector <span class="tthd-build">v2.5.0</span></span>
      </span>
      <span class="tthd-mark"><span class="tthd-dot"></span></span>
      <button class="tthd-min" title="Collapse">–</button>
    </div>

    <div class="tthd-tabs" role="tablist">
      <button class="tthd-tab tthd-tab-on" id="tthd-tab-inspect"
              role="tab" aria-selected="true">Inspect</button>
      <button class="tthd-tab" id="tthd-tab-publish"
              role="tab" aria-selected="false">Publish</button>
    </div>

    <div class="tthd-body" id="tthd-pane-publish" hidden>
      <div class="tthd-drop" id="tthd-drop">
        <div class="tthd-droptext">Drop a video anywhere on this page</div>
        <div class="tthd-dropsub">or click to choose</div>
        <input type="file" id="tthd-pubfile" accept="video/*" hidden>
      </div>

      <div class="tthd-pub" id="tthd-pub" hidden>
        <div class="tthd-pubfile mono" id="tthd-pubname">—</div>

        <div class="tthd-covwrap">
          <canvas class="tthd-covmain" id="tthd-covmain" width="180" height="320"></canvas>
          <div class="tthd-strip" id="tthd-strip" role="slider"
               aria-label="Cover frame" tabindex="0"></div>
          <div class="tthd-covfoot">
            <span class="mono" id="tthd-covat">0.00s</span>
            <span class="tthd-dim">one cover, every platform</span>
          </div>
        </div>

        <div class="tthd-accts" id="tthd-accts"></div>
        <div class="tthd-acctnote">
          Connecting only saves the drag-and-drop. Every quality result this tool has
          measured came from files uploaded by hand, with no account connected at all —
          the encoding is what earns the quality, not the API.
        </div>

        <button class="tthd-btn tthd-primary" id="tthd-prepare">Prepare for all platforms</button>
        <button class="tthd-btn" id="tthd-stageall" hidden>Open all three composers</button>
        <div class="tthd-pubmsg" id="tthd-pubmsg"></div>
        <div class="tthd-pubout" id="tthd-pubout"></div>
      </div>
    </div>

    <div class="tthd-body" id="tthd-pane-inspect">
      <div class="tthd-stars" id="tthd-stars" aria-hidden="true"></div>

      <div class="tthd-live" id="tthd-live" hidden>
        <span class="tthd-livelabel">Playing now</span>
        <span class="tthd-livespec mono" id="tthd-livespec">—</span>
      </div>

      <div class="tthd-stage">
        <div class="tthd-cadence" id="tthd-cadence" aria-hidden="true"></div>
        <label class="tthd-hdrow">
          <span class="tthd-hdlabel" id="tthd-hdlabel">1080p</span>
          <input type="checkbox" id="tthd-hd"><span class="tthd-switch"></span>
        </label>
        <div class="tthd-methods" id="tthd-methods"></div>
        <div class="tthd-ghostnote" id="tthd-ghostnote"></div>
        <div class="tthd-hint" id="tthd-hint"></div>
      </div>

      <div class="tthd-verdict" id="tthd-verdict">Pick a video to start measuring.</div>
      <div class="tthd-swapstat" id="tthd-swapstat"></div>
      <div class="tthd-region mono" id="tthd-region" hidden></div>

      <button class="tthd-btn tthd-primary" id="tthd-report">Open quality report</button>

      <div class="tthd-adv">
        <button class="tthd-adv-toggle" id="tthd-advtoggle" aria-expanded="false">
          <span class="tthd-chev"></span>Diagnostics
          <span class="tthd-advcount" id="tthd-advcount"></span>
        </button>
        <div class="tthd-adv-body"><div><div class="tthd-adv-inner">
          <div class="tthd-row"><span>Server via</span><b id="tthd-via">—</b></div>
          <div class="tthd-row"><span>Source file</span><b id="tthd-file">waiting…</b></div>
          <div class="tthd-row"><span>Bytes uploaded</span><b id="tthd-sent">0 MB</b></div>
          <div class="tthd-enc" id="tthd-enc"></div>
          <div class="tthd-diff" id="tthd-diff"></div>

          <label class="tthd-ctl tthd-ctl-sm">
            <span class="tthd-ctl-text">
              <b>Guard mode</b>
              <i>Break in-browser re-encoding so a page has to upload the original.</i>
            </span>
            <input type="checkbox" id="tthd-guard"><span class="tthd-switch"></span>
          </label>

          <button class="tthd-btn" id="tthd-verify">Verify what ${PLATFORM.label} is serving</button>
          <div class="tthd-vout" id="tthd-vout"></div>
          <button class="tthd-btn" id="tthd-copy">Copy request log (<span id="tthd-nreq">0</span>)</button>
        </div></div></div>
      </div>
    </div>`;
  // Brand colour rides on the panel as a custom property; the starfield and
  // the mark read it, and the status colours override it when they apply.
  panel.dataset.site = PLATFORM.id;
  panel.style.setProperty('--brand', PLATFORM.accent);
  panel.style.setProperty('--brand-star', PLATFORM.accent);

  document.body.appendChild(panel);

  els = {
    pubopen: panel.querySelector('#tthd-pubopen'),
    live: panel.querySelector('#tthd-live'),
    livespec: panel.querySelector('#tthd-livespec'),
    tabInspect: panel.querySelector('#tthd-tab-inspect'),
    tabPublish: panel.querySelector('#tthd-tab-publish'),
    paneInspect: panel.querySelector('#tthd-pane-inspect'),
    panePublish: panel.querySelector('#tthd-pane-publish'),
    drop: panel.querySelector('#tthd-drop'),
    pubfile: panel.querySelector('#tthd-pubfile'),
    pub: panel.querySelector('#tthd-pub'),
    pubname: panel.querySelector('#tthd-pubname'),
    covmain: panel.querySelector('#tthd-covmain'),
    strip: panel.querySelector('#tthd-strip'),
    covat: panel.querySelector('#tthd-covat'),
    accts: panel.querySelector('#tthd-accts'),
    prepare: panel.querySelector('#tthd-prepare'),
    stageall: panel.querySelector('#tthd-stageall'),
    pubmsg: panel.querySelector('#tthd-pubmsg'),
    pubout: panel.querySelector('#tthd-pubout'),
    file: panel.querySelector('#tthd-file'),
    sent: panel.querySelector('#tthd-sent'),
    verdict: panel.querySelector('#tthd-verdict'),
    enc: panel.querySelector('#tthd-enc'),
    guard: panel.querySelector('#tthd-guard'),
    dot: panel.querySelector('.tthd-dot'),
  };

  panel.querySelector('.tthd-min').addEventListener('click', () => panel.classList.toggle('tthd-collapsed'));
  panel.querySelector('#tthd-verify').addEventListener('click', verify);
  panel.querySelector('#tthd-copy').addEventListener('click', copyRequests);
  panel.querySelector('#tthd-report').addEventListener('click', openReport);
  const hdBox = panel.querySelector('#tthd-hd');

  // The cadence strip. Off, only every fourth tick stands tall — the frames
  // TikTok keeps when it decimates 120 to 30. On, all of them do. It is the
  // claim the switch makes, drawn rather than written.
  const cadence = panel.querySelector('#tthd-cadence');
  // TikTok's ratio until the server answers with this site's.
  cadence.innerHTML = Array.from({ length: CADENCE_TICKS }, (_, i) =>
    `<i style="--i:${i}"` +
    (i % KEEP_EVERY === 0 ? ' class="tthd-keep"' : '') + ' data-on="1"></i>').join('');

  // Starfield. Positions are fixed at build time rather than animated in JS —
  // each star only twinkles and drifts via CSS, so the whole field costs one
  // compositor layer and nothing per frame on the main thread.
  const stars = panel.querySelector('#tthd-stars');
  stars.innerHTML = Array.from({ length: STAR_COUNT }, (_, i) => {
    const x = (i * 37.7) % 100;                 // spread without clustering
    const y = (i * 61.3) % 100;
    const near = i % 3 === 0;                   // a third sit closer and drift faster
    return `<i style="left:${x.toFixed(2)}%;top:${y.toFixed(2)}%;` +
      `--s:${near ? 3 : 2}px;--d:${(i % 11) * 0.42}s;--z:${near ? 1 : 0}"></i>`;
  }).join('');

  // The label states what THIS site can actually deliver. Promising 120fps on
  // a platform that caps playback at 60 would be a lie the first upload exposes.

  const paintHd = () => {
    panel.classList.toggle('tthd-hd-on', hdBox.checked && !hdBox.disabled);
  };

  const advToggle = panel.querySelector('#tthd-advtoggle');
  advToggle.addEventListener('click', () => {
    const open = panel.classList.toggle('tthd-adv-open');
    advToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  // One switch drives both halves. Neither delivers 120fps alone: the
  // transcode produces the file, the container patch is what stops TikTok
  // re-encoding it. Strength is pinned to the only mode measured to work.
  const sendSwapConfig = () => {
    window.postMessage({
      __tthdCmd: true, cmd: 'swap', value: hdBox.checked,
      options: {
        // The server owns the per-platform profile; the panel says which site it
        // is on and which technique to try, so the two cannot disagree about
        // what was produced.
        platform: PLATFORM.id,
        method: currentMethod,
        ghost: hdBox.checked,
      },
    }, '*');
  };

  sendSwapConfigRef = sendSwapConfig;

  hdBox.addEventListener('change', () => {
    paintHd();
    sendSwapConfig();
    rememberSetting({ hd: hdBox.checked });
    if (hdBox.checked) probeServer();
  });

  // A method chosen for THIS site, if one was. Keyed per platform: eliminating
  // ghost frames on YouTube says nothing about Instagram.
  readSetting(['method_' + PLATFORM.id], (v) => {
    const saved = v && v['method_' + PLATFORM.id];
    if (saved) currentMethod = saved;
    // Async, and called as a statement. Its body is wrapped, but a rejection
    // from anything it calls after the try blocks would surface as an
    // unhandled rejection against this extension.
    probeServer().catch(() => {});
  });

  readSetting(['hd', 'swap'], (v) => {
    // Carry forward the older two-switch setting: anyone who had routing on
    // wanted the result, not the plumbing.
    // Do not silently reuse a remembered TikTok upload rewrite after its
    // previously suggested method lost current verification.
    hdBox.checked = PLATFORM.id === 'tiktok' && !profiles?.tiktok?.proven
      ? false : !!(v && (v.hd !== undefined ? v.hd : v.swap));
    paintHd();
    sendSwapConfig();
    if (hdBox.checked) probeServer();
  });
  if (els.pubopen) {
    // The cover selector needs the file's bytes, which a content script never
    // receives — so the work happens on a page that has them.
    els.pubopen.addEventListener('click', () => {
      if (!extAlive()) {
        // Same recovery as everywhere else: the tab is running an orphaned copy.
        els.verdict.className = 'tthd-verdict tthd-bad';
        els.verdict.textContent = EXT_DEAD;
        return;
      }
      window.open(chrome.runtime.getURL('publish.html'), '_blank', 'noopener');
    });
  }

  els.tabInspect.addEventListener('click', () => switchTab('inspect'));
  els.tabPublish.addEventListener('click', () => switchTab('publish'));

  els.drop.addEventListener('click', () => els.pubfile.click());
  els.pubfile.addEventListener('change', () => stageForPublish(els.pubfile.files[0]));

  // Page-wide, so a video can be dropped without aiming at the panel. Drops on
  // the site's own upload form are handled by the page and never reach here.
  document.addEventListener('dragover', (e) => {
    // Lighting up while the panel is not going to accept the file is a worse
    // lie than staying dark.
    if (!publishTabOpen()) return;
    if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')) {
      panel.classList.add('tthd-dragging');
    }
  });
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) panel.classList.remove('tthd-dragging');
  });
  document.addEventListener('drop', (e) => {
    panel.classList.remove('tthd-dragging');
    // Publish is opt-in by tab. On Inspect this does nothing at all — no
    // preventDefault, no interception — so the page handles the drop exactly as
    // it would without the extension, and the normal swap path takes over.
    if (!publishTabOpen()) return;
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f || !/^video\//i.test(f.type)) return;
    // And never steal one aimed at the site's own file input.
    if (e.target && e.target.closest && e.target.closest('input[type=file]')) return;
    stageForPublish(f);
  });

  // Dragging along the strip picks the cover, the way a cover picker should.
  const scrubFrom = (clientX) => {
    const r = els.strip.getBoundingClientRect();
    if (!r.width) return;
    setCoverFrac((clientX - r.left) / r.width);
  };
  let scrubbing = false;
  els.strip.addEventListener('pointerdown', (e) => {
    scrubbing = true;
    els.strip.setPointerCapture(e.pointerId);
    scrubFrom(e.clientX);
  });
  els.strip.addEventListener('pointermove', (e) => { if (scrubbing) scrubFrom(e.clientX); });
  els.strip.addEventListener('pointerup', () => { scrubbing = false; });
  els.strip.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setCoverFrac(coverMs / (pubDur * 1000) - step); }
    if (e.key === 'ArrowRight') { e.preventDefault(); setCoverFrac(coverMs / (pubDur * 1000) + step); }
  });

  const COMPOSERS = {
    tiktok: 'https://www.tiktok.com/tiktokstudio/upload',
    youtube: 'https://studio.youtube.com/',
    // Instagram has no direct upload URL — the composer is a modal behind
    // Create. The file stages itself as soon as that input appears.
    instagram: 'https://www.instagram.com/',
  };

  els.stageall.addEventListener('click', async () => {
    // Through the worker: three window.open() calls from one click get
    // popup-blocked after the first, silently.
    try {
      const urls = ['tiktok', 'youtube', 'instagram'].map((id) => COMPOSERS[id]);
      const r = await askWorker({ type: 'tthd:prepOpen', urls });
      els.pubmsg.textContent = 'Opened ' + r.opened + ' composers. On Instagram press ' +
        'Create — the file attaches itself when the picker appears.';
    } catch (e) {
      els.pubmsg.textContent = String(e && e.message || e).slice(0, 160);
    }
  });

  els.prepare.addEventListener('click', async () => {
    if (!pubFile) return;
    els.prepare.disabled = true;
    const label = els.prepare.textContent;
    els.prepare.textContent = 'Encoding three versions…';
    els.pubmsg.textContent = '';
    els.pubout.innerHTML = '';
    try {
      const r = await fetch(SERVER + '/api/publish', {
        method: 'POST',
        headers: {
          'x-filename': encodeURIComponent(pubFile.name || 'video.mp4'),
          'x-options': JSON.stringify({ coverMs, platforms: ['tiktok', 'youtube', 'instagram'] }),
          'content-type': 'application/octet-stream',
        },
        body: pubFile,
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || 'HTTP ' + r.status);
      els.pubout.innerHTML = d.outputs.map((o) => o.error
        ? `<div class="tthd-pubrow tthd-pubbad"><b>${o.label}</b>${o.error}</div>`
        : `<div class="tthd-pubrow"><b>${o.label}</b>
           <span class="mono">${o.width}×${o.height} · ${o.fps}fps</span>
           ${o.conformed ? `<i>${o.conformed.from}→${o.conformed.to} blended</i>` : ''}</div>`).join('');
      // Remember which file belongs to which composer, so each site can load
      // its own when it opens.
      const pending = {};
      for (const o of d.outputs) if (!o.error) pending[o.platform] = { file: o.file, at: Date.now() };
      rememberSetting({ pendingStage: pending });
      els.stageall.hidden = false;
      els.pubmsg.textContent = 'Ready. "Open all three composers" loads each site with its ' +
        'own file already attached — you press Post, nothing is posted for you.';
    } catch (e) {
      els.pubmsg.textContent = String(e && e.message || e).slice(0, 160);
    }
    els.prepare.textContent = label;
    els.prepare.disabled = false;
  });

  refreshAccounts();
  attachPending();
  loadKeptIngest();

  els.guard.addEventListener('change', () => {
    window.postMessage({ __tthdCmd: true, cmd: 'guard', value: els.guard.checked }, '*');
    rememberSetting({ guard: els.guard.checked });
  });

  readSetting(['guard'], (v) => {
    const on = !!(v && v.guard);
    els.guard.checked = on;
    window.postMessage({ __tthdCmd: true, cmd: 'guard', value: on }, '*');
  });

  if (last) render(last);
}

function render(s) {
  last = s;

  // The ingest handshake outlives the page that captured it. Publishing
  // navigates away from the composer, and every report so far has been taken
  // after that — which is why this has never once shown up in one.
  if (s && ((s.uploadHeaders && s.uploadHeaders.length) ||
            (s.ingestApplied && s.ingestApplied.length))) {
    rememberSetting({
      ['ingest_' + PLATFORM.id]: {
        at: Date.now(),
        uploadHeaders: s.uploadHeaders || [],
        ingestApplied: s.ingestApplied || [],
      },
    });
  }
  if (!panel) return;

  els.file.textContent = s.file ? `${s.file.name} · ${fmt(s.file.size)}` : 'waiting…';
  // Clamp the headline figure: TikTok's chunking and checksum re-reads can make
  // the raw observed-traffic counter exceed the file size, which reads as a bug.
  els.sent.textContent = s.file && s.bytesSent > s.file.size
    ? fmt(s.file.size)
    : fmt(s.bytesSent);
  els.guard.checked = !!s.guard;

  const copyBtn = panel.querySelector('#tthd-copy');
  if (copyBtn) copyBtn.innerHTML = `Copy request log (${(s.reqs || []).length})`;

  // The drawer hides the diagnostics; this badge keeps them discoverable, so
  // "collapsed by default" never means "you missed something".
  // Which path reached the server, so a future failure starts with a fact.
  const via = panel.querySelector('#tthd-via');
  if (via) {
    via.textContent = probeTrace.via === 'browser' ? 'local browser — no server' : probeTrace.via === 'page' ? 'page fetch'
      : probeTrace.via === 'worker' ? 'service worker (page blocked)'
      : probeTrace.page || probeTrace.worker ? 'unreachable' : '—';
  }

  const badge = panel.querySelector('#tthd-advcount');
  if (badge) {
    const nReq = (s.reqs || []).length;
    badge.textContent = nReq ? nReq + ' requests' : '';
  }

  const encoded = s.encoders.filter((e) =>
    /VideoEncoder|MediaRecorder|captureStream/.test(e.api));

  els.enc.innerHTML = s.encoders.length
    ? s.encoders.map((e) => `<div class="tthd-e">${e.api}${e.detail ? ' · ' + e.detail : ''}</div>`).join('')
    : '';

  renderDiff(s);
  renderSwap(s);

  let cls = 'tthd-neutral', msg = 'Pick a video to start measuring.';

  // Armed state: transcoder routing is on and no file is staged yet. Green
  // means "ready and waiting", not "a verdict exists". Previously this sat
  // grey until a file was picked, which read as "not working".
  if (!s.file && s.swapEnabled) {
    cls = serverReachable === false ? 'tthd-warn' : 'tthd-good';
    msg = serverReachable === false
      ? (probeTrace.worker
        // Both paths failed, so the server really is unreachable.
        ? 'Not connected — start the local server with: node server.js'
        // The page was blocked but the worker never answered either, which
        // means the extension itself needs reloading rather than the server.
        : 'Blocked by this page — reload the extension at chrome://extensions')
      : 'Ready — drop or select a video.';
  }

  if (encoded.length) {
    cls = 'tthd-bad';
    msg = s.guard
      ? 'In-browser re-encoding was attempted and BLOCKED by guard mode.'
      : 'This page is re-encoding video in your browser. Turn on guard mode to stop it.';
  } else if (s.file && s.bytesSent > 0) {
    const ratio = s.bytesSent / s.file.size;
    const pct = Math.min(100, ratio * 100);
    // When the swap ran, the staged file IS our transcode, so the interesting
    // fact is "TikTok is uploading our file", not a byte-for-byte comparison
    // against an original we deliberately replaced.
    const swapped = s.swap && s.swap.phase === 'done';

    if (swapped) {
      cls = 'tthd-good';
      msg = ratio >= 0.98
        ? `Done — ${PLATFORM.label} has the full file (${fmt(s.file.size)}).`
        : `Uploading to ${PLATFORM.label} — ${pct.toFixed(0)}% (${fmt(s.bytesSent)} of ${fmt(s.file.size)}).`;
    } else if (ratio >= 0.98) {
      cls = 'tthd-good';
      msg = `Your original went up untouched (${pct.toFixed(0)}% of source). ` +
            `Nothing compressed it in the browser.`;
    } else if (ratio > 0.05) {
      // Deliberately NOT an error: TikTok chunks large uploads and re-reads
      // for checksums, so a partial figure mid-flight is normal. The old
      // wording ("something shrank it") read as a failure during a healthy
      // upload — and the raw counter could even exceed 100% on retries.
      cls = 'tthd-neutral';
      msg = `Uploading to ${PLATFORM.label} — ${pct.toFixed(0)}% (${fmt(s.bytesSent)} of ${fmt(s.file.size)}).`;
    } else {
      msg = 'Upload starting…';
    }
  } else if (s.file) {
    msg = 'File staged. Start the upload to measure.';
  }

  // Whatever is on screen right now — someone else's post as readily as your
  // own. This is the answer to "what did they actually get?".
  if (els.live) {
    const L = s && s.live;
    if (!L || !L.width) {
      els.live.hidden = true;
    } else {
      els.live.hidden = false;
      const short = Math.min(L.width, L.height);
      const rate = L.fps ? L.fps.toFixed(2).replace(/\.00$/, '') + ' fps' : 'measuring…';
      els.livespec.textContent = L.width + '×' + L.height + ' · ' + rate;
      // Green only once there is a real number behind it.
      els.livespec.className = 'tthd-livespec mono' +
        (!L.fps ? '' : L.fps >= 100 ? ' tthd-hi' : (short >= 1080 ? ' tthd-mid' : ''));
    }
  }

  els.verdict.className = 'tthd-verdict ' + cls;
  els.verdict.textContent = msg;
  els.dot.className = 'tthd-dot ' + cls;
}

/* ------------------------------------------------------ local transcode */

/**
 * A full-page overlay while the swap is in flight. The panel's small status
 * line was easy to miss, and the user rightly expected the extension to
 * visibly "take" the file the way the paid tool's custom upload screen does.
 * Shown only between intercept and swap-complete; removed on done/error.
 */
let overlayDoneTimer = null;
// The success card must show ONCE per swap, then stay gone. State broadcasts
// keep arriving while TikTok uploads, and each one used to find the card
// already removed by its own timer and re-create it — so "Transcode complete"
// flashed back every couple of seconds. This latches until a new swap starts.
let overlayDoneHandled = false;

function renderOverlay(w) {
  let ov = document.getElementById('tthd-overlay');
  if (!w) { if (ov) ov.remove(); return; }

  // 'working' is the phase the worker reports now; the older two names are
  // still accepted so a stale page script cannot lose its overlay mid-upload.
  const inflight = w.phase === 'working' || w.phase === 'uploading' || w.phase === 'transcoding';
  const isError = w.phase === 'error';
  const isDone = w.phase === 'done';

  // The overlay used to exist only while in flight, so an error (or a fast
  // transcode) made it vanish in a frame — the user saw "2% for 0.25 s" and
  // nothing else. Now: errors PERSIST until dismissed (the visible half of the
  // no-fallback policy), and `done` holds for a moment so success is seen.
  if (!inflight && !isError && !isDone) { if (ov) ov.remove(); return; }

  // A new transcode resets the latch so the next success card can show.
  if (inflight) overlayDoneHandled = false;

  // Already showed-and-dismissed the success card for this swap: stay gone.
  if (isDone && overlayDoneHandled) { if (ov) ov.remove(); return; }

  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'tthd-overlay';
    ov.innerHTML = `
      <div class="tthd-ov-card">
        <div class="tthd-ov-title" id="tthd-ov-title">Upload Inspector has your file</div>
        <div class="tthd-ov-sub" id="tthd-ov-sub"></div>
        <div class="tthd-ov-bar"><i id="tthd-ov-fill"></i></div>
        <div class="tthd-ov-note" id="tthd-ov-note"></div>
        <button class="tthd-ov-x" id="tthd-ov-x">Dismiss</button>
      </div>`;
    document.body.appendChild(ov);
    ov.querySelector('#tthd-ov-x').addEventListener('click', () => ov.remove());
  }

  const card = ov.querySelector('.tthd-ov-card');
  const fill = ov.querySelector('#tthd-ov-fill');
  const title = ov.querySelector('#tthd-ov-title');
  const sub = ov.querySelector('#tthd-ov-sub');
  const note = ov.querySelector('#tthd-ov-note');
  const dismiss = ov.querySelector('#tthd-ov-x');

  clearTimeout(overlayDoneTimer);
  card.classList.toggle('tthd-ov-err', isError);
  card.classList.toggle('tthd-ov-ok', isDone);
  dismiss.style.display = isError ? '' : 'none';

  if (isError) {
    title.textContent = 'Failed — nothing was uploaded';
    sub.textContent = w.note || 'unknown error';
    fill.style.width = '100%';
    note.textContent = `${PLATFORM.label} has not received this file. Fix the problem and drop it again, ` +
      'or switch off 1080p / 120fps to upload the original.';
    return;
  }

  if (isDone) {
    overlayDoneHandled = true;
    title.textContent = 'Ready';
    sub.textContent = w.note || '';
    fill.style.width = '100%';
    note.textContent = `Uploading to ${PLATFORM.label}.`;
    overlayDoneTimer = setTimeout(() => {
      const e = document.getElementById('tthd-overlay');
      if (e) e.remove();
    }, 2500);
    return;
  }

  // In flight. Floor at 2% so the bar is visibly present from the first tick.
  const pct = Math.max(2, Math.min(100, Number(w.pct) || 0));
  title.textContent = 'Working';
  fill.style.width = pct + '%';
  sub.textContent = Math.round(pct) + '%';
  // Direction, not narration. The reader does not need to know which machine is
  // busy — only that leaving is what would break it.
  note.textContent = 'Keep this tab open until it finishes.';
}

/**
 * Which of TikTok's ingest regions is receiving this upload, shown while it is
 * still in progress.
 *
 * The region decides whether 120fps survives: the identical file was crushed
 * through useast8 and passed at 2160x3840/120 through an APAC host. TikTok picks
 * it from the uploader's IP when the upload starts, so a VPN has to be routing
 * traffic at that moment — being connected is not enough, and there is no
 * feedback when it is not. One 4K/120 attempt was read as the method failing
 * when every chunk had gone to useast8 the whole time.
 *
 * The quality report says this too, but only after the fact. This says it while
 * there is still time to cancel.
 */
// Names only. These carried a keeps-120 verdict, which was an inference from
// one 4K/120 pass whose report turned out to have recorded no upload at all —
// and a later upload made on a Singapore VPN still went to useast8, so the
// region may not even be selectable. Report where the bytes went; let the
// delivered result say what it means.
const REGIONS = {
  useast8: 'US East', useast2a: 'US East', useast5: 'US East',
  maliva: 'US', alisg: 'Singapore', sg1: 'Singapore', no1a: 'Norway',
};
function renderRegion(hostBytes) {
  const el = panel.querySelector('#tthd-region');
  if (!el) return;
  const hosts = Object.keys(hostBytes || {});
  const ingest = hosts.find((h) => /-up-/i.test(h));
  if (!ingest) { el.hidden = true; return; }

  const m = /-up-([a-z0-9]+)/i.exec(ingest);
  const key = m ? m[1].toLowerCase() : '';
  const place = REGIONS[key];

  el.hidden = false;
  el.dataset.ok = '';
  el.textContent = '→ uploading to ' + (key || ingest) +
    (place ? ' (' + place + ')' : '');
}

function renderSwap(s) {
  renderRegion(s.hostBytes);
  const box = panel.querySelector('#tthd-swapstat');
  const cb = panel.querySelector('#tthd-hd');
  if (!box) return;
  if (cb && typeof s.swapEnabled === 'boolean') {
    cb.checked = s.swapEnabled;
    panel.classList.toggle('tthd-hd-on', s.swapEnabled && !cb.disabled);
  }

  const w = s.swap;
  renderOverlay(w);
  if (!w) { box.innerHTML = ''; return; }

  const pct = Math.max(0, Math.min(100, Number(w.pct) || 0));
  const cls = w.phase === 'error' ? 'tthd-bad' : w.phase === 'done' ? 'tthd-good' : 'tthd-warn';
  // What the reader needs is how far along it is, not how the machine is
  // built. The percentage does the talking while it runs.
  const label = {
    working: `Working · ${Math.round(pct)}%`,
    uploading: `Working · ${Math.round(pct)}%`,
    transcoding: `Working · ${Math.round(pct)}%`,
    done: `Ready — uploading to ${PLATFORM.label}`,
    error: 'Failed — nothing was uploaded',
  }[w.phase] || w.phase;

  // Mid-run the note would only repeat the mechanism, so it is dropped; on
  // finish it carries the one fact worth having, which is what came out.
  const note = (w.phase === 'done' || w.phase === 'error') ? (w.note || '') : '';

  box.innerHTML =
    `<div class="tthd-swaphead ${cls}">${label}</div>` +
    (w.phase !== 'done' && w.phase !== 'error'
      ? `<div class="tthd-bar"><i style="width:${pct}%"></i></div>` : '') +
    (note ? `<div class="tthd-swapnote">${note}</div>` : '');
}

/* ------------------------------------------------------------ byte diff */

/**
 * Shows how the bytes actually uploaded differ from the file that was picked.
 * When another tool patches the MP4 container before upload, this is where it
 * shows up — with the exact box, offset and before/after value.
 */
function renderDiff(s) {
  const box = panel.querySelector('#tthd-diff');
  if (!box) return;

  const parts = [];

  if (s.hookTamper && s.hookTamper.length) {
    // These are NOT errors. TikTok's own monitoring SDKs (webmssdk, secsdk —
    // visible in the page's stack traces) re-wrap XHR/fetch on load, so these
    // three show up on every visit with no other tool installed. It was rendered
    // as red error boxes under "ANOTHER TOOL", which read as three failures.
    // Show it as a neutral observation and name the likely source.
    parts.push(
      `<div class="tthd-dhead tthd-dhead-info">Upload path is also observed by (normal — ${PLATFORM.label}'s own scripts do this)</div>` +
      `<div class="tthd-obs">${s.hookTamper.map((h) => `<code>${h}</code>`).join(' · ')}</div>`
    );
  }

  const d = s.diff;
  if (d) {
    if (d.note) {
      parts.push(`<div class="tthd-dhead">Container diff</div><div class="tthd-dnote">${d.note}</div>`);
    } else if (d.identical) {
      parts.push(
        `<div class="tthd-dhead">Container diff</div>` +
        `<div class="tthd-dnote tthd-okc">moov uploaded byte-for-byte identical — nothing rewrote the container.</div>`
      );
    } else {
      parts.push(
        `<div class="tthd-dhead">Container was modified before upload — ${d.diffs.length} change${d.diffs.length === 1 ? '' : 's'}</div>` +
        d.diffs.slice(0, 8).map((x) =>
          `<div class="tthd-d">` +
          `<div class="tthd-dbox">${x.box}</div>` +
          `<div class="tthd-dval">was <b>${x.before}</b>${x.beforeU32 !== null ? ` <span class="tthd-dnum">(u32 ${x.beforeU32})</span>` : ''}</div>` +
          `<div class="tthd-dval">now <b>${x.after}</b>${x.afterU32 !== null ? ` <span class="tthd-dnum">(u32 ${x.afterU32})</span>` : ''}</div>` +
          `</div>`).join('')
      );
    }
  } else if (s.hasOriginal) {
    parts.push(`<div class="tthd-dnote">Original container captured. Start the upload to compare.</div>`);
  }

  box.innerHTML = parts.join('');
}

/* ---------------------------------------------------------- full report */

// TikTok can briefly serve the uploaded original while a post is under review,
// then replace it with the finished rendition ladder. Read the current post's
// embedded item rather than treating that temporary player file as the result.
function currentPublication() {
  if (location.hostname.endsWith('instagram.com')) {
    const code = /\/(?:reel|p)\/([^/]+)/.exec(location.pathname)?.[1];
    return code ? instagramPublication([...document.querySelectorAll('script[type="application/json"]')].map(s => s.textContent), code) : null;
  }
  const id = /\/video\/(\d+)/.exec(location.pathname)?.[1];
  if (!id || !location.hostname.endsWith('tiktok.com')) return null;
  try {
    const raw = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent;
    if (!raw) return null;
    const item = JSON.parse(raw).__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
    if (String(item?.id) !== id) return null;
    const video = item.video || {};
    return {
      platform: 'TikTok', id, reviewing: typeof item.isReviewing === 'boolean' ? item.isReviewing : null,
      private: !!item.privateItem, createdAt: Number(item.createTime) * 1000 || null,
      playUrl: video.playAddr || video.PlayAddrStruct?.UrlList?.[0] || '',
      declared: { width: Number(video.width) || 0, height: Number(video.height) || 0,
        quality: video.videoQuality || '', codec: video.codecType || '' },
      definition: video.definition || '',
      renditions: (video.bitrateInfo || []).map((g) => ({
        gear: g.GearName || '', fps: Number(g.BitrateFPS) || 0,
        width: Number(g.PlayAddr?.Width) || 0,
        height: Number(g.PlayAddr?.Height) || 0,
        bitrate: Number(g.Bitrate) || 0,
        url: (g.PlayAddr?.UrlList || []).find((u) => typeof u === 'string') || '',
      })),
    };
  } catch (_) { return null; }
}

/**
 * Ships everything observed to the local server, which probes every rendition
 * with ffprobe and renders a standalone report page. TikTok Studio exposes none
 * of this, so decoding what their CDN actually serves is the only ground truth.
 */
/**
 * Fetch each declared rendition through the SERVICE WORKER and ffprobe it.
 *
 * The in-page sweep cannot do this: tiktok.com's CSP blocks a direct
 * connection to the video CDN, which showed up as
 *   original_1080_0 · MEDIA_ERR_SRC_NOT_SUPPORTED · bytes blocked (TypeError)
 * The worker is exempt from page CSP and holds the extension's
 * host_permissions, so it can fetch what the page cannot. ffprobe on the real
 * bytes also beats decoded-frame sampling: exact nb_frames and r_frame_rate.
 */
async function probeLadderViaWorker(onProgress) {
  const seen = new Set();
  const targets = [];
  for (const g of (last && last.ladder) || []) {
    if (g && g.url && !seen.has(g.url)) { seen.add(g.url); targets.push({ gear: g.gear || '', url: g.url, declared: g }); }
  }
  for (const u of (last && last.media) || []) {
    if (typeof u === 'string' && !seen.has(u)) { seen.add(u); targets.push({ gear: '', url: u, declared: null }); }
  }
  // Original-quality gears first — they are the ones that would carry an
  // untranscoded frame rate, and the sweep may be cut short by a slow CDN.
  targets.sort((a, b) => (/origin/i.test(b.gear) ? 1 : 0) - (/origin/i.test(a.gear) ? 1 : 0));

  const out = [];
  for (let i = 0; i < Math.min(targets.length, 8); i++) {
    const t = targets[i];
    if (onProgress) onProgress(i + 1, Math.min(targets.length, 8), t.gear);
    let r;
    try {
      r = await askWorker({ type: 'tthd:probeRendition', url: t.url });
    } catch (e) {
      r = { ok: false, error: 'worker unreachable: ' + String(e && e.message || e) };
    }
    out.push(r && r.ok
      ? { gear: t.gear, url: t.url, declared: t.declared, info: r.info, bytes: r.bytes, partial: r.partial }
      : { gear: t.gear, url: t.url, declared: t.declared, error: (r && r.error) || 'no reply from the worker' });
  }
  return out;
}

/**
 * The last ingest handshake seen on this host, if it is recent.
 *
 * Read once at start-up rather than at report time so a slow storage round trip
 * cannot land after the payload has been assembled.
 */
let keptIngest = { uploadHeaders: [], ingestApplied: [] };

function loadKeptIngest() {
  const k = 'ingest_' + PLATFORM.id;
  try {
    readSetting([k], (v) => {
      const kept = v && v[k];
      if (!kept) return;
      // An hour is long enough to publish and come back; older than that and it
      // belongs to some other upload entirely.
      if (Date.now() - (kept.at || 0) > 3600e3) return;
      keptIngest = {
        uploadHeaders: kept.uploadHeaders || [],
        ingestApplied: kept.ingestApplied || [],
      };
    });
  } catch (_) {}
}

async function openReport() {
  const btn = panel.querySelector('#tthd-report');
  const original = btn.textContent;
  btn.disabled = true;

  // Measure the player first. This is the primary result, and doing it here
  // means the report is one click rather than a console snippet.
  if (document.querySelector('video')) {
    const beforeSeq = last && last.pageVideo && last.pageVideo.seq;
    btn.textContent = 'Measuring the player… 5s';
    window.postMessage({ __tthdCmd: true, cmd: 'measure', sampleMs: 5000 }, '*');
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 300));
      if (last && last.pageVideo && !last.measuring &&
          (beforeSeq == null || last.pageVideo.seq !== beforeSeq)) break;
    }
  }

  btn.textContent = 'Building report…';

  const payload = {
    source: last && last.file ? last.file : null,
    bytesSent: (last && last.bytesSent) || 0,
    ladder: (last && last.ladder) || [],
    media: (last && last.media) || [],
    diff: (last && last.diff) || null,
    pageVideo: (last && last.pageVideo) || null,
    ladderMeasured: (last && last.ladderMeasured) || null,
    /*
     * These three were captured in the page and then dropped on the floor:
     * this payload is built field by field and none of them was ever listed,
     * so the report's codec card could not render no matter what the page
     * read. Two days of 'the codec never appears' was this line missing.
     */
    codecs: (last && last.codecs) || [],
    codecProbe: (last && last.codecProbe) || null,
    decode: (last && last.decode) || null,
    sps: (last && last.sps) || [],
    // The panel's own build, and the build of the page hook it is talking to.
    // When these differ the tab needs reloading, and the report has to say so
    // out loud — a silently missing card is indistinguishable from a
    // measurement that genuinely failed.
    build: '2.8.0',
    pageBuild: (last && last.build) || null,
    // ffprobe results from bytes the worker fetched — authoritative, and the
    // only path that reaches gears the page's CSP blocks.
    ladderProbed: null,
    hookTamper: (last && last.hookTamper) || [],
    // Where the file physically went, in order. This is what distinguishes a
    // local transcode from a straight-to-TikTok upload when reading a report.
    route: (last && last.route) || [],
    // Byte totals per host, accumulated independently of the display ring.
    hostBytes: (last && last.hostBytes) || {},
    // The upload requests themselves — credential-shaped values already
    // stripped in the page hook. This is where a frame-rate cap would be
    // lifted, so it belongs in the report rather than behind a second button.
    reqs: (last && last.reqs) || [],
    // What the page told Instagram's ingest about the file, and any rewrite
    // applied on the way out. This is the only part of Meta's transcode
    // decision that is composed inside the browser, so it is the only part an
    // extension can read or change.
    // Which encoding APIs the PAGE invoked. If instagram.com re-encodes in the
    // browser before uploading, nothing we send survives to reach Meta at all,
    // and every delivery result we have is really a result about the composer.
    encoders: (last && last.encoders) || [],
    // Falls back to the kept copy. The useful report is the one run from the
    // published post, and by then the page that captured this has navigated
    // away — which is why the handshake has never once appeared in a report.
    uploadHeaders: (last && last.uploadHeaders && last.uploadHeaders.length)
      ? last.uploadHeaders : keptIngest.uploadHeaders,
    ingestApplied: (last && last.ingestApplied && last.ingestApplied.length)
      ? last.ingestApplied : keptIngest.ingestApplied,
    pageUrl: location.href,
    publication: currentPublication(),
  };

  // An upload-side report (container diff, hooks, source file) is worth saving
  // on its own — delivery can be measured later, from the published video.
  // A measurement of the video on this page is a complete result on its own —
  // it is in fact the PRIMARY one, and the only signal that exists on sites
  // with no scrapeable rendition ladder. Leaving it out of this check is why
  // YouTube reported "nothing observed" while the measurement sat in hand.
  const measured = payload.pageVideo &&
    (payload.pageVideo.width || payload.pageVideo.measuredFps || payload.pageVideo.player);

  const hasAnything =
    measured || payload.publication || payload.ladder.length || payload.media.length ||
    payload.diff || payload.hookTamper.length || payload.source ||
    payload.uploadHeaders.length;

  if (!hasAnything) {
    btn.textContent = 'Nothing observed yet';
    btn.disabled = false;
    setTimeout(() => { btn.textContent = original; }, 2600);
    return;
  }

  try {
    const d = await askWorker({ type: 'tthd:localReport', payload });
    if (!d || !d.ok) throw new Error(d && d.error || 'Report could not open');
    btn.textContent = 'Report opened ↗';
  } catch (e) {
    btn.textContent = 'Report failed: ' + String(e && e.message || e).slice(0, 60);
  }
  btn.disabled = false;
  setTimeout(() => { btn.textContent = original; }, 3000);
}

/* ------------------------------------------------- upload request capture */

/**
 * Dumps the upload-related requests TikTok Studio made, with credential-shaped
 * values already stripped in the page hook. This is the raw material for
 * working out whether anything client-settable influences the transcode.
 */
function copyRequests() {
  const btn = panel.querySelector('#tthd-copy');
  const reqs = (last && last.reqs) || [];
  if (!reqs.length) {
    btn.textContent = 'Nothing captured yet — upload first';
    setTimeout(() => render(last), 2200);
    return;
  }

  const text = reqs.map((r, n) => {
    const lines = [`[${n + 1}] ${r.method} ${r.url}`];
    if (r.params.length) {
      lines.push('  query:');
      for (const [k, v] of r.params) lines.push(`    ${k} = ${v}`);
    }
    if (r.bodyParams.length) {
      lines.push('  body:');
      for (const [k, v] of r.bodyParams) lines.push(`    ${k} = ${v}`);
    }
    return lines.join('\n');
  }).join('\n\n');

  const header =
    `${PLATFORM.label} upload request log\n` +
    `source file: ${last.file ? last.file.name + ' (' + last.file.size + ' bytes)' : 'n/a'}\n` +
    `bytes sent: ${last.bytesSent}\n` +
    `captured requests: ${reqs.length}\n` +
    `(values matching token/sig/auth/session/device patterns are redacted)\n\n`;

  navigator.clipboard.writeText(header + text).then(
    () => { btn.textContent = 'Copied — paste it to Claude'; setTimeout(() => render(last), 2500); },
    () => { btn.textContent = 'Clipboard blocked — see console'; console.log(header + text); }
  );
}

/* ------------------------------------------------------------------ verify */

/**
 * Asks the local TikTok HD Prep server to ffprobe the video TikTok's own player
 * is fetching. This is the only way to settle what TikTok actually delivers, as
 * opposed to what you handed it. Requires `node server.js` to be running.
 */
async function verify() {
  const out = panel.querySelector('#tthd-vout');
  const url = last && last.media && last.media[last.media.length - 1];

  if (!url) {
    out.className = 'tthd-vout tthd-warn';
    out.textContent = 'No video stream seen yet. Open the published video and let it play for a second, then try again.';
    return;
  }

  const urls = last.media.slice(-12);
  out.className = 'tthd-vout';
  out.textContent = `Probing ${urls.length} rendition${urls.length > 1 ? 's' : ''}…`;

  let r, d;
  try {
    r = await fetch('http://localhost:7654/api/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ urls }),
    });
    d = await r.json();
  } catch (_) {
    out.className = 'tthd-vout tthd-bad';
    out.textContent = 'Could not reach the local server. Start it with:  node server.js';
    return;
  }

  if (!r.ok || d.error) {
    out.className = 'tthd-vout tthd-bad';
    out.textContent = d.error || 'Probe failed.';
    return;
  }

  // Only renditions that actually decoded as video, best first.
  const found = (d.results || [])
    .filter((x) => x.info && x.info.width)
    .sort((a, b) =>
      (b.info.width * b.info.height) - (a.info.width * a.info.height) ||
      (b.info.bitrate - a.info.bitrate));

  if (!found.length) {
    out.className = 'tthd-vout tthd-warn';
    out.textContent = 'None of the captured URLs decoded as video. Let the published video play for a few seconds, then retry.';
    return;
  }

  // Dedupe renditions that are the same shape and bitrate.
  const seen = new Set();
  const ladder = found.filter((x) => {
    const k = `${x.info.width}x${x.info.height}@${Math.round(x.info.bitrate / 1e5)}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  const best = ladder[0].info;
  const shortSide = Math.min(best.width, best.height);
  const is1080 = shortSide >= 1080;

  out.className = 'tthd-vout ' + (is1080 ? 'tthd-good' : 'tthd-warn');
  out.innerHTML =
    `<div class="tthd-vrow"><span>Best rendition</span><b>${best.width}×${best.height}</b></div>` +
    `<div class="tthd-vrow"><span>Frame rate</span><b>${best.fps} fps</b></div>` +
    `<div class="tthd-vrow"><span>Bitrate</span><b>${best.bitrate ? (best.bitrate / 1e6).toFixed(2) + ' Mbps' : '—'}</b></div>` +
    `<div class="tthd-vrow"><span>Codec</span><b>${(best.codec || '').toUpperCase()}</b></div>` +
    (ladder.length > 1
      ? `<div class="tthd-ladder"><div class="tthd-lhead">All ${ladder.length} renditions served</div>` +
        ladder.map((x) =>
          `<div class="tthd-l">${x.info.width}×${x.info.height} · ${x.info.fps}fps · ` +
          `${(x.info.bitrate / 1e6).toFixed(2)} Mbps · ${(x.info.codec || '').toUpperCase()}</div>`).join('') +
        `</div>`
      : '') +
    `<div class="tthd-vmsg">${
      is1080
        ? `Top rung is ${shortSide}p at ${best.fps} fps.`
        : `Top rung is only ${shortSide}p at ${best.fps} fps — ${PLATFORM.label} has no 1080 rendition of this video.`
    }</div>`;
}

/* --------------------------------------------- transcode relay (page↔worker) */

/**
 * Relay upload id -> the page request id that is waiting on it.
 *
 * The worker only knows the upload it was handed, so its progress messages are
 * addressed with that id. The page filters on its own request id and silently
 * drops anything else, so the two have to be reconciled somewhere. Here is the
 * only place that sees both.
 */
const relayJobs = new Map();

/**
 * The page world cannot reach http://localhost from https://tiktok.com — the
 * browser blocks it silently before any request leaves. The service worker
 * can. So the page posts the file here, this isolated-world script forwards it
 * to background.js, relays progress back, and returns the transcoded bytes.
 * Bytes travel as ArrayBuffers (a File is not cloneable over runtime messages).
 */
/**
 * The fetch happens HERE, in the isolated-world content script — not in the
 * page (blocked: public-HTTPS page -> http://localhost) and not relayed to the
 * service worker (chrome.runtime.sendMessage JSON-serialises its payload, and
 * an ArrayBuffer becomes {} — the worker POSTed an empty body and the server
 * rightly said "No video stream found"). An MV3 content script makes network
 * requests with the extension's own host_permissions, exempt from the page's
 * CSP/PNA/mixed-content rules, AND it can hold the real bytes. One hop, no
 * serialisation.
 */
const SERVER = 'http://localhost:7654';

/**
 * Every call into the service worker goes through here.
 *
 * chrome.runtime.id is present only while this content script is still attached
 * to a live extension. Reloading the extension at chrome://extensions orphans
 * the script: it keeps running and keeps drawing the panel, but chrome.runtime
 * is gone and every message throws. Checking first turns an unrecoverable-
 * looking TypeError into the one sentence that fixes it.
 */
const EXT_DEAD = 'This page is running an old copy of the extension — reload the page (F5) to reconnect.';

function extAlive() {
  try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
}

async function askWorker(message) {
  if (!extAlive()) throw new Error(EXT_DEAD);
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (e) {
    // Chrome words this as "Extension context invalidated", which is accurate
    // and tells nobody what to do about it.
    if (/context invalidated|receiving end does not exist/i.test(String(e && e.message))) {
      throw new Error(EXT_DEAD);
    }
    throw e;
  }
}

window.addEventListener('message', async (e) => {
  const d = e.data;
  if (!d || d.__tthdCmd !== true || d.cmd !== 'process') return;
  const { id, name, options, bytes } = d;
  if (!id || !bytes) return;

  const post = (kind, extra) => window.postMessage(Object.assign({ __tthd: true, kind, id }, extra), '*');
  const progress = (phase, pct, note) => post('processProgress', { phase, pct, note });

  /**
   * Sends the upload through the service worker.
   *
   * Used when the page itself cannot reach localhost — Instagram's CSP refuses
   * that connection, and the worker is exempt from it. Bytes cross as base64 in
   * pieces because Chrome's message channel is JSON: an ArrayBuffer sent whole
   * arrives as {}, which is the bug that once had the server logging a 15-byte
   * body reading "[object Object]".
   */
  const viaWorker = async (bytes, jobId) => {
    const upId = 'u' + Math.random().toString(36).slice(2, 10);
    // So the worker's progress can find its way back to this request.
    relayJobs.set(upId, id);
    const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

    const send = async (m) => {
      const r = await askWorker(m);
      if (!r || !r.ok) throw new Error((r && r.error) || 'the extension worker did not reply');
      return r;
    };

    await send({ type: 'tthd:upInit', id: upId, name, options, jobId });

    const CH = 3 * 1024 * 1024;
    for (let i = 0; i < src.length; i += CH) {
      const part = src.subarray(i, i + CH);
      let bin = '';
      for (let k = 0; k < part.length; k += 0x8000) {
        bin += String.fromCharCode.apply(null, part.subarray(k, k + 0x8000));
      }
      await send({ type: 'tthd:upChunk', id: upId, b64: btoa(bin) });
      // Bytes SENT, not the offset before sending. A file small enough to fit
      // in one chunk reported (0 / length) * 6 = 0% and never moved off it.
      progress('working', ((i + part.length) / src.length) * 6, '');
    }

    // The chunks are away; the encode owns 6-92 from here. Say so explicitly so
    // there is no dead interval before the first progress frame arrives.
    progress('working', 6, 'encoding on your machine');

    const done = await send({ type: 'tthd:upSend', id: upId });

    // Pulled one piece per message. Asking for them all in a single response is
    // what stalled this path before — the split has to happen across messages
    // to mean anything.
    const out = new Uint8Array(done.bytes);
    let off = 0;
    for (let i = 0; i < done.chunks; i++) {
      const piece = await send({ type: 'tthd:upPull', id: upId, index: i });
      const bin = atob(piece.b64);
      for (let k = 0; k < bin.length; k++) out[off++] = bin.charCodeAt(k);
      progress('working', 92 + ((i + 1) / done.chunks) * 8, '');
    }
    relayJobs.delete(upId);
    return { name: done.name, info: done.info, bytes: out.buffer };
  };

  /**
   * Follows the server's encode progress.
   *
   * The encode is the long phase and it happens entirely between the request
   * and the response, so without this the bar has nothing to report and sits
   * frozen. The job does not exist until the whole body has arrived, hence the
   * retry loop; SSE is parsed by hand because this needs to be abortable.
   */
  const followProgress = async (jobId, onPct, stop) => {
    const deadline = Date.now() + 20 * 60 * 1000;
    while (!stop.done && Date.now() < deadline) {
      let res = null;
      try { res = await fetch(`${SERVER}/api/progress/${encodeURIComponent(jobId)}`, { cache: 'no-store' }); }
      catch (_) { /* server not up yet, or the job has not been created */ }

      if (!res || !res.ok || !res.body) { await new Promise((r) => setTimeout(r, 250)); continue; }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        let chunk;
        try { chunk = await reader.read(); } catch (_) { break; }
        if (chunk.done || stop.done) break;
        buf += dec.decode(chunk.value, { stream: true });
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
  };

  try {
    // The buffer arrives from the PAGE realm. The isolated world has its own
    // ArrayBuffer constructor, so `instanceof` lies and — worse — handing the
    // foreign-realm buffer straight to XMLHttpRequest.send() made Chrome coerce
    // it to a string: the server received exactly 15 bytes, "[object Object]".
    // Wrapping in a Blob is realm-agnostic and gives XHR a real binary body.
    const size = bytes.byteLength != null ? bytes.byteLength : (bytes.size != null ? bytes.size : 0);
    if (!size) throw new Error('file buffer arrived empty (0 bytes) — cannot transcode');
    const body = new Blob([bytes], { type: 'application/octet-stream' });
    if (body.size !== size) throw new Error(`buffer size mismatch: ${size} bytes in, ${body.size} in Blob`);

    // Ours, so the progress stream can be opened before the response exists.
    const jobId = 'j' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
    const stop = { done: false };

    progress('working', 1, '');

    // Sending owns 0-6, the encode owns 6-92, receiving owns the last 8.
    followProgress(jobId, (encodePct) => {
      if (stop.done) return;
      progress('working', 6 + Math.max(0, Math.min(100, encodePct)) * 0.86, '');
    }, stop).catch(() => {});

    // XHR rather than fetch: it reports upload progress for a 100 MB+ body.
    const direct = () => new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', SERVER + '/api/process');
      x.setRequestHeader('x-filename', encodeURIComponent(name || 'video.mp4'));
      x.setRequestHeader('x-options', JSON.stringify(options || {}));
      x.setRequestHeader('x-job-id', jobId);
      x.setRequestHeader('content-type', 'application/octet-stream');
      x.responseType = 'arraybuffer';
      x.upload.onprogress = (ev) => {
        if (ev.lengthComputable) progress('working', (ev.loaded / ev.total) * 6, '');
      };
      // The encode starts here; the SSE stream takes over reporting from 6%.
      x.upload.onload = () => progress('working', 6, '');
      // Receiving the result is the last 8%.
      x.onprogress = (ev) => {
        if (!ev.lengthComputable) return;
        stop.done = true;
        progress('working', 92 + (ev.loaded / ev.total) * 8, '');
      };
      x.onload = () => {
        stop.done = true;
        if (x.status !== 200) {
          let msg = 'HTTP ' + x.status;
          try { msg = JSON.parse(new TextDecoder().decode(x.response)).error || msg; } catch (_) {}
          return reject(new Error(msg));
        }
        // Unwrap here so the caller never has to know which path ran. The
        // relay cannot hand back an XHR, so the XHR stops being the currency.
        let inf = {};
        try { inf = JSON.parse(decodeURIComponent(x.getResponseHeader('x-out-info') || '{}')); } catch (_) {}
        resolve({
          name: decodeURIComponent(x.getResponseHeader('x-out-name') || name || 'video.mp4'),
          info: inf,
          bytes: x.response,
        });
      };
      x.onerror = () => {
        stop.done = true;
        // Blocked before leaving the page, or the server is down — the page
        // cannot tell which. The worker can reach one but not the other, so
        // asking it is both the fallback and the diagnosis.
        reject(Object.assign(
          new Error('could not reach the local server from this page'),
          { blockedInPage: true }));
      };
      x.send(body);
    });

    let res;
    try {
      res = await direct();
    } catch (e) {
      if (!e || !e.blockedInPage) throw e;
      // The page is walled off. The worker is not.
      stop.done = false;
      progress('working', 1, '');
      res = await viaWorker(bytes, jobId);
    }

    const outName = res.name || name || 'video.mp4';
    const info = res.info || {};

    progress('done', 100, `${info.width}×${info.height} · ${info.fps}fps · ${info.frames} frames`);
    // Transfer the result buffer back to the page (no copy).
    window.postMessage({ __tthd: true, kind: 'processResult', id, ok: true, name: outName, info, bytes: res.bytes }, '*', [res.bytes]);
  } catch (err) {
    const m = String(err && err.message || err);
    // A stale content script is recoverable and worth distinguishing from a
    // real transcode failure — the file is fine, the page just needs a reload.
    progress('error', 0, m);
    post('processResult', { ok: false, error: m, stale: m === EXT_DEAD });
  }
});

window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || !d.__tthd || !d.state) return;
  render(d.state);
});

if (document.body) build();
else document.addEventListener('DOMContentLoaded', build);
new MutationObserver(() => { if (!panel && document.body) build(); })
  .observe(document.documentElement, { childList: true, subtree: true });

window.postMessage({ __tthdCmd: true, cmd: 'sync' }, '*');

chrome.runtime.onMessage.addListener((m, _s, reply) => {
  // The worker relays encode progress here while it holds the upload. Without
  // this listener those messages went nowhere, so the relay path — Instagram,
  // the only platform whose CSP forces it — sat frozen at whatever the last
  // page-side update said and then finished in one jump.
  if (m && m.type === 'tthd:progress') {
    // m.id is the RELAY's upload id. The page filters on its own request id and
    // drops anything else, so an untranslated forward reaches nobody — which is
    // exactly what left the bar sitting at 2% until the upload finished.
    const pageId = relayJobs.get(m.id) || m.id;
    window.postMessage({
      __tthd: true, kind: 'processProgress', id: pageId,
      phase: m.phase, pct: m.pct, note: m.note || '',
    }, '*');
    reply(true);
    return true;
  }
  if (m && m.cmd === 'state') reply(last);
  if (m && m.cmd === 'reset') { window.postMessage({ __tthdCmd: true, cmd: 'reset' }, '*'); reply(true); }
  return true;
});
