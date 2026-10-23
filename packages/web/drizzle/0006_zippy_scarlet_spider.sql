CREATE TABLE "feedback" (
	"order_id" text PRIMARY KEY NOT NULL,
	"answer" text NOT NULL,
	"post_url" text,
	"may_show" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;