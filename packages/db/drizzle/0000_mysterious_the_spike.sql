CREATE TYPE "public"."domain_state" AS ENUM('provisioning', 'ready', 'degraded', 'failed', 'stopping', 'stopped');--> statement-breakpoint
CREATE TYPE "public"."operation_kind" AS ENUM('promote', 'demote');--> statement-breakpoint
CREATE TYPE "public"."operation_state" AS ENUM('pending', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."slot_kind" AS ENUM('inference', 'training');--> statement-breakpoint
CREATE TYPE "public"."slot_state" AS ENUM('starting', 'serving', 'sleeping', 'waking', 'probing', 'idle', 'training', 'stopping', 'failed', 'stopped');--> statement-breakpoint
CREATE TABLE "domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fleet_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"state" "domain_state" DEFAULT 'provisioning' NOT NULL,
	"provider" text NOT NULL,
	"placement" jsonb NOT NULL,
	"supervisor_url" text,
	"serving_base_url" text,
	"last_seen_at" timestamp with time zone,
	"state_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_domains_fleet_slug" UNIQUE("fleet_id","slug"),
	CONSTRAINT "domains_provider_valid" CHECK ("domains"."provider" IN ('skypilot', 'skyserve', 'static'))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"fleet_id" uuid NOT NULL,
	"domain_id" uuid,
	"slot_id" uuid,
	"operation_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"display_name" text,
	"active_domain_id" uuid,
	"route_revision" integer DEFAULT 1 NOT NULL,
	"policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fleets_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fleet_id" uuid NOT NULL,
	"kind" "operation_kind" NOT NULL,
	"state" "operation_state" DEFAULT 'pending' NOT NULL,
	"target_domain_id" uuid NOT NULL,
	"source_domain_id" uuid,
	"current_step" text,
	"step_started_at" timestamp with time zone,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain_id" uuid NOT NULL,
	"gpu_index" integer NOT NULL,
	"kind" "slot_kind" NOT NULL,
	"state" "slot_state" NOT NULL,
	"spec" jsonb NOT NULL,
	"state_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_slots_domain_gpu_kind" UNIQUE("domain_id","gpu_index","kind")
);
--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_fleet_id_fleets_id_fk" FOREIGN KEY ("fleet_id") REFERENCES "public"."fleets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_fleet_id_fleets_id_fk" FOREIGN KEY ("fleet_id") REFERENCES "public"."fleets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slots" ADD CONSTRAINT "slots_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_domains_fleet" ON "domains" USING btree ("fleet_id");--> statement-breakpoint
CREATE INDEX "idx_events_fleet" ON "events" USING btree ("fleet_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_operations_one_inflight_per_fleet" ON "operations" USING btree ("fleet_id") WHERE "operations"."state" IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX "idx_operations_fleet" ON "operations" USING btree ("fleet_id");--> statement-breakpoint
CREATE INDEX "idx_slots_domain" ON "slots" USING btree ("domain_id");