CREATE TABLE "review_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"kind" text NOT NULL,
	"round" integer NOT NULL,
	"outcome" text NOT NULL,
	"why" text,
	"problems" jsonb NOT NULL,
	"warnings" jsonb NOT NULL,
	"patched" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_notes" ADD CONSTRAINT "review_notes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_notes_order_idx" ON "review_notes" USING btree ("order_id","id");