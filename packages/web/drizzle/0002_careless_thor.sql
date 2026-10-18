ALTER TABLE "refunds" ADD COLUMN "nonce" integer;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "replaced_tx_hash" text;--> statement-breakpoint
CREATE INDEX "refunds_nonce_idx" ON "refunds" USING btree ("nonce");--> statement-breakpoint
CREATE INDEX "refunds_updated_idx" ON "refunds" USING btree ("updated_at");