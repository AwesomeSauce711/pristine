'use strict';
const $ = (id) => document.getElementById(id);
const row = (parent, label, value) => {
  const el = document.createElement('div'); el.className = 'row';
  const a = document.createElement('span'); a.textContent = label;
  const b = document.createElement('b'); b.textContent = String(value);
  el.append(a, b); parent.append(el);
};
const note = (parent, value) => { const p = document.createElement('p'); p.className = 'note'; p.textContent = value; parent.append(p); };
const fmt = (n, unit = '') => Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }) + unit : 'Unknown';
const audioText = (a) => `${a.codec} · ${fmt(a.sampleRate, ' Hz')} · ${fmt(a.channels)} channels` +
  (a.samples ? ` · ${fmt(a.samples)} samples` : '') +
  (a.duration ? ` · ${fmt(a.duration, ' s')}` : '') +
  (a.tinySamples ? ` · ${fmt(a.tinySamples)} samples ≤8 bytes` : '');
const audioEvidence = (parent, audio) => {
  for (const [i, a] of (audio || []).entries()) {
    if (a.trailingSampleDelta === 1 && a.trailingSamples > 100)
      note(parent, `Audio track ${i + 1} ends with ${fmt(a.trailingSamples)} packets timed at one media tick each. Its sample table spans ${fmt(a.sampleTableDuration, ' s')}; its media header declares ${fmt(a.duration, ' s')}. These are measured container properties, not a verified upload method.`);
  }
};

async function main() {
  const id = new URLSearchParams(location.search).get('id');
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) throw Error('Invalid report link');
  const data = await chrome.storage.session.get('report_' + id);
  const r = data['report_' + id];
  if (!r) throw Error('This report expired with the browser session. Run it again from the video page.');
  $('source').textContent = `${r.pageUrl || 'Video page'} · ${new Date(r.observedAt).toLocaleString()}`;
  const p = r.pageVideo || {}, m = r.probe?.info || {};
  const linked = ['player source', 'current post rendition'].includes(r.probe?.association);
  const measuredMp4 = linked && m.width && m.height && m.fps;
  const dimensions = measuredMp4 ? `${m.width} × ${m.height}` : p.width && p.height ? `${p.width} × ${p.height}` : null;
  const fps = measuredMp4 ? m.fps : p.measuredFps || 0;
  const verdict = $('verdict');
  const published = r.publication;
  const platform = published?.platform || (/instagram\.com/.test(r.pageUrl || '') ? 'Instagram' : 'TikTok');
  const processed = published && published.reviewing !== true && published.renditions?.length;
  const top = processed && [...published.renditions].sort((a, b) =>
    (b.width * b.height - a.width * a.height) || (b.fps - a.fps))[0];
  if (published?.reviewing === true) {
    verdict.textContent = 'TikTok is still reviewing or processing this post. A temporary original file may appear at full source quality before TikTok replaces it. Reopen the published page and run the report again after processing.';
    verdict.classList.add('warn');
  } else if (processed) {
    const playerMatches = !dimensions || published.renditions.some(g =>
      `${g.width} × ${g.height}` === dimensions);
    verdict.textContent = `Published ${platform} post: highest listed rendition ${top.width} × ${top.height} at ${fmt(top.fps, ' fps')}. ` +
      (playerMatches
        ? `Delivered file: ${dimensions || 'dimensions unknown'}${fps ? ` at ${fmt(fps, ' fps')} ${measuredMp4 ? 'in MP4 timing' : 'from playback sampling'}` : ''}. A phone can receive a different rendition.`
        : 'The player still shows a different source-quality or cached file. Reload this page and compare it with the listed renditions.');
    note(verdict, 'These are the renditions exposed at the observation time. The platform can change them later.');
    if (!top.width || !top.fps) verdict.classList.add('warn');
  } else {
    verdict.textContent = dimensions && fps
      ? `${dimensions} at ${fmt(fps, ' fps')} ${measuredMp4 ? 'stored in the delivered file. This is not proof that the player displays every frame.' : 'estimated from decoded playback.'}`
      : 'Playback or MP4 metadata was incomplete; see the measurements below.';
    if (published?.reviewing === false) {
      note(verdict, 'TikTok marks this post as published, but exposes no rendition list here. The measurement describes the delivered file at this time; an empty list alone does not prove processing has finished.');
      if (published.createdAt) row(verdict, 'Posted', new Date(published.createdAt).toLocaleString());
    } else if (/tiktok\.com\/.*\/video\//.test(r.pageUrl || '')) note(verdict, 'TikTok processing status was unavailable. Recheck the published post later before treating this as the final rendition.');
  }
  if (!dimensions || !fps) verdict.classList.add('warn');
  const savedVideo = $('saved-video');
  const savedInfo = r.downloadProbe?.info;
  if (savedVideo) {
    if (savedInfo) {
      row(savedVideo, 'Download dimensions', `${savedInfo.width} × ${savedInfo.height}`);
      row(savedVideo, 'Download frame rate', fmt(savedInfo.fps, ' fps'));
      row(savedVideo, 'Download codec', savedInfo.codec || 'Unknown');
      row(savedVideo, 'Download duration', fmt(savedInfo.duration, ' s'));
      if (savedInfo.movieDurationUnknown) row(savedVideo, 'Movie header duration', 'Unspecified');
      audioEvidence(savedVideo, savedInfo.audio);
    } else note(savedVideo, r.probe?.status === 'pending' ? 'Checking the saved-video version separately.' : r.downloadProbe?.error || 'Saved-video metadata was not captured.');
    note(savedVideo, 'Playback and downloads can use different files. A 720p/30 download does not disprove 4K playback. Matching labels do not prove camera-roll compatibility; that requires playing the saved file on the device.');
  }
  if (measuredMp4 && m.fps >= 115 && p.presentedFps > 0 && p.presentedFps < 90)
    note(verdict, `The file stores about 120 fps, but this browser presented about ${fmt(p.presentedFps, ' fps')} to its compositor. Device refresh rate and the player can limit what is shown.`);
  row($('player'), 'Decoded dimensions', p.width && p.height ? `${p.width} × ${p.height}` : 'Unknown');
  row($('player'), 'Decoded frames in sample', fmt(p.decodedFrames));
  row($('player'), 'Dropped frames in sample', Number.isFinite(Number(p.droppedFrames)) ? Number(p.droppedFrames) : 'Unknown');
  row($('player'), 'Sample length', fmt(p.sampledSeconds, ' s'));
  row($('player'), 'Estimated decoded rate', fmt(p.measuredFps, ' fps'));
  row($('player'), 'Frames presented to compositor', fmt(p.presentedFrames));
  row($('player'), 'Estimated presented rate', fmt(p.presentedFps, ' fps'));
  note($('player'), 'Stored, decoded, and presented frame rates are separate measurements. This browser cannot measure your phone display.');
  row($('player'), 'Video duration', fmt(p.duration, ' s'));
  if (p.player) row($('player'), 'Player stats', JSON.stringify(p.player).slice(0, 500));
  if (p.error) note($('player'), p.error);
  if (m.codec) {
    row($('container'), 'Video codec', m.codec);
    if (m.profile) row($('container'), 'Codec profile', `${m.profile}${m.level ? ` · level ${m.level}` : ''}${m.tier ? ` · ${m.tier} tier` : ''}`);
    if (m.movieDurationUnknown) row($('container'), 'Movie header duration', 'Unspecified (all-one duration field)');
    row($('container'), 'Stored dimensions', `${m.width} × ${m.height}`);
    row($('container'), 'Frame count', fmt(m.frames));
    if (m.keyframes) row($('container'), 'Keyframes', fmt(m.keyframes));
    row($('container'), 'Average frame rate', fmt(m.fps, ' fps'));
    row($('container'), 'Frame timing', m.variableFrameRate ? 'Variable' : 'Constant in sample table');
    row($('container'), 'Duration', fmt(m.duration, ' s'));
    row($('container'), 'Whole file average bitrate', m.containerMbps ? fmt(m.containerMbps, ' Mbps') : 'Unknown');
    for (const [i, a] of (m.audio || []).entries()) row($('container'), `Audio track ${i + 1}`, audioText(a));
    audioEvidence($('container'), m.audio);
    if (m.audio?.length >= 2 && m.audio[0].samples && m.audio[1].samples === m.audio[0].samples * 10)
      note($('container'), 'The second delivered audio track declares exactly 10× the samples of the first. This is a file property, not proof of why TikTok kept this rendition.');
    note($('container'), `These are properties of the file ${platform} delivered to this browser. They do not reveal the creator’s original upload or what ${platform} changed. Bitrate includes audio and container overhead.`);
    if (!linked) note($('container'), 'This media URL was not tied to the current post. It may belong to a preloaded video and is excluded from the conclusion above.');
  } else if (r.probe?.status === 'pending') note($('container'), 'Reading a small range of the delivered file in the background. The playback measurement is ready now.');
  else note($('container'), `Could not read a delivered MP4 sample table: ${r.probe?.error || 'No media URL available.'} The playback measurement above still works.`);
  if (published) row($('ladder'), 'Post status', published.reviewing === true ? 'Under review / processing' : published.reviewing === false ? 'Published' : 'Unknown');
  const ladder = (published?.renditions?.length ? published.renditions : r.ladder || []).slice(0, 24);
  if (!ladder.length) note($('ladder'), 'No rendition list was exposed on this page.');
  for (const g of ladder) {
    const el = document.createElement('div'); el.className = 'gear';
    const name = document.createElement('strong'); name.textContent = g.gear || 'Rendition';
    const detail = document.createElement('small'); detail.textContent = `Declared: ${g.width && g.height ? `${g.width} × ${g.height}` : 'size unknown'} · ${fmt(g.fps || g.declaredFps, ' fps')} · ${g.bitrate ? fmt(Number(g.bitrate) / 1e6, ' Mbps') : 'bitrate unknown'}`;
    el.append(name, detail); $('ladder').append(el);
  }
  const upload = $('upload');
  if (r.source || (r.uploadHeaders || []).length || (r.route || []).length) {
    row(upload, 'Captured source file', r.source?.name || r.source?.fileName || 'Not captured');
    if (r.source?.container) {
      const s = r.source.container;
      row(upload, 'Source video', `${s.width} × ${s.height} · ${fmt(s.fps, ' fps')} · ${s.codec}${s.profile ? ` ${s.profile}` : ''}`);
      row(upload, 'Source frames', fmt(s.frames));
      row(upload, 'Source file bitrate', fmt(s.containerMbps, ' Mbps'));
      for (const [i, a] of (s.audio || []).entries()) row(upload, `Source audio ${i + 1}`, audioText(a));
      audioEvidence(upload, s.audio);
    }
    row(upload, 'Bytes sent', fmt(r.bytesSent));
    row(upload, 'Upload request observations', (r.uploadHeaders || []).length);
    row(upload, 'Transfer route events', (r.route || []).length);
    note(upload, 'These observations apply only to an upload captured in this browser. Compare them with the published video after processing.');
  } else note(upload, 'This is another creator’s published video. The extension can measure what your browser receives, but it cannot see their original file, app version, upload route, or private TikTok processing decisions.');
  $('download').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'quality-report-' + id + '.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('save-html')?.addEventListener('click', async () => {
    const copy = document.documentElement.cloneNode(true);
    copy.querySelectorAll('script, link, button').forEach(el => el.remove());
    const style = document.createElement('style');
    style.textContent = await (await fetch(chrome.runtime.getURL('report.css'))).text();
    copy.querySelector('head').append(style);
    const blob = new Blob(['<!doctype html>', copy.outerHTML], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = 'quality-report-' + id + '.html'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}
main().catch(e => { $('verdict').textContent = String(e.message || e); $('verdict').classList.add('warn'); });
const reportId = new URLSearchParams(location.search).get('id');
chrome.storage.onChanged.addListener((changes, area) => {
  const updated = changes['report_' + reportId];
  if (area === 'session' && updated?.newValue && updated.newValue.probe?.status !== 'pending') location.reload();
});
