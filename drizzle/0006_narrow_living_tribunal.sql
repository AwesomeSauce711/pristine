ALTER TABLE "patch_jobs" ALTER COLUMN "output_len" SET DATA TYPE bigint;--> statement-breakpoint
CREATE INDEX "refill_quota_idx" ON "patch_refills" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "refill_pi_idx" ON "patch_refills" USING btree ("stripe_payment_intent_id");