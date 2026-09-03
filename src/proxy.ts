import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/*
 * proxy.ts — runs before every request. (Next 16 renamed Middleware to Proxy;
 * the behaviour is unchanged.)
 *
 * Two jobs: a Content-Security-Policy, and cross-site request forgery defence
 * on state-changing requests.
 *
 *
 * WHY THERE IS NO NONCE, AND WHY THAT DECISION IS DELIBERATE
 *
 * The first version of this file shipped a nonce-based CSP with
 * `'strict-dynamic'`. It looked stronger and it silently bricked the entire
 * site: with `strict-dynamic`, browsers ignore `'self'`, `https:` and
 * `'unsafe-inline'` and run ONLY scripts carrying the matching nonce. Next
 * emitted twelve script tags and none of them had one, so every script was
 * blocked, React never hydrated, and every page rendered perfectly while being
 * completely inert. Nothing was clickable and no error appeared anywhere —
 * the worst possible failure mode, and it took a bug report to find.
 *
 * Two things were wrong. Next extracts the nonce from the
 * `Content-Security-Policy` header on the REQUEST, which this was not setting;
 * it was only being set on the response. And more fundamentally, nonces require
 * DYNAMIC RENDERING — a nonce is per-request, and a statically prerendered page
 * is built once with no request in existence. Every page here is static apart
 * from the two that read cookies.
 *
 * So the choice was: force every page dynamic and lose static prerendering on
 * the marketing pages, or drop the nonce. Dropping the nonce is the right call
 * here, because of what this site actually does:
 *
 *   - It renders no user-generated content as markup. The only inputs are an
 *     email address and a video file, and the video is handled as bytes and
 *     never interpreted as HTML.
 *   - `script-src 'self'` still forbids loading script from any other origin,
 *     which is the delivery mechanism for essentially every real XSS here.
 *
 * `'unsafe-inline'` is a genuine weakening and is not pretended otherwise. It
 * is the price of static rendering, and the injection surface it exposes is one
 * this application does not have. If user-generated content is ever rendered,
 * this decision has to be revisited — move to nonces and force dynamic
 * rendering at that point.
 */

/*
 * Exempt from the origin check.
 *
 * Stripe sends webhooks with no Origin header and cannot be expected to send
 * one. That endpoint is not unauthenticated, though — it is authenticated by an
 * HMAC signature over the raw body, which is strictly stronger than an origin
 * check. Rejecting it here would simply break billing.
 */
const CSRF_EXEMPT = ['/api/stripe/webhook'];

/*
 * The one public host. The session cookie is a __Host- cookie: it belongs to
 * exactly the host that set it, so a reader who signed in on the apex domain
 * and then opened a link to www (or the other way round) is signed out there,
 * and is told to sign in again on a page that has just shown them their
 * plans. Derived from NEXT_PUBLIC_ORIGIN, and only the www/apex pair is ever
 * redirected -- Railway's own hostname and localhost are left alone.
 */
function canonicalHost(requestHost: string | null): string | null {
  const configured = process.env.NEXT_PUBLIC_ORIGIN?.trim();
  if (configured) {
    try {
      const host = new URL(configured).host;
      if (host && !host.startsWith('localhost') && !host.startsWith('127.')) return host;
    } catch {
      /* fall through to the rule below */
    }
  }
  /* Nothing configured in production: the public host is a known constant,
   * the same one siteOrigin falls back to. Deriving it from the request's
   * own Host would let whoever sent the request choose the redirect. */
  if (process.env.NODE_ENV === 'production') return 'pristine4k.com';
  /* Nothing configured: the apex is canonical, so www is the twin. */
  return requestHost?.startsWith('www.') ? requestHost.slice(4) : null;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const method = request.method.toUpperCase();

  /* ---- one host -------------------------------------------------------- */

  const requestHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
    || request.headers.get('host')?.trim() || null;
  const canonical = canonicalHost(requestHost);
  if (canonical && requestHost) {
    const host = requestHost;
    if (host !== canonical && (host === `www.${canonical}` || `www.${host}` === canonical)) {
      const to = `https://${canonical}${pathname}${request.nextUrl.search}`;
      return NextResponse.redirect(to, 308);
    }
  }

  /* ---- CSRF ------------------------------------------------------------ */

  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  if (mutating && !CSRF_EXEMPT.some((p) => pathname.startsWith(p))) {
    const origin = request.headers.get('origin');
    const host = request.headers.get('host');

    /*
     * A missing Origin on a same-origin POST is normal in some older browsers,
     * so absence alone is not treated as an attack. A PRESENT origin that does
     * not match the host is unambiguous, and that is what is refused.
     */
    if (origin) {
      let ok = false;
      try {
        ok = new URL(origin).host === host;
      } catch {
        ok = false;
      }
      if (!ok) {
        return NextResponse.json(
          { code: 'bad_origin', message: 'Request blocked.' },
          { status: 403 },
        );
      }
    }
  }

  /* ---- CSP ------------------------------------------------------------- */

  const dev = process.env.NODE_ENV !== 'production';

  const csp = [
    "default-src 'self'",
    /*
     * Script may come only from this origin. Inline is permitted because the
     * pages are statically rendered and Next's hydration bootstrap is inline —
     * see the long note at the top for why that trade was made rather than
     * stumbled into. Development also needs 'unsafe-eval', which React uses to
     * reconstruct server stacks; production does not get it.
     *
     * 'wasm-unsafe-eval' allows WebAssembly to be compiled — and only that; it
     * does not permit JavaScript eval. The Draco mesh decoder that unpacks the
     * hand model on the landing page (/draco/, served from this origin) is
     * WebAssembly, and without this it cannot instantiate.
     */
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ''}`,
    /*
     * The Draco decoder runs in a Web Worker built from a blob: URL (three.js
     * assembles the worker's source from the decoder script it fetched from
     * this origin). Without a worker-src, workers fall back to script-src,
     * which does not allow blob:.
     */
    "worker-src 'self' blob:",
    /* React sets inline styles for the comparison slider and the reveal
     * animations, and there is no nonce path for a `style` attribute. */
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    /* Previews play from blob: URLs of the user's own local file. */
    "media-src 'self' blob:",
    "font-src 'self' data:",
    /* Nothing in the browser talks to a third-party API. Stripe is reached
     * server-side, and checkout is a top-level redirect. */
    "connect-src 'self'",
    /* Checkout and the Customer Portal are navigations to Stripe. */
    "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    ...(dev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');

  const response = NextResponse.next();
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  /*
   * Skip static assets and the demo media: they need no CSP of their own, and
   * running this on every image byte is wasted work.
   */
  matcher: [
    /* No header-based exemptions: a request that claims to be a prefetch
     * used to skip the proxy -- and with it the CSRF check, the CSP, and
     * Next's body-size cap on the way in. The cost of running this on a
     * prefetch is a few microseconds. */
    { source: '/((?!_next/static|_next/image|favicon.ico|demo/).*)' },
  ],
};
