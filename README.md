# Pristine

A web tool that stops TikTok re-encoding your video.

Upload normally and TikTok re-encodes the file to 720p and halves the frame
rate. Pristine patches the container so it is served back exactly as you made
it — byte for byte.

```
control (unpatched)    720×1280   30fps    2.90 Mbps    3,665,089 bytes
patched               2160×3840   60fps   41.72 Mbps   52,323,644 bytes
```

Both figures are what TikTok actually served, for the same ten seconds of the
same footage, uploaded minutes apart from the same zero-follower account. The
only difference between the two files was the patch. **9.0× the pixels, 14.4×
the bitrate, 2× the frame rate.**

---

## How it works, and why it is built this way

The patch is container surgery — no decode, no encode, no ffmpeg. It gives a
decoy audio track roughly ten times the samples it really has, which makes
TikTok's ingest price the transcode job as far more expensive than it is and
serve the upload untouched. The video track is never modified, so the picture
is bit-identical.

The interesting part is the split:

```
BROWSER                                   SERVER
1. pick file — never uploaded
2. read ftyp + moov only (30–150 KB)
3. check for an audio track  ← the one failure case, caught before payment
4. POST just the index          ------>   entitlement check
                                          buildPatchedMoov()   ← never ships to the client
5. reassemble locally           <------   patched index
6. download
```

**Your video never leaves your device.** Only the file's index is sent, which
is typically 0.02–0.12% of the file:

| file | size | index | share |
|---|---|---|---|
| 10s 4K60 | 49.9 MB | 38 KB | 0.073% |
| 30s 4K120 | 142.6 MB | 135 KB | 0.093% |
| 60s 4K120 | 147.5 MB | 148 KB | 0.098% |

That is the privacy claim, and it is also why this runs on a phone browser and
costs almost nothing to operate. Measured: assembling the output from a `Blob`
slice caused **0 MB of JS heap growth** on a 49.7 MB file in Chrome, and a
222 MB file patches in ~36 ms.

The split exists to enforce payment, **not to keep a secret**. The technique is
already described publicly by a competitor, and one output file is enough to
recover it — that is how it was found in the first place. What the split
actually buys is that the paywall cannot be bypassed by reading the bundle. No
engineering should be spent on obfuscation.

---

## Seeing the whole thing without Stripe

The paywall is real and denies by default, so the download half of the product
is unreachable until billing exists. For development there is a one-click
unlock:

```bash
echo "PRISTINE_DEV_UNLOCK=1" >> .env.local
npm run dev
```

A small **dev** pill appears bottom-right. Open it, press **Simulate
subscription**, and the full flow works — upload, analyse, preview, patch,
download — with no Stripe account and no database.

It is not a fake client-side flag. It sets a cookie that the real
`resolveAccess()` recognises, so every request still goes through the genuine
server-side entitlement check and the same `/api/patch` code path a paying
customer hits. The only thing stubbed is where the subscription came from.

**It cannot leak into production.** Three independent guards, all required:
`NODE_ENV !== 'production'` (a production build fails this outright),
`PRISTINE_DEV_UNLOCK=1` set explicitly, and the unlock cookie — which only the
dev-only route can set, and that route re-checks the first two. In a production
build `/api/dev/unlock` returns 404, indistinguishable from a route that does
not exist.

## Setup

```bash
npm install
cp .env.example .env.local     # then fill it in
```

**1. Database** — any Postgres. [Neon](https://console.neon.tech) is free to
start. Put the pooled connection string in `DATABASE_URL`, then:

```bash
npm run db:generate    # already done; regenerate only if the schema changes
npm run db:migrate
```

**2. Stripe** — put your test secret key in `STRIPE_SECRET_KEY`, then:

```bash
npm run stripe:seed
```

It creates the Product and three Prices, prints the ids to paste into
`.env.local`, and lists the four dashboard settings that still need doing by
hand (statement descriptor, Customer Portal, webhook endpoint, Stripe Tax).

For local webhooks:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

**3. Business details** — the Terms, Privacy Policy and Refund Policy quote
these directly, so they are required:

```bash
npm run check:legal
```

The legal pages display a warning banner while anything is still a placeholder.
They are drafts written to cover the rules that apply (ROSCA, state
automatic-renewal laws, GDPR/CCPA contact routes) and **a lawyer should read
them before you take real money**.

```bash
npm run dev
```

---

## Verifying

```bash
npm run verify        # typecheck + all three suites
```

- **`verify:patch`** — the anchor. Asserts the TypeScript port still produces
  `VAR_J_rein.mp4` **byte for byte**: the exact file TikTok accepted as
  `videoQuality: "original"` with an empty rendition ladder. If this drifts by
  one byte, what is being sold is no longer what was measured. Also fuzzes
  hostile sample tables, which must be rejected in constant time.
- **`verify:scan`** — the browser scanner against real 4K, HEVC and AV1 files,
  including that it reads only the index.
- **`verify:entitlement`** — every Stripe subscription status mapped to an
  access window. Each case is a way to lose money or a customer.

The only test that proves the *product* works, rather than the code, is to
patch a file through the site, upload it, wait **more than two minutes**, and
confirm `videoQuality: "original"` with an empty ladder. `videoQuality` reads
`original` while a re-encode is merely pending, so anything measured sooner
means nothing.

---

## Things worth knowing before changing anything

**Sample-table counts are attacker-controlled.** Every count in an MP4 comes
straight out of the file. Unbounded, a twenty-byte `stsz` claiming 4.29 billion
samples allocates a four-billion-element array — harmless in a browser tab,
a one-request denial of service on a server. Every count is bounded against its
own box before anything is allocated. Do not remove those checks.

**`current_period_end` is on the SubscriptionItem, not the Subscription.** This
moved in recent Stripe API versions. Reading it off the Subscription yields
`undefined`, which computes an empty access window and locks out every paying
customer. It is isolated in `periodOf()` for that reason.

**Webhooks are a signal to re-fetch, never state to apply.** Stripe guarantees
no ordering and retries for three days. Handlers re-fetch from the API so the
last one to run writes the freshest truth, which makes arrival order irrelevant
rather than something to handle.

**Entitlement is computed at write time and read as one row.** The patch
endpoint never calls Stripe, so a Stripe outage does not stop paying customers
working.

**The paywall denies by default.** `resolveAccess` returns a denial unless a
live entitlement row says otherwise. A paywall that defaults to "allow" while
billing is half-built means the product is free and nobody notices.

---

## Security posture

Verified against a production build, not assumed:

| Control | Where |
|---|---|
| Algorithm never reaches the browser | `patch.server.ts` imports `server-only`; all 19 client chunks scanned, zero matches |
| Paywall server-enforced | `/api/patch`, `/checkout`, `/portal`, `/sync` all deny unauthenticated |
| CSP with a per-request nonce | `src/proxy.ts` — no `unsafe-eval` in production |
| CSRF | Origin checked on every mutating request; webhook exempt (HMAC-signed instead) |
| Clickjacking | `frame-ancestors 'none'` + `X-Frame-Options: DENY` |
| Sessions revocable | DB-backed, SHA-256 hashed, killed on dispute in the same transaction |
| Hostile MP4 input | Every sample-table count bounded by its own box; rejected in constant time |
| Request size | moov capped at 4 MB, checked before and after reading the body |
| Rate limits | Per-user and per-IP on auth, checkout, sync, and patch |
| No API caching | `no-store` on `/api/*`, so a patched index can never be served from a shared cache |
| Enumeration | Sign-in responds identically whether or not an account exists |

Two known gaps, both called out in the code:

- **Rate limiting is in-memory**, so limits are per-instance. Move to Redis before
  launch — the sign-in route sends email, and an unmetered one gets a domain
  blocklisted.
- **Quota counting has a benign race.** Two simultaneous requests can both pass
  the check and land one patch over the cap. For a fair-use limit that is
  acceptable; it is not acceptable if quotas ever become hard entitlements.

## Watching it

```bash
npm run canary
```

Checks the two byte-equality anchors, the live site, the paywall, the webhook
secret and that checkout still reaches Stripe — everything that can be checked
without TikTok. Runs against `CANARY_ORIGIN`, defaulting to production, and
degrades to HTTP-only checks when no database is reachable so it can run in CI.

**It cannot tell you the method still works.** That needs a fresh upload read
back from an authenticated session, so the canary tracks how long it has been
since a human confirmed one and complains when that goes stale:

```bash
npm run canary -- --confirm ok
npm run canary -- --confirm broken "served at 720p, ladder rebuilt"
```

`--confirm` writes the reading and sets `method_status`, which stops new sales
immediately. Confirmed broken also wants `npm run method:status -- broken` to
pause collection across the book.

Wait more than two minutes before reading anything back. `videoQuality` reports
`original` while a re-encode is merely pending.

## Still to do

- **Invoices carry no card details.** The fingerprint IS captured where it
  matters — `recordTrialGrant` reads it from the PaymentMethod at
  `checkout.session.completed`, so `trial_one_per_card` does bind for card
  payments. What is missing is `invoices.card_last4` and friends, which only feed
  dispute evidence, and the consent record is the far stronger item there.
  Populating them costs an extra Stripe round trip inside an already-slow webhook,
  which is why it has not been done.
  Wallet payments (Link) expose no fingerprint at all, which is why the trial
  quota — not the fingerprint — is the control that actually bounds the loss.
- **Stripe Radar controls** are dashboard settings: free-trial abuse, bot
  detection, refund abuse, adaptive 3DS. Enable one at a time and watch the block
  rate; on a low-priced product an over-tight rule bleeds sales invisibly.
- **`STRIPE_TOS_CONSENT`** stays 0 until a Terms of Service URL is set in
  Settings -> Public details. Until then there is no affirmative consent
  checkbox anywhere, only the disclosure text above Stripe's pay button.
- **Webhook responses average ~2.8s.** Slower than it should be — most likely
  Railway and Neon in different regions, plus a Stripe round trip per handler.
  Worth fixing for headroom, but NOT the emergency an earlier note implied: it is
  well inside Stripe's response window, and the observed run delivered 5 of 5
  events with zero failures.
- **The `plans` table is unused.** Pricing renders from `src/lib/plans.ts`.
  Either seed it from `stripe:seed` as a drift check, or drop it.
