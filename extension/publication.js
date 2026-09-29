'use strict';
// Parse only the requested Reel's embedded record; neighboring/preloaded posts do not count.
function instagramPublication(texts, code) {
  for (const text of texts) {
    if (!text || text.length > 8e6 || !text.includes('video_versions')) continue;
    let root;
    try { root = JSON.parse(text); } catch (_) { continue; }
    const pending = [root];
    let visited = 0;
    while (pending.length && visited++ < 40000) {
      const item = pending.pop();
      if (!item || typeof item !== 'object') continue;
      if (item.code === code && Array.isArray(item.video_versions)) {
        const versions = [...item.video_versions].sort((a, b) => b.width * b.height - a.width * a.height);
        const renditions = [];
        for (const match of (item.video_dash_manifest || '').matchAll(/<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/g)) {
          const attributes = Object.fromEntries([...match[1].matchAll(/([\w:]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
          if (!Number(attributes.width) || !Number(attributes.height)) continue;
          const rate = (attributes.frameRate || '').split('/').map(Number);
          const url = /<BaseURL>([\s\S]*?)<\/BaseURL>/.exec(match[2])?.[1]?.replace(/&amp;/g, '&') || '';
          renditions.push({ gear: attributes.FBQualityLabel || attributes.id || 'Instagram rendition',
            width: Number(attributes.width), height: Number(attributes.height),
            fps: rate[0] && (rate.length === 1 || rate[1]) ? rate[0] / (rate[1] || 1) : 0,
            bitrate: Number(attributes.bandwidth) || 0, url });
        }
        if (!renditions.length) for (const v of versions) {
          if (!renditions.some(r => r.width === v.width && r.height === v.height)) renditions.push({ gear: 'Instagram MP4', width: v.width, height: v.height, fps: 0, bitrate: 0, url: v.url });
        }
        return { platform: 'Instagram', id: code, reviewing: null, createdAt: Number(item.taken_at) * 1000 || null,
          playUrl: versions[0]?.url || '', renditions };
      }
      pending.push(...Object.values(item).filter(value => value && typeof value === 'object'));
    }
  }
  return null;
}
if (typeof module !== 'undefined') module.exports = { instagramPublication };
