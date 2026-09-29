'use strict';

const fmt = (b) => !b ? '—'
  : b < 1048576 ? (b / 1024).toFixed(0) + ' KB'
  : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB'
  : (b / 1073741824).toFixed(2) + ' GB';

function paint(s) {
  const v = document.getElementById('verdict');
  if (!s) { v.textContent = 'Open a TikTok upload page, then pick a video.'; return; }

  document.getElementById('file').textContent = s.file ? fmt(s.file.size) : '—';
  document.getElementById('sent').textContent = fmt(s.bytesSent);
  document.getElementById('guard').textContent = s.guard ? 'on' : 'off';

  const enc = s.encoders.filter((e) => /VideoEncoder|MediaRecorder|captureStream/.test(e.api));
  if (enc.length) {
    v.className = 'v bad';
    v.textContent = s.guard
      ? 'In-browser re-encoding attempted and blocked.'
      : 'This page is re-encoding video in your browser. Enable guard mode on the page panel.';
  } else if (s.file && s.bytesSent > 0) {
    const r = s.bytesSent / s.file.size;
    if (r >= 0.98) {
      v.className = 'v good';
      v.textContent = 'Original bytes sent verbatim. No client-side compression occurred.';
    } else {
      v.className = 'v warn';
      v.textContent = `${(r * 100).toFixed(0)}% of source bytes sent so far.`;
    }
  } else {
    v.className = 'v';
    v.textContent = s.file ? 'File staged. Start the upload.' : 'Pick a video to measure.';
  }
}

function ask(cmd, cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return cb(null);
    chrome.tabs.sendMessage(tabs[0].id, { cmd }, (r) => { void chrome.runtime.lastError; cb(r); });
  });
}

ask('state', paint);
document.getElementById('reset').addEventListener('click', () => ask('reset', () => ask('state', paint)));
