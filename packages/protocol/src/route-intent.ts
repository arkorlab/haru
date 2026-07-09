import { z } from "zod";

import { slugSchema } from "./enums.js";
import { modelBindingSchema } from "./fleet.js";

/**
 * Provider-neutral routing target. Consumers (external routers, DNS
 * or proxy reconcilers) decide how to act on it; haru never contains
 * router-vendor-specific logic.
 */
export const routeTargetSchema = z.object({
  domainId: z.uuid(),
  domainSlug: slugSchema,
  /** OpenAI-compatible base URL for the domain, null if not yet known. */
  endpointUrl: z.url().nullable(),
  /**
   * Whether traffic may be routed to this target right now. For the
   * active target: domain is ready/degraded and every inference slot
   * is serving. Standby targets are never eligible in this slice.
   */
  eligible: z.boolean(),
  /** Relative traffic weight (active: 1, standby: 0 in this slice). */
  weight: z.number().min(0).max(1),
  models: z.array(modelBindingSchema),
});
export type RouteTarget = z.infer<typeof routeTargetSchema>;

export const routeIntentSchema = z.object({
  fleetId: z.uuid(),
  fleetSlug: slugSchema,
  /**
   * Monotonic revision, bumped on every active-pointer move. Consumers
   * can cache-bust or order updates on it.
   */
  revision: z.number().int().positive(),
  generatedAt: z.iso.datetime({ offset: true }),
  active: routeTargetSchema.nullable(),
  standby: routeTargetSchema.nullable(),
});
export type RouteIntent = z.infer<typeof routeIntentSchema>;
