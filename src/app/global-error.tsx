'use client';

/*
 * The last resort — this replaces the root layout, so it cannot rely on the
 * fonts, the CSS variables, or anything else the layout provides. Every style
 * here is inline for that reason. It only renders when the root layout itself
 * failed, which should be never.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: '#08080b',
          color: '#f2f3f7',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          padding: '24px',
        }}
      >
        <main style={{ maxWidth: 420, textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 600, margin: 0 }}>
            Pristine is temporarily unavailable
          </h1>
          <p style={{ marginTop: 12, fontSize: 15, lineHeight: 1.6, color: '#8e93a6' }}>
            Something went wrong loading the app. Your video was never uploaded and nothing has
            been charged.
          </p>
          <button
            onClick={reset}
            style={{
              marginTop: 28,
              padding: '12px 24px',
              fontSize: 14,
              fontWeight: 500,
              color: 'white',
              background: '#7c5cff',
              border: 'none',
              borderRadius: 12,
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
          {error.digest && (
            <p style={{ marginTop: 32, fontSize: 11.5, color: '#5f6478', fontFamily: 'monospace' }}>
              Reference: {error.digest}
            </p>
          )}
        </main>
      </body>
    </html>
  );
}
