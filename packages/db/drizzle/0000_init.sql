CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "api_keys_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"dc" text NOT NULL,
	"accounts_server" text NOT NULL,
	"api_domain" text NOT NULL,
	"organization_id" text NOT NULL,
	"organization_name" text,
	"plan" text,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error_code" text,
	CONSTRAINT "connections_tenant_provider_org_unique" UNIQUE("tenant_id","provider","organization_id"),
	CONSTRAINT "connections_status_check" CHECK ("connections"."status" in ('active', 'needs_reconnect', 'revoked')),
	CONSTRAINT "connections_plan_check" CHECK ("connections"."plan" in ('free', 'standard', 'professional', 'premium', 'enterprise'))
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_kind_check" CHECK ("tenants"."kind" in ('live', 'demo'))
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"request_id" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" text,
	"connector" text NOT NULL,
	"tool" text NOT NULL,
	"client_name" text,
	"demo" boolean NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"duration_ms" integer NOT NULL,
	"upstream_calls" integer NOT NULL,
	"cache_hits" integer NOT NULL,
	"retries" integer NOT NULL,
	"result_tokens" integer NOT NULL,
	"args_masked" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "usage_events_status_check" CHECK ("usage_events"."status" in ('ok', 'error'))
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_tenant_idx" ON "api_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "usage_events_tenant_ts_idx" ON "usage_events" USING btree ("tenant_id","ts" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "usage_events_ts_idx" ON "usage_events" USING btree ("ts");