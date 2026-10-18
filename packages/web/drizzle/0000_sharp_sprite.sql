CREATE TABLE "costs" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"item" text NOT NULL,
	"usd" numeric(14, 6) NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'awaiting_settlement' NOT NULL,
	"request" jsonb NOT NULL,
	"network" text NOT NULL,
	"asset" text NOT NULL,
	"payer" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"nonce" text NOT NULL,
	"valid_after" numeric(78, 0) NOT NULL,
	"valid_before" numeric(78, 0) NOT NULL,
	"settle_tx" text,
	"run_id" text,
	"steps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deliverables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failure_reason" text,
	"vm_token_hash" text,
	"vm_token_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"key" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"kind" text NOT NULL,
	"max_atomic" numeric(78, 0) NOT NULL,
	"status" text DEFAULT 'intent' NOT NULL,
	"asset" text,
	"amount" numeric(78, 0),
	"tx_hash" text,
	"authorization" jsonb,
	"poll_url" text,
	"outcome" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prechecks" (
	"key" text PRIMARY KEY NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"order_id" text PRIMARY KEY NOT NULL,
	"to_address" text NOT NULL,
	"asset" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"raw_tx" text,
	"tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vm_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" serial NOT NULL,
	"order_id" text NOT NULL,
	"kind" text NOT NULL,
	"round" integer NOT NULL,
	"input" jsonb NOT NULL,
	"hook_token" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vm_tasks" ADD CONSTRAINT "vm_tasks_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "costs_order_idx" ON "costs" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "costs_kind_created_idx" ON "costs" USING btree ("kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_payment_idx" ON "orders" USING btree (lower("asset"),lower("payer"),lower("nonce"));--> statement-breakpoint
CREATE INDEX "orders_vm_token_hash_idx" ON "orders" USING btree ("vm_token_hash");--> statement-breakpoint
CREATE INDEX "orders_status_created_idx" ON "orders" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "vm_tasks_hook_token_idx" ON "vm_tasks" USING btree ("hook_token");--> statement-breakpoint
CREATE INDEX "vm_tasks_claim_idx" ON "vm_tasks" USING btree ("order_id","status","seq");