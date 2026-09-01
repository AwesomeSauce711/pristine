/*
 * stripe-listen.mjs — start `stripe listen` against the SAME Stripe account the
 * app is configured for, and capture the signing secret automatically.
 *
 * WHY THIS EXISTS
 * A Stripe sandbox is a separate account with its own keys, products and event
 * stream. The dashboard drops you into one by default, so it is very easy to end
 * up with STRIPE_SECRET_KEY on the sandbox while the CLI is logged into the
 * parent account. Nothing errors. Checkout completes, no webhook ever arrives,
 * the subscription never activates, and it presents as an application bug.
 *
 * Passing --api-key makes the CLI listen to exactly the account the app talks
 * to, so the two cannot drift apart. The signing secret is then written into
 * .env.local for you, because copying it by hand is the other half of the same
 * failure.
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const ENV_FILE = '.env.local';
const PORT = process.env.PORT ?? '3001';
const key = process.env.STRIPE_SECRET_KEY;

if (!key) {
  console.error('\n  STRIPE_SECRET_KEY is not set in .env.local.\n');
  process.exit(1);
}
if (key.startsWith('sk_live_')) {
  console.error('\n  That is a LIVE key. Refusing to forward live events to localhost.\n');
  process.exit(1);
}

function setEnv(name, value) {
  const src = readFileSync(ENV_FILE, 'utf8');
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, 'm');
  writeFileSync(ENV_FILE, re.test(src) ? src.replace(re, line) : `${src.trimEnd()}\n${line}\n`);
}

const args = [
  'listen',
  '--api-key', key,
  '--forward-to', `localhost:${PORT}/api/stripe/webhook`,
];

console.log(`\n  forwarding to localhost:${PORT}/api/stripe/webhook`);
console.log('  leave this window open — Ctrl+C to stop\n');

const child = spawn('stripe', args, { shell: true });

let captured = false;
function pass(chunk) {
  const text = chunk.toString();
  process.stdout.write(text);

  if (!captured) {
    const m = text.match(/whsec_[A-Za-z0-9]+/);
    if (m) {
      captured = true;
      setEnv('STRIPE_WEBHOOK_SECRET', m[0]);
      console.log(`\n  ✓ written to ${ENV_FILE}: STRIPE_WEBHOOK_SECRET=${m[0].slice(0, 11)}…`);
      console.log('    restart `npm run dev` so it picks the value up.\n');
    }
  }
}

child.stdout.on('data', pass);
child.stderr.on('data', pass);

child.on('error', (e) => {
  console.error(`\n  could not run the Stripe CLI: ${e.message}`);
  console.error('  install it with:  winget install Stripe.StripeCli\n');
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 0));
