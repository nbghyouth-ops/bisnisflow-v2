CREATE TABLE "exchange_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"currency_from" text NOT NULL,
	"currency_to" text NOT NULL,
	"rate" numeric(24, 10) NOT NULL,
	"effective_date" date NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_unique" UNIQUE("workspace_id","currency_from","currency_to","effective_date"),
	CONSTRAINT "fx_codes" CHECK ("exchange_rates"."currency_from" ~ '^[A-Z]{3}$' and "exchange_rates"."currency_to" ~ '^[A-Z]{3}$' and "exchange_rates"."currency_from" <> "exchange_rates"."currency_to"),
	CONSTRAINT "fx_rate" CHECK ("exchange_rates"."rate" > 0)
);
--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "currency_code" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "currency_code" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "currency_code" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD COLUMN "currency_code" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_documents" ADD COLUMN "currency_code" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fx_lookup_idx" ON "exchange_rates" USING btree ("workspace_id","currency_from","currency_to","effective_date");