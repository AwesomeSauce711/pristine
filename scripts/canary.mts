/*
 * canary.mts — is the product still working?
 *
 * WHAT THIS CAN AND CANNOT DO, STATED UP FRONT
 *
 * The failure that matters most is TikTok changing their ingest, and NOTHING
 * here can detect that on its own. Confirming it requires uploading a freshly
 * patched file to a real account and reading back what gets served, and both
 * halves of that need an authenticated TikTok session. Automating it would mean
 * driving a logged-in browser on a schedule — fragile, and a good way to get an
 * account flagged. A canary that silently stopped working would be worse than
 * no canary, because you would trust it.
 *
 * So this does two things instead:
 *
 *   1. Checks everything that CAN be checked without TikTok — the patch output,
 *      the live site, the paywall, checkout, the webhook. That catches broken
 *      deploys, expired keys, database outages and code regressions, which are
 *      the failures you are far more likely to hit.
 *
 *   2. Tracks how long it has been since a HUMAN confirmed a real upload came
 *      back untouched, and complains when that goes stale. The nag is the point:
 *      it converts "I should check that sometime" into a number that grows.
 *
 *   npm run canary                          run the checks
 *   npm run canary -- --confirm ok          record that a real upload came back clean
 *   npm run canary -- --confirm broken "…"  record that it did not, and stop selling
 */

import { spawnSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { METHOD_STATUS_KEY, type MethodStatus } from '../src/lib/method-status';

/*
 * Deliberately NOT NEXT_PUBLIC_ORIGIN. That variable is whatever the local
 * environment is pointed at, which on a dev machine is localhost — and a canary
 * that cheerfully reports localhost is healthy is worse than none.
 */
const ORIGIN = (process.env.CANARY_ORIGIN ?? 'https://pristine4k.com').replace(/\/+$/, '');
const LAST_CONFIRMED_KEY = 'canary_last_confirmed';
const STALE_AFTER_DAYS = 7;

const args = process.argv.slice(2);
const confirmIdx = args.indexOf('--confirm');
/* For CI, where the reference media and the database are both absent. */
const httpOnly = args.includes('--http-only');

/* ------------------------------------------------------- human confirmation */

if (confirmIdx !== -1) {
  const value = args[confirmIdx + 1];
  const note = args[confirmIdx + 2] ?? null;
  const valid: MethodStatus[] = ['ok', 'degraded', 'broken'];
  if (!valid.includes(value as MethodStatus)) {
    console.error(`\n  --confirm needs one of: ${valid.join(', ')}\n`);
    process.exit(1);
  }
  const status = value as MethodStatus;

  await db().insert(schema.settings)
    .values({ key: LAST_CONFIRMED_KEY, value: new Date().toISOString(), note, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: new Date().toISOString(), note, updatedAt: new Date() },
    });

  await db().insert(schema.settings)
    .values({ key: METHOD_STATUS_KEY, value: status, note, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: status, note, updatedAt: new Date() },
    });

  console.log(`\n  Recorded a real-upload check: ${status.toUpperCase()}`);
  if (note) console.log(`  note: ${note}`);
  console.log(status === 'ok'
    ? '  Selling stays open.\n'
    : '  The notice is up; selling and billing continue.\n'
      + '  If this is confirmed broken, stop new sales (subscribers keep their plans):\n'
      + '    npm run method:status -- broken "TikTok changed how uploads are processed."\n');
  process.exit(0);
}

/* ------------------------------------------------------------- the checks */

interface Check { name: string; ok: boolean; detail: string; fatal: boolean }
const checks: Check[] = [];

const add = (name: string, ok: boolean, detail: string, fatal = true) =>
  checks.push({ name, ok, detail, fatal });

async function http(path: string, init?: RequestInit): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(`${ORIGIN}${path}`, { ...init, signal: AbortSignal.timeout(25_000) });
    return { status: res.status, body: (await res.text()).slice(0, 400) };
  } catch (e) {
    return { status: 0, body: e instanceof Error ? e.message : String(e) };
  }
}

/*
 * The two byte-equality anchors. If either drifts, the file being sold is no
 * longer the file that was measured working — which is the one regression that
 * would be invisible from the outside.
 */
if (!httpOnly) {
  for (const [label, script, proof] of [
    ['4K60 anchor', 'verify:patch', 'byte-for-byte the file TikTok accepted'],
    ['edit-list anchor', 'verify:elst', 'reproduces the accepted upload'],
  ] as const) {
    const r = spawnSync('npm', ['run', '--silent', script], { encoding: 'utf8', shell: true });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;

    /*
     * Both anchor scripts guard their byte-equality assertions with existsSync
     * and exit 0 when the reference files are absent. So a green exit code alone
     * would let this report "byte-identical" having compared nothing — a false
     * pass, which is worse than a failure because it is believed. Look for the
     * assertion's own text instead of trusting the status.
     */
    const actuallyCompared = out.includes(proof);
    if (r.status !== 0) {
      add(label, false, 'DRIFTED');
    } else if (actuallyCompared) {
      add(label, true, 'byte-identical');
    } else {
      add(label, false, 'NOT CHECKED — reference file missing on this machine', false);
    }
  }
}

const home = await http('/');
add('site responds', home.status === 200, `GET / -> ${home.status || home.body}`);

const patch = await http('/api/patch', { method: 'POST', body: '{}' });
add('paywall holds', patch.status === 401, `unauthenticated POST /api/patch -> ${patch.status}`);

const hook = await http('/api/stripe/webhook', { method: 'POST', body: '{}' });
add('webhook secret configured', hook.status === 400,
  hook.status === 500 ? 'STRIPE_WEBHOOK_SECRET is missing' : `-> ${hook.status}`);

/*
 * This creates a real Checkout Session on every run, which expires unused after
 * 30 minutes. That clutter is the price of the only check that proves the live
 * key and the price ids still agree with each other — the exact mismatch that
 * silently breaks checkout when someone rotates a key.
 */
const checkout = await http('/api/billing/checkout', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: ORIGIN },
  body: JSON.stringify({ plan: 'week', consented: true }),
});
/* Checkout needs a session now, so an anonymous call proves only that the
 * route is up and refuses correctly. The key-and-prices agreement it used to
 * prove is read from /api/status instead, below. */
add('checkout route refuses anonymous', checkout.status === 401 && checkout.body.includes('sign_in_required'),
  checkout.status === 503 ? 'selling is paused (method_status is not ok)' : `-> ${checkout.status}`,
  checkout.status !== 503);

const status = await http('/api/status');
let prices = 'unreadable';
try { prices = String(JSON.parse(status.body).prices ?? 'missing'); } catch { /* not json */ }
add('live prices match the site', prices === 'ok',
  prices === 'mismatch' ? 'a STRIPE_PRICE_* id disagrees with plans.ts -- checkout is refusing sales'
    : `-> ${prices}`);

/* ---- how stale is the last human confirmation? -------------------------- */

let lastConfirmed: Date | null = null;
let dbReachable = true;
try {
  const rows = await db().select().from(schema.settings)
    .where(eq(schema.settings.key, LAST_CONFIRMED_KEY)).limit(1);
  lastConfirmed = rows[0]?.value ? new Date(rows[0].value) : null;
} catch {
  // No DATABASE_URL, or it is unreachable. The HTTP checks above still stand on
  // their own, so report what we have rather than failing the whole run.
  dbReachable = false;
}
const days = lastConfirmed
  ? Math.floor((Date.now() - lastConfirmed.getTime()) / 86_400_000)
  : null;

if (dbReachable) {
  add('real upload confirmed recently',
    days !== null && days <= STALE_AFTER_DAYS,
    days === null
      ? 'NEVER — no upload has been confirmed through this tool'
      : `${days} day(s) ago${days > STALE_AFTER_DAYS ? ' — stale' : ''}`,
    false);
}

/* ------------------------------------------------------------------ report */

console.log(`\n  canary  ${ORIGIN}\n`);
let failed = 0;
for (const c of checks) {
  const mark = c.ok ? 'ok  ' : (c.fatal ? 'FAIL' : 'warn');
  if (!c.ok && c.fatal) failed++;
  console.log(`  ${mark} ${c.name.padEnd(30)} ${c.detail}`);
}

if (dbReachable) {
  const current = await db().select().from(schema.settings)
    .where(eq(schema.settings.key, METHOD_STATUS_KEY)).limit(1);
  console.log(`\n  method_status: ${(current[0]?.value ?? 'ok').toUpperCase()}`);
} else {
  console.log('\n  (no database reachable — HTTP checks only)');
}

if (dbReachable && (days === null || days > STALE_AFTER_DAYS)) {
  console.log(`
  NOTHING HERE PROVES THE METHOD STILL WORKS.
  These checks cover the site, not TikTok. To actually confirm:

    1. Patch a video at ${ORIGIN}/app
    2. Upload it to a test account
    3. Wait MORE than two minutes — videoQuality reads "original" while a
       re-encode is merely pending, so anything sooner means nothing
    4. Then record what you saw:

         npm run canary -- --confirm ok
         npm run canary -- --confirm broken "served at 720p, ladder rebuilt"
`);
}

console.log(failed ? `\n  ${failed} check(s) failed.\n` : '\n  All automated checks passed.\n');
process.exit(failed ? 1 : 0);
