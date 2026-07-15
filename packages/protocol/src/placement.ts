import { z } from "zod";

/**
 * Provider-neutral placement constraints for a domain. haru never
 * talks to cloud APIs directly: drivers translate this spec into
 * SkyPilot / SkyServe resource configuration, and SkyPilot owns the
 * actual multi-cloud provisioning.
 *
 * `accelerator` is the SkyPilot accelerator name (see `sky show-gpus`).
 * It is deliberately required with no default: haru is a library and
 * does not hard-code any particular GPU model.
 *
 * Strict: operator-authored config, so a misspelled key (e.g.
 * `acceleratorCount` -> `acceleratorCnt`) fails at parse time instead
 * of silently reverting to the default.
 */
export const placementSpecSchema = z.strictObject({
  cloud: z.enum(["aws", "gcp"]),
  region: z.string().min(1),
  accelerator: z.string().min(1),
  acceleratorCount: z.number().int().positive().default(1),
  useSpot: z.boolean().default(false),
});
export type PlacementSpec = z.infer<typeof placementSpecSchema>;
