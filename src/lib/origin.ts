import 'server-only';

/*
 * origin.ts — the public URL of this site, as opposed to the one the process
 * happens to be listening on.
 *
 * WHY THIS EXISTS
 * `new URL(req.url).origin` inside a Route Handler is the address the Node
 * server was reached at. Behind a platform proxy — Railway, Vercel, Fly, any of
 * them — that is an internal address. In production it evaluated to
 * `https://localhost:8080`, which was written straight into Stripe's
 * `success_url`: every paying customer would have been redirected to a dead
 * address the instant their payment succeeded, with the money taken.
 *
 * Nothing local catches it. On a dev machine the internal and public origins
 * are the same string, so the bug is invisible until it is in front of
 * customers. That is why the env var is preferred over anything derived from
 * the request: it is the one value that cannot be wrong in a way that only
 * shows up in production.
 *
 * ORDER, AND WHY
 *   1. NEXT_PUBLIC_ORIGIN — configured, deliberate, and identical on every
 *      instance. If it is set, it is the answer.
 *   2. x-forwarded-proto + x-forwarded-host — what the proxy says the public
 *      request was. Correct on every mainstream host, but header-derived and
 *      therefore attacker-influenced if the proxy does not overwrite them, so
 *      it is a fallback rather than the primary.
 *   3. The request URL. Right in development, wrong behind a proxy — last.
 */
export function siteOrigin(req: Request): string {
  const configured = process.env.NEXT_PUBLIC_ORIGIN?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  /* In production the public address is a known constant. Falling through
   * to a header here would let a request choose where Stripe sends people
   * back to. */
  if (process.env.NODE_ENV === 'production') return 'https://pristine4k.com';

  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const host = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
    ?? req.headers.get('host')?.trim();
  if (host) return `${proto || 'https'}://${host}`;

  return new URL(req.url).origin;
}
