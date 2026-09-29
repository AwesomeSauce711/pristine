'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = process.env.TEST_ROOT || path.join(__dirname, '..');
const ext = process.env.TEST_EXTENSION || path.join(root, 'extension');
const { inspectMp4Sample } = require(path.join(ext, 'mp4-inspect.js'));
const cap = 4 * 1024 * 1024;
const { instagramPublication } = require(path.join(ext, 'publication.js'));
const instagram = instagramPublication([JSON.stringify({ items: [
  { code: 'neighbor', video_versions: [{ width: 2160, height: 3840 }] },
  { code: 'selected', video_versions: [{ width: 720, height: 1280, url: 'https://test.cdninstagram.com/video.mp4' }],
    video_dash_manifest: '<Representation width="720" height="1280" frameRate="15360/512" bandwidth="500000"><BaseURL>https://test.cdninstagram.com/video.mp4?a=1&amp;b=2</BaseURL></Representation>' },
] })], 'selected');
assert.equal(instagram.platform, 'Instagram');
assert.equal(instagram.renditions[0].fps, 30);
assert.equal(instagram.renditions[0].height, 1280);
assert.match(instagram.renditions[0].url, /a=1&b=2$/);
const v120 = fs.readFileSync(path.join(root, 'tests', 'fixtures', 'with-audio.mp4'));
const v30 = fs.readFileSync(path.join(root, 'tests', 'fixtures', 'no-audio.mp4'));

assert.equal(inspectMp4Sample(v120.subarray(0, 32), v120.length), null);
const tail = inspectMp4Sample(v120.subarray(-cap), v120.length);
assert.deepEqual([tail.width, tail.height, tail.fps], [64, 64, 30]);
const head = inspectMp4Sample(v30.subarray(0, cap), v30.length);
assert.deepEqual([head.width, head.height, head.fps], [64, 64, 30]);
assert.equal(inspectMp4Sample(Buffer.from('not an mp4')), null);

async function runWorker(fetchImpl) {
  const listeners = [], saved = {}, tabs = [];
  let finished;
  const complete = new Promise(resolve => { finished = resolve; });
  const chrome = {
    runtime: { onMessage: { addListener: f => listeners.push(f) }, getURL: p => 'chrome-extension://test/' + p },
    storage: { session: { set: async x => { Object.assign(saved, x); if (Object.values(x)[0].probe.status !== 'pending') finished(); } } },
    tabs: { create: async x => { tabs.push(x); } },
  };
  const context = { chrome, fetch: fetchImpl, crypto, Response, URL, Uint8Array, DataView, BigInt, AbortController, setTimeout, clearTimeout,
    importScripts: () => { context.inspectMp4Sample = inspectMp4Sample; } };
  vm.runInNewContext(fs.readFileSync(path.join(ext, 'background.js'), 'utf8'), context);
  const listener = listeners.find(f => f.toString().includes("msg.type !== 'tthd:localReport'"));
  assert.ok(listener);
  const reply = await new Promise(resolve => listener({ type: 'tthd:localReport', payload: {
    pageUrl: 'https://www.tiktok.com/@example/video/1',
    pageVideo: { width: 2160, height: 3840, measuredFps: 119.8 },
    publication: { id: '1', reviewing: true, renditions: [
      { gear: 'original', url: 'https://v16-webapp-prime.us.tiktok.com/test.mp4' },
    ] },
    ladder: [{ gear: 'original', url: 'https://v16-webapp-prime.us.tiktok.com/test.mp4' }], media: [],
  } }, {}, resolve));
  assert.equal(reply.ok, true, reply.error);
  assert.equal(tabs.length, 1);
  assert.match(tabs[0].url, /^chrome-extension:\/\/test\/report\.html\?id=/);
  await complete;
  return Object.values(saved)[0];
}

(async () => {
  const success = await runWorker(async (_url, options) => {
    const bytes = options.headers.Range.startsWith('bytes=0-') ? v120.subarray(0, cap) : v120.subarray(-cap);
    const start = options.headers.Range.startsWith('bytes=0-') ? 0 : v120.length - bytes.length;
    return new Response(bytes, { status: 206, headers: { 'content-range': `bytes ${start}-${start + bytes.length - 1}/${v120.length}` } });
  });
  assert.equal(success.probe.info.fps, 30);
  // A synthetic high-rate result exercises the distinction between stored and displayed fps.
  success.probe.info = { ...success.probe.info, width: 2160, height: 3840, fps: 120 };
  assert.equal(success.probe.association, 'current post rendition');
  const reportId = '00000000-0000-4000-8000-000000000000';
  class Element {
    constructor() { this.textContent = ''; this.children = []; this.classList = { add: () => {} }; }
    append(...xs) { this.children.push(...xs); }
    addEventListener() {}
  }
  async function render(report) {
    const elements = Object.fromEntries(['source', 'verdict', 'player', 'container', 'ladder', 'upload', 'download'].map(x => [x, new Element()]));
    vm.runInNewContext(fs.readFileSync(path.join(ext, 'report.js'), 'utf8'), {
      document: { getElementById: id => elements[id], createElement: () => new Element() },
      location: { search: '?id=' + reportId }, URLSearchParams, Date, Number, JSON, Blob, URL,
      chrome: { storage: { session: { get: async () => ({ ['report_' + reportId]: report }) }, onChanged: { addListener: () => {} } } },
    });
    await new Promise(resolve => setImmediate(resolve));
    return elements;
  }
  const elements = await render({ ...success, publication: null });
  assert.match(elements.verdict.textContent, /120 fps stored in the delivered file/);
  assert.match(elements.verdict.textContent, /not proof that the player displays every frame/);
  assert.ok(elements.container.children.some(x => x.children?.some(y => y.textContent === '120 fps')));
  const dualAudio = await render({ ...success, probe: { ...success.probe, info: {
    ...success.probe.info,
    audio: [
      { codec: 'mp4a', sampleRate: 48000, channels: 2, samples: 525, duration: 11.2, tinySamples: 1 },
      { codec: 'mp4a', sampleRate: 48000, channels: 2, samples: 5250, duration: 11.298, tinySamples: 4726 },
    ],
  } }, publication: null });
  assert.ok(dualAudio.container.children.some(x => x.children?.some(y => /5,250 samples.*4,726 samples ≤8 bytes/.test(y.textContent))));
  assert.ok(dualAudio.container.children.some(x => /exactly 10×.*not proof/.test(x.textContent)));
  const provisional = await render({ ...success, publication: { id: '1', reviewing: true, renditions: [] } });
  assert.match(provisional.verdict.textContent, /still reviewing or processing/);
  const noLadder = await render({ ...success, pageVideo: { ...success.pageVideo, presentedFps: 60 }, publication: { id: '1', reviewing: false, renditions: [] } });
  assert.doesNotMatch(noLadder.verdict.textContent, /still reviewing or processing/);
  assert.ok(noLadder.verdict.children.some(x => /presented about 60 fps/.test(x.textContent)));
  const settled = await render({ ...success, publication: { id: '1', reviewing: false, renditions: [
    { gear: 'normal_720_0', width: 720, height: 1280, fps: 30, bitrate: 145242 },
  ] } });
  assert.match(settled.verdict.textContent, /highest listed rendition 720 × 1280 at 30 fps/);
  assert.match(settled.verdict.textContent, /player still shows a different source-quality or cached file/);
  const blocked = await runWorker(async () => new Response('', { status: 403 }));
  assert.match(blocked.probe.error, /HTTP 403/);
  assert.equal(blocked.pageVideo.measuredFps, 119.8);
  const inject = fs.readFileSync(path.join(ext, 'inject.js'), 'utf8');
  const picker = inject.slice(inject.indexOf('function currentVideoCandidates()'), inject.indexOf('(function liveLoop()'));
  const context = { location: { hostname: 'www.tiktok.com', pathname: '/@test/video/123' },
    document: { querySelectorAll: selector => selector === '#media-card-0 video' ? [] : [{ videoWidth: 2160 }] } };
  vm.runInNewContext(picker, context);
  assert.equal(context.currentVideoCandidates().length, 0, 'must not measure a preloaded post when current playback fails');
  for (const filename of fs.readdirSync(ext).filter(x => x.endsWith('.js'))) {
    new vm.Script(fs.readFileSync(path.join(ext, filename), 'utf8'), { filename });
  }
  console.log('Quality report: MP4 head/tail, report tab, and blocked-CDN fallback passed.');
})().catch(e => { console.error(e); process.exitCode = 1; });
