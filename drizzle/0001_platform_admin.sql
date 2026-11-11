CREATE TABLE "admin_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"reason" text,
	"outcome" text DEFAULT 'ok' NOT NULL,
	"ip" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_admins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'SUPER_ADMIN' NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_admins_email_unique" UNIQUE("email"),
	CONSTRAINT "pa_role" CHECK ("platform_admins"."role" in ('SUPER_ADMIN'))
);
--> statement-breakpoint
CREATE INDEX "aal_created_idx" ON "admin_audit_log" USING btree ("created_at");