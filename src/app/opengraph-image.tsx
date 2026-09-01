import { ImageResponse } from 'next/og';

/*
 * The link preview.
 *
 * Leads with the measured numbers rather than a tagline, because the numbers
 * are the argument: 720p vs 4K, 30fps vs 60fps, and the fact that both are what
 * TikTok actually served. A preview card is usually the only thing someone sees
 * before deciding whether to click, so it should carry the evidence.
 *
 * Rendered at request time by Satori, which supports a deliberately small
 * subset of CSS — flexbox only, no grid, and every element with more than one
 * child needs an explicit `display`.
 */

export const alt =
  'Pristine — TikTok compresses your video to 720p and 30fps. Pristine keeps it at 4K and 60fps.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: '#08080b',
          padding: 72,
          fontFamily: 'sans-serif',
        }}
      >
        {/* wordmark */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div
            style={{
              display: 'flex',
              width: 44,
              height: 44,
              borderRadius: 12,
              background: '#7c5cff',
            }}
          />
          <div style={{ fontSize: 30, color: '#f2f3f7', fontWeight: 600 }}>Pristine</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              fontSize: 68,
              lineHeight: 1.05,
              color: '#f2f3f7',
              fontWeight: 700,
              letterSpacing: -2,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <span>TikTok compresses your video.</span>
            <span style={{ color: '#9b83ff' }}>Pristine stops it.</span>
          </div>

          {/* The comparison, as two columns of measured figures. */}
          <div style={{ display: 'flex', gap: 20, marginTop: 44 }}>
            <Panel
              label="UPLOADED NORMALLY"
              value="720 × 1280"
              detail="30fps · 2.90 Mbps"
              accent="#5f6478"
            />
            <Panel
              label="WITH PRISTINE"
              value="2160 × 3840"
              detail="60fps · 41.72 Mbps"
              accent="#9b83ff"
            />
          </div>
        </div>

        <div style={{ fontSize: 22, color: '#5f6478', display: 'flex' }}>
          Your video never leaves your device
        </div>
      </div>
    ),
    size,
  );
}

function Panel({
  label, value, detail, accent,
}: { label: string; value: string; detail: string; accent: string }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        padding: '24px 28px',
        borderRadius: 16,
        border: `1px solid ${accent === '#9b83ff' ? 'rgba(124,92,255,0.4)' : '#23232e'}`,
        background: '#131318',
      }}
    >
      <div style={{ fontSize: 15, letterSpacing: 2, color: accent, display: 'flex' }}>{label}</div>
      <div style={{ fontSize: 40, color: '#f2f3f7', marginTop: 10, display: 'flex' }}>{value}</div>
      <div style={{ fontSize: 20, color: '#8e93a6', marginTop: 6, display: 'flex' }}>{detail}</div>
    </div>
  );
}
