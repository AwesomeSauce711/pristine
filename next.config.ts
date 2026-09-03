import type { NextConfig } from 'next';

/*
 * Security headers.
 *
 * The Content-Security-Policy is set per-request in `src/proxy.ts` (it differs
 * between development and production). Everything here is static and applies
 * to every response.
 */

const securityHeaders = [
  /*
   * Never let a browser guess a content type. Combined with the fact that the
   * patch endpoint returns application/octet-stream, sniffing is exactly how a
   * response gets reinterpreted as something executable.
   */
  { key: 'X-Content-Type-Options', value: 'nosniff' },

  /*
   * Clickjacking. `frame-ancestors 'none'` in the CSP is the modern control and
   * is set in the proxy; this is the legacy equivalent for older browsers.
   */
  { key: 'X-Frame-Options', value: 'DENY' },

  /*
   * Send the origin but not the path to other sites. A full referrer would leak
   * URLs like /welcome?session_id=cs_... to any third party a page links to.
   */
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },

  /*
   * Nothing here needs a camera, a microphone, a location, or a payment
   * handler. Turning them off means a compromised dependency cannot quietly ask
   * for them either.
   */
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },

  /*
   * Two years, subdomains included. Only meaningful over HTTPS, and it is
   * deliberately not `preload` — preloading is effectively irreversible and
   * should be a decision taken once the domain is settled, not a default.
   */
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },

  /* Keeps the app out of other origins' process, which is what makes
   * cross-origin side-channel attacks hard. */
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
];

const nextConfig: NextConfig = {
  /* next/image is not used anywhere; the optimiser endpoint would otherwise
   * sit reachable for nothing. */
  images: { unoptimized: true },
  poweredByHeader: false,

  /*
   * Phones on the same Wi-Fi. Next blocks cross-origin requests to the dev
   * server's own assets from any host it was not started on, so a page
   * opened at the PC's LAN address gets its HTML and none of its JavaScript
   * — no effects, no hand, no drop zone. List the addresses that may ask.
   * Development only; production never reads this.
   */
  allowedDevOrigins: ['10.193.240.54', '192.168.1.*', '192.168.0.*', '10.*.*.*'],

  // A stack trace in a production response tells an attacker about the code and
  // tells the user nothing they can act on.
  productionBrowserSourceMaps: false,

  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      /*
       * Nothing the API returns is ever cacheable. A patched index cached by a
       * shared proxy and served to the next caller would be both a correctness
       * bug and a paywall bypass.
       */
      {
        source: '/api/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, max-age=0' },
          { key: 'Pragma', value: 'no-cache' },
        ],
      },
    ];
  },
};

export default nextConfig;
