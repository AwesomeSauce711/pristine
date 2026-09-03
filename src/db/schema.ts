import {
  bigint, boolean, index, inet, integer, jsonb, pgTable, smallint, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';

/*
 * schema.ts — the database.
 *
 * THE ONE IDEA THAT SHAPES THIS FILE
 * Entitlement is computed at WRITE time by the Stripe webhook handler and
 * denormalised into a single row per user. The patch endpoint then answers "is
 * this person allowed?" with one primary-key lookup and never calls Stripe.
 *
 * Two consequences worth having:
 *   1. If Stripe is down, paying customers can still use the product. Checking
 *      entitlement by calling Stripe's API would make their outage our outage.
 *   2. The money endpoint does not inherit a third party's latency.
 *
 * The cost is that the mapping from Stripe's status to our access window has to
 * be applied atomically with every subscription write. That lives in
 * `src/lib/billing/entitlement.ts`, deliberately in one function.
 */

/* --------------------------------------------------------------- accounts */

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),

  /*
   * Created BEFORE the first checkout, not after.
   *
   * This is what dissolves the classic webhook ordering race. Only
   * `checkout.session.completed` carries `client_reference_id`, so if the
   * Stripe customer is created during checkout, a `customer.subscription.created`
   * that arrives first describes a subscription we cannot map to a user. Create
   * the customer at signup and every subscription event can be resolved by
   * lookup, whatever order they arrive in.
   */
  stripeCustomerId: text('stripe_customer_id'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  signupIp: inet('signup_ip'),
  signupUserAgent: text('signup_user_agent'),

  /* Set on dispute or confirmed abuse. Blocking a user MUST also write
   * entitlements.revokedAt in the same transaction — see the note there. */
  blockedAt: timestamp('blocked_at', { withTimezone: true }),
  blockedReason: text('blocked_reason'),
}, (t) => [
  uniqueIndex('users_email_key').on(t.email),
  uniqueIndex('users_stripe_customer_key').on(t.stripeCustomerId),
]);

/*
 * Opaque server-side sessions, not stateless JWTs.
 *
 * A JWT keeps working until it expires, which means a chargeback cannot revoke
 * access until then. Here, `charge.dispute.created` can revoke every session in
 * the same transaction that revokes entitlement.
 */
export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /* SHA-256 of the cookie value. The raw token is never stored, so a database
   * leak does not hand over live sessions. */
  tokenHash: text('token_hash').notNull(),
  deviceId: text('device_id').notNull(),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('sessions_token_key').on(t.tokenHash),
  index('sessions_user_idx').on(t.userId, t.expiresAt),
]);

/** Short-lived email codes. Hashed, attempt-capped, single-use. */
export const loginTokens = pgTable('login_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  codeHash: text('code_hash').notNull(),
  purpose: text('purpose').notNull(),          // signin | verify_email
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  attempts: smallint('attempts').notNull().default(0),
  ip: inet('ip'),
}, (t) => [index('login_tokens_lookup_idx').on(t.email, t.purpose, t.expiresAt)]);

/* --------------------------------------------------------------- billing */

/** Mirror of the Stripe Prices, so pricing renders without an API round-trip. */
export const plans = pgTable('plans', {
  priceId: text('price_id').primaryKey(),
  productId: text('product_id').notNull(),
  tier: text('tier').notNull(),                // week | month | year
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull().default('usd'),
  interval: text('interval').notNull(),
  trialDays: smallint('trial_days').notNull().default(0),
  graceHours: smallint('grace_hours').notNull(),
  dailyPatchCap: integer('daily_patch_cap').notNull(),
  periodPatchCap: integer('period_patch_cap').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: smallint('sort_order').notNull(),
});

/*
 * Deliberately NO unique constraint on "one live subscription per user".
 *
 * A constraint that can make a webhook handler fail permanently is a liability:
 * you would have a customer who has paid and a handler that can never succeed.
 * Double-subscribing is prevented at checkout-creation time instead, and this
 * table records whatever Stripe says is true.
 */
export const subscriptions = pgTable('subscriptions', {
  stripeSubscriptionId: text('stripe_subscription_id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  stripeCustomerId: text('stripe_customer_id').notNull(),
  priceId: text('price_id').notNull(),
  status: text('status').notNull(),            // Stripe's value, verbatim
  currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  trialStart: timestamp('trial_start', { withTimezone: true }),
  trialEnd: timestamp('trial_end', { withTimezone: true }),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  canceledAt: timestamp('canceled_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),

  /* Null means they have never actually paid. Grace after a failed charge is
   * withheld in that case, so a trial whose first charge fails does not get
   * extra free days on top of the trial. */
  firstPaidAt: timestamp('first_paid_at', { withTimezone: true }),
  /** The period end the annual renewal notice was sent for; null until sent.
   *  Compared against current_period_end, so each term gets exactly one. */
  renewalNoticeFor: timestamp('renewal_notice_for', { withTimezone: true }),

  /* The `created` timestamp of the newest Stripe event applied to this row.
   * An older event arriving late is ignored rather than overwriting newer state. */
  lastEventCreated: timestamp('last_event_created', { withTimezone: true }),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  raw: jsonb('raw'),
}, (t) => [
  index('subs_user_idx').on(t.userId, t.status),
  index('subs_synced_idx').on(t.syncedAt),
]);

/**
 * One row per user. The ONLY thing the patch endpoint reads.
 *
 * `accessUntil` already folds in the trial window, the paid period, and any
 * grace tail, so the hot query has no status logic in it at all.
 */
export const entitlements = pgTable('entitlements', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  state: text('state').notNull().default('none'),   // none|trialing|active|grace|expired|revoked
  accessUntil: timestamp('access_until', { withTimezone: true }).notNull().defaultNow(),
  sourceSubscriptionId: text('source_subscription_id'),
  priceId: text('price_id'),
  tier: text('tier'),
  inTrial: boolean('in_trial').notNull().default(false),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  periodStartedAt: timestamp('period_started_at', { withTimezone: true }),
  dailyPatchCap: integer('daily_patch_cap').notNull().default(0),
  periodPatchCap: integer('period_patch_cap').notNull().default(0),

  /* Set on dispute or refund. Checked in the hot query, so revocation is
   * immediate regardless of what the subscription window says. */
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedReason: text('revoked_reason'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------------------ usage/audit */

/** One row per patch attempt. No moov bytes are ever stored — lengths and a hash only. */
export const patchJobs = pgTable('patch_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: text('status').notNull(),            // completed | failed | rejected
  deviceId: text('device_id'),
  ip: inet('ip'),
  multiplier: smallint('multiplier').notNull(),
  moovSha256: text('moov_sha256').notNull(),
  moovLen: integer('moov_len').notNull(),
  /** Bigint: a 4K file runs past the 2 GB an integer column can hold. */
  outputLen: bigint('output_len', { mode: 'number' }),
  realSamples: integer('real_samples'),
  phantomSamples: integer('phantom_samples'),
  clonedTrack: boolean('cloned_track'),
  /* Whether the source carried an edit list on the decoy that had to be
   * neutralised. Diagnostic: if the method ever regresses, the first question
   * is which shape of input was affected. */
  neutralisedEdts: boolean('neutralised_edts'),
  durationMs: integer('duration_ms'),
  errorCode: text('error_code'),

  /* A failed or rejected attempt must not cost the user a credit. */
  countsAgainstQuota: boolean('counts_against_quota').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('patch_quota_idx').on(t.userId, t.createdAt),
]);

/**
 * The exact words shown next to the card field, stored verbatim.
 *
 * This is evidence, not analytics. US ROSCA and state automatic-renewal laws
 * require the price, frequency, first-charge date and cancellation method to be
 * disclosed before billing details are taken; this row is what proves they were.
 * It is also the strongest single item in a chargeback response.
 */
export const consents = pgTable('consents', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  kind: text('kind').notNull(),                // trial_negative_option | immediate_charge
  priceId: text('price_id').notNull(),
  disclosureText: text('disclosure_text').notNull(),
  disclosureSha256: text('disclosure_sha256').notNull(),
  amountCents: integer('amount_cents').notNull(),
  interval: text('interval').notNull(),
  firstChargeAt: timestamp('first_charge_at', { withTimezone: true }).notNull(),
  checkboxChecked: boolean('checkbox_checked').notNull(),
  ip: inet('ip').notNull(),
  userAgent: text('user_agent').notNull(),
  pageUrl: text('page_url').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const invoices = pgTable('invoices', {
  stripeInvoiceId: text('stripe_invoice_id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  stripeSubscriptionId: text('stripe_subscription_id'),
  stripeChargeId: text('stripe_charge_id'),
  status: text('status').notNull(),
  billingReason: text('billing_reason'),
  amountDueCents: integer('amount_due_cents').notNull(),
  amountPaidCents: integer('amount_paid_cents').notNull(),
  amountRefundedCents: integer('amount_refunded_cents').notNull().default(0),
  currency: text('currency').notNull(),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  attemptCount: smallint('attempt_count'),
  nextPaymentAttempt: timestamp('next_payment_attempt', { withTimezone: true }),
  hostedInvoiceUrl: text('hosted_invoice_url'),

  /* Stable per card number across different Stripe customers, so it survives a
   * new email and a new account. This is what makes one-trial-per-card work. */
  cardFingerprint: text('card_fingerprint'),
  cardFunding: text('card_funding'),
  cardCountry: text('card_country'),
  cardLast4: text('card_last4'),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('invoices_charge_key').on(t.stripeChargeId),
  index('invoices_user_idx').on(t.userId, t.paidAt),
  index('invoices_card_idx').on(t.cardFingerprint),
]);

export const disputes = pgTable('disputes', {
  stripeDisputeId: text('stripe_dispute_id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  stripeChargeId: text('stripe_charge_id').notNull(),
  amountCents: integer('amount_cents').notNull(),
  reason: text('reason'),
  status: text('status').notNull(),
  evidenceDueBy: timestamp('evidence_due_by', { withTimezone: true }),
  evidenceSubmittedAt: timestamp('evidence_submitted_at', { withTimezone: true }),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
});

/** One trial per user and per card. Enforced after checkout, when the fingerprint is known. */
export const trialGrants = pgTable('trial_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  stripeSubscriptionId: text('stripe_subscription_id'),
  cardFingerprint: text('card_fingerprint'),
  emailDomain: text('email_domain').notNull(),
  /* Why cardFingerprint is null when it is: 'card' | 'link' | 'us_bank_account'
   * ... Wallets expose no fingerprint, so the per-card index cannot bind them —
   * a documented gap rather than an accident. */
  pmType: text('pm_type'),
  signupIp: inet('signup_ip'),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  outcome: text('outcome'),   // converted | cancelled | failed_payment | blocked_duplicate
}, (t) => [
  uniqueIndex('trial_one_per_user').on(t.userId),
  uniqueIndex('trial_one_per_card').on(t.cardFingerprint),
  uniqueIndex('trial_one_per_subscription').on(t.stripeSubscriptionId),
]);

/**
 * Idempotency ledger for webhooks.
 *
 * Stripe retries for up to three days and makes no ordering guarantee, so every
 * handler must tolerate the same event arriving twice and events arriving out
 * of order. This table handles the first; `subscriptions.lastEventCreated`
 * handles the second.
 */
export const stripeEvents = pgTable('stripe_events', {
  id: text('id').primaryKey(),                 // evt_...
  type: text('type').notNull(),
  created: timestamp('created', { withTimezone: true }).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  status: text('status').notNull(),            // processing | processed | failed | ignored
  attempts: smallint('attempts').notNull().default(0),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  error: text('error'),
  livemode: boolean('livemode').notNull(),
}, (t) => [index('stripe_events_status_idx').on(t.status, t.receivedAt)]);

/**
 * Operational flags, changeable without a deploy.
 *
 * The one that matters is `method_status`. This product depends on a quirk of
 * someone else's ingest pipeline, and that pipeline can change overnight. When
 * it does, the difference between a bad week and a terminated Stripe account is
 * how fast billing can be stopped — and "push a commit and wait for a build" is
 * not fast enough at 2am. Charging weekly for something that has silently
 * stopped working is a dispute avalanche and an FTC Act 5 problem at once.
 *
 * A table rather than an env var precisely because env vars need a redeploy.
 */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  note: text('note'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A checkout started by someone with no account yet.
 *
 * WHY THIS EXISTS
 * Requiring an account before payment is what created the whole detour: choose a
 * plan, get sent to sign-in, wait for an email, come back, and choose the plan
 * again because the choice lived in React state. Letting Stripe collect the email
 * during checkout deletes that entire leg — but it means a session has to be
 * mintable for someone who has not proved they control the address, and that is
 * a dangerous thing to get slightly wrong.
 *
 * WHY A NONCE HASH AND NOT THE STRIPE SESSION ID
 * The obvious design returns to /welcome?session_id=cs_... and mints a session
 * from it. That turns a value Stripe deliberately puts in the URL bar into a
 * login credential: it lands in browser history, in synced history across the
 * user's devices, in the host's access logs, and in any support chat where
 * someone pastes "did this work?". Instead a random nonce is set as an httpOnly
 * cookie before the redirect and only its SHA-256 is stored here — the same
 * discipline sessions.tokenHash already uses. The URL carries nothing.
 *
 * `claimed_at` is enforced by a conditional UPDATE rather than a read-then-write,
 * so two racing requests cannot both claim one checkout.
 */
export const pendingCheckouts = pgTable('pending_checkouts', {
  id: uuid('id').primaryKey().defaultRandom(),
  /* SHA-256 of the claim nonce. The raw value exists only in the user's cookie. */
  nonceHash: text('nonce_hash').notNull().unique(),
  stripeSessionId: text('stripe_session_id').notNull().unique(),
  plan: text('plan').notNull(),
  consentId: uuid('consent_id').references(() => consents.id, { onDelete: 'set null' }),
  /* Null until the webhook resolves the email Stripe collected. */
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  /* Whether that email already had an account. If it did, paying does NOT sign
   * anyone in — Stripe does not verify the buyer controls the address, so
   * attaching a session would be account takeover for the price of one week. */
  emailWasNew: boolean('email_was_new'),
  ip: inet('ip'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
});

/*
 * patch_refills -- extra patches bought for today.
 *
 * A plan's daily cap is the thing that stops one subscription serving a whole
 * group chat, and it is also the thing that stops a single customer who
 * genuinely needs a fourth export today. A refill resolves that without an
 * upgrade: 99 cents adds one more day's allowance -- the plan's own cap --
 * for the next 24 hours, and again for the period, as many times as they
 * like. Each row is one purchase; the allowance is summed at read time in
 * resolveAccess, so nothing here is ever "spent" or decremented.
 *
 * Revoked on refund (charge.refunded matched by payment intent), so a refund
 * takes the allowance with it.
 */
export const patchRefills = pgTable('patch_refills', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Patches this refill adds: the plan's daily cap at the time of purchase. */
  count: integer('count').notNull(),
  amountCents: integer('amount_cents').notNull(),
  stripeSessionId: text('stripe_session_id').notNull().unique(),
  stripePaymentIntentId: text('stripe_payment_intent_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [
  /* Every access check sums a user's refills for the day and the period. */
  index('refill_quota_idx').on(t.userId, t.createdAt),
  /* A refund finds its refill by the PaymentIntent. */
  index('refill_pi_idx').on(t.stripePaymentIntentId),
]);
