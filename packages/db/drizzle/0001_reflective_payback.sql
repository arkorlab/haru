ALTER TABLE "operations" ADD COLUMN "routing_committed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill in-flight promotes that committed routing under the OLD
-- switchActive (which did not stamp this column): a running promote at
-- switch_active whose fleet pointer already equals its target IS live.
-- Without this its column defaults to false, and although the timeout
-- and executor paths both re-read the pointer and converge to done, the
-- backfill makes the "pointer at target => routing_committed" invariant
-- hold immediately after migration instead of relying on that re-read.
UPDATE "operations" SET "routing_committed" = true
FROM "fleets"
WHERE "operations"."fleet_id" = "fleets"."id"
  AND "operations"."kind" = 'promote'
  AND "operations"."state" = 'running'
  AND "operations"."current_step" = 'switch_active'
  AND "fleets"."active_domain_id" = "operations"."target_domain_id";
