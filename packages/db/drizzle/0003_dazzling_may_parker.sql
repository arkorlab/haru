DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "fleets" AS "fleet"
		LEFT JOIN "domains" AS "domain"
			ON "domain"."fleet_id" = "fleet"."id"
			AND "domain"."id" = "fleet"."active_domain_id"
		WHERE "fleet"."active_domain_id" IS NOT NULL
			AND "domain"."id" IS NULL
	) THEN
		RAISE EXCEPTION 'cannot add fleet/domain ownership constraints: a fleet active pointer targets another fleet or a missing domain';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "operations" AS "operation"
		LEFT JOIN "domains" AS "domain"
			ON "domain"."fleet_id" = "operation"."fleet_id"
			AND "domain"."id" = "operation"."target_domain_id"
		WHERE "domain"."id" IS NULL
	) THEN
		RAISE EXCEPTION 'cannot add fleet/domain ownership constraints: an operation target belongs to another fleet or is missing';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "operations" AS "operation"
		LEFT JOIN "domains" AS "domain"
			ON "domain"."fleet_id" = "operation"."fleet_id"
			AND "domain"."id" = "operation"."source_domain_id"
		WHERE "operation"."source_domain_id" IS NOT NULL
			AND "domain"."id" IS NULL
	) THEN
		RAISE EXCEPTION 'cannot add fleet/domain ownership constraints: an operation source belongs to another fleet or is missing';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "fleets" AS "fleet"
		WHERE CASE
			WHEN jsonb_typeof("fleet"."policy" #> '{probe,prompt}') = 'string'
				THEN char_length("fleet"."policy" #>> '{probe,prompt}') > 8192
			ELSE FALSE
		END
	) THEN
		RAISE EXCEPTION 'cannot apply probe policy limits: a fleet policy probe.prompt exceeds 8192 Unicode code points';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "fleets" AS "fleet"
		WHERE CASE
			WHEN jsonb_typeof("fleet"."policy" #> '{probe,maxTokens}') = 'number'
				THEN ("fleet"."policy" #>> '{probe,maxTokens}')::numeric > 256
			ELSE FALSE
		END
	) THEN
		RAISE EXCEPTION 'cannot apply probe policy limits: a fleet policy probe.maxTokens exceeds 256';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "slots"
		WHERE NOT (
			("kind" = 'inference' AND "state" IN ('starting', 'serving', 'sleeping', 'waking', 'probing', 'failed', 'stopped'))
			OR
			("kind" = 'training' AND "state" IN ('idle', 'training', 'stopping', 'failed', 'stopped'))
		)
	) THEN
		RAISE EXCEPTION 'cannot add slot kind/state constraint: a slot has a state invalid for its kind';
	END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE "operations" DROP CONSTRAINT "operations_target_domain_id_domains_id_fk";
--> statement-breakpoint
ALTER TABLE "operations" DROP CONSTRAINT "operations_source_domain_id_domains_id_fk";
--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "uq_domains_fleet_id" UNIQUE("fleet_id","id");--> statement-breakpoint
ALTER TABLE "fleets" ADD CONSTRAINT "fleets_active_domain_membership_fk" FOREIGN KEY ("id","active_domain_id") REFERENCES "public"."domains"("fleet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_target_domain_membership_fk" FOREIGN KEY ("fleet_id","target_domain_id") REFERENCES "public"."domains"("fleet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_source_domain_membership_fk" FOREIGN KEY ("fleet_id","source_domain_id") REFERENCES "public"."domains"("fleet_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slots" ADD CONSTRAINT "slots_kind_state_valid" CHECK ((("slots"."kind" = 'inference' AND "slots"."state" IN ('starting', 'serving', 'sleeping', 'waking', 'probing', 'failed', 'stopped')) OR ("slots"."kind" = 'training' AND "slots"."state" IN ('idle', 'training', 'stopping', 'failed', 'stopped'))));--> statement-breakpoint
ALTER TABLE "fleets" ADD CONSTRAINT "fleets_probe_policy_limits" CHECK ((CASE WHEN jsonb_typeof("fleets"."policy" #> '{probe,prompt}') = 'string' THEN char_length("fleets"."policy" #>> '{probe,prompt}') <= 8192 ELSE TRUE END) AND (CASE WHEN jsonb_typeof("fleets"."policy" #> '{probe,maxTokens}') = 'number' THEN ("fleets"."policy" #>> '{probe,maxTokens}')::numeric <= 256 ELSE TRUE END));
