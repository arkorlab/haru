ALTER TABLE "domains" ADD CONSTRAINT "domains_slug_valid" CHECK ("domains"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("domains"."slug") <= 63);--> statement-breakpoint
ALTER TABLE "fleets" ADD CONSTRAINT "fleets_slug_valid" CHECK ("fleets"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("fleets"."slug") <= 63);--> statement-breakpoint
ALTER TABLE "fleets" ADD CONSTRAINT "fleets_route_revision_positive" CHECK ("fleets"."route_revision" > 0);--> statement-breakpoint
ALTER TABLE "slots" ADD CONSTRAINT "slots_gpu_index_nonnegative" CHECK ("slots"."gpu_index" >= 0);