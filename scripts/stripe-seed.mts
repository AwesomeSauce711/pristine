/*
 * stripe-seed.mts — create the Product and Prices in Stripe, once.
 *
 * Idempotent by lookup_key, so running it twice does not create duplicates.
 * It never edits an existing Price: Stripe Prices are immutable by design,
 * because changing what an existing subscriber pays without their agreement is
 * exactly the thing that should be hard. To change pricing, create a new Price
 * and point the env var at it.
 *
 * Run: npx tsx scripts/stripe-seed.mts
 */

import Stripe from 'stripe';
import { PLANS, PLAN_ORDER, money } from '../src/lib/plans';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('\n  STRIPE_SECRET_KEY is not set.');
  console.error('  Copy .env.example to .env.local, add your test key, then:');
  console.error('    node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/stripe-seed.mts\n');
  process.exit(1);
}

const stripe = new Stripe(key);
const live = !key.startsWith('sk_test_');

console.log(`\n  Stripe ${live ? 'LIVE' : 'test'} mode\n`);
if (live) {
  console.log('  These will be real, chargeable prices.\n');
}

/* ---- one product for all three plans ------------------------------------ */

const PRODUCT_KEY = 'pristine_subscription';

const products = await stripe.products.search({
  query: `metadata['key']:'${PRODUCT_KEY}'`,
});

let product = products.data[0];
if (product) {
  console.log(`  product   ${product.id}  (existing)`);
} else {
  product = await stripe.products.create({
    name: 'Pristine',
    description: 'Upload to TikTok without it re-encoding your video.',
    metadata: { key: PRODUCT_KEY },
  });
  console.log(`  product   ${product.id}  (created)`);
}

/* ---- one price per plan ------------------------------------------------- */

const env: string[] = [];

for (const id of PLAN_ORDER) {
  const plan = PLANS[id];
  const lookupKey = `pristine_${id}`;

  const found = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 });
  let price = found.data[0];

  if (price) {
    // Never silently reprice an existing Price — subscribers are on it.
    const matches = price.unit_amount === plan.amount
      && price.recurring?.interval === plan.interval;
    console.log(
      `  ${id.padEnd(6)}    ${price.id}  (existing)` +
      (matches ? '' : `  ** MISMATCH: Stripe has ${money(price.unit_amount ?? 0)}/${price.recurring?.interval}, code says ${money(plan.amount)}/${plan.interval} **`),
    );
  } else {
    price = await stripe.prices.create({
      product: product.id,
      lookup_key: lookupKey,
      unit_amount: plan.amount,
      currency: 'usd',
      recurring: { interval: plan.interval },
      metadata: { tier: id },
    });
    console.log(`  ${id.padEnd(6)}    ${price.id}  (created ${money(plan.amount)}/${plan.interval})`);
  }

  env.push(`${plan.priceEnv}=${price.id}`);
}

console.log('\n  Paste into .env.local:\n');
for (const line of env) console.log(`    ${line}`);

console.log(`
  Then, in the Stripe dashboard:

    1. Settings -> Public details
       Set the statement descriptor to match NEXT_PUBLIC_STATEMENT_DESCRIPTOR.
       A descriptor customers do not recognise is a leading cause of chargebacks.

    2. Settings -> Billing -> Customer portal
       Enable it, allow cancellation, and set cancellations to take effect at
       PERIOD END rather than immediately. The entitlement logic assumes this:
       'canceled' is treated as access having ended, which is only correct if a
       cancellation lands when the paid period does.

    3. Developers -> Webhooks
       Add an endpoint at <your-origin>/api/stripe/webhook subscribed to exactly:
         checkout.session.completed
         customer.subscription.created
         customer.subscription.updated
         customer.subscription.deleted
         customer.subscription.trial_will_end
         invoice.paid
         invoice.payment_failed
         charge.refunded
         charge.dispute.created
         charge.dispute.closed
         radar.early_fraud_warning.created
       Subscribing to everything is a self-inflicted denial of service.
       Copy the signing secret into STRIPE_WEBHOOK_SECRET.

    4. Settings -> Tax
       Enable Stripe Tax, then set STRIPE_AUTOMATIC_TAX=1.
`);
