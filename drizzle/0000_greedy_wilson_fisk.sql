CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"kind" text NOT NULL,
	"price_id" text NOT NULL,
	"disclosure_text" text NOT NULL,
	"disclosure_sha256" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"interval" text NOT NULL,
	"first_charge_at" timestamp with time zone NOT NULL,
	"checkbox_checked" boolean NOT NULL,
	"ip" "inet" NOT NULL,
	"user_agent" text NOT NULL,
	"page_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"stripe_dispute_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"stripe_charge_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" text,
	"status" text NOT NULL,
	"evidence_due_by" timestamp with time zone,
	"evidence_submitted_at" timestamp with time zone,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "entitlements" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'none' NOT NULL,
	"access_until" timestamp with time zone DEFAULT now() NOT NULL,
	"source_subscription_id" text,
	"price_id" text,
	"tier" text,
	"in_trial" boolean DEFAULT false NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"period_started_at" timestamp with time zone,
	"daily_patch_cap" integer DEFAULT 0 NOT NULL,
	"period_patch_cap" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"stripe_invoice_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"stripe_subscription_id" text,
	"stripe_charge_id" text,
	"status" text NOT NULL,
	"billing_reason" text,
	"amount_due_cents" integer NOT NULL,
	"amount_paid_cents" integer NOT NULL,
	"amount_refunded_cents" integer DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"paid_at" timestamp with time zone,
	"attempt_count" smallint,
	"next_payment_attempt" timestamp with time zone,
	"hosted_invoice_url" text,
	"card_fingerprint" text,
	"card_funding" text,
	"card_country" text,
	"card_last4" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"purpose" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"ip" "inet"
);
--> statement-breakpoint
CREATE TABLE "patch_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text NOT NULL,
	"device_id" text,
	"ip" "inet",
	"multiplier" smallint NOT NULL,
	"moov_sha256" text NOT NULL,
	"moov_len" integer NOT NULL,
	"output_len" integer,
	"real_samples" integer,
	"phantom_samples" integer,
	"cloned_track" boolean,
	"duration_ms" integer,
	"error_code" text,
	"counts_against_quota" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"price_id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"tier" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"interval" text NOT NULL,
	"trial_days" smallint DEFAULT 0 NOT NULL,
	"grace_hours" smallint NOT NULL,
	"daily_patch_cap" integer NOT NULL,
	"period_patch_cap" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" smallint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"device_id" text NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"created" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	"livemode" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"stripe_subscription_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"price_id" text NOT NULL,
	"status" text NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"trial_start" timestamp with time zone,
	"trial_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"first_paid_at" timestamp with time zone,
	"last_event_created" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "trial_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"stripe_subscription_id" text,
	"card_fingerprint" text,
	"email_domain" text NOT NULL,
	"signup_ip" "inet",
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"stripe_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signup_ip" "inet",
	"signup_user_agent" text,
	"blocked_at" timestamp with time zone,
	"blocked_reason" text
);
--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patch_jobs" ADD CONSTRAINT "patch_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial_grants" ADD CONSTRAINT "trial_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_charge_key" ON "invoices" USING btree ("stripe_charge_id");--> statement-breakpoint
CREATE INDEX "invoices_user_idx" ON "invoices" USING btree ("user_id","paid_at");--> statement-breakpoint
CREATE INDEX "invoices_card_idx" ON "invoices" USING btree ("card_fingerprint");--> statement-breakpoint
CREATE INDEX "login_tokens_lookup_idx" ON "login_tokens" USING btree ("email","purpose","expires_at");--> statement-breakpoint
CREATE INDEX "patch_quota_idx" ON "patch_jobs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "stripe_events_status_idx" ON "stripe_events" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "subs_user_idx" ON "subscriptions" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "subs_synced_idx" ON "subscriptions" USING btree ("synced_at");--> statement-breakpoint
CREATE UNIQUE INDEX "trial_one_per_user" ON "trial_grants" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trial_one_per_card" ON "trial_grants" USING btree ("card_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "trial_one_per_subscription" ON "trial_grants" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_stripe_customer_key" ON "users" USING btree ("stripe_customer_id");