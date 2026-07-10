import { z } from "zod";

import { slugSchema } from "./enums.js";
import { httpUrlSchema, modelBindingSchema } from "./fleet.js";

/**
 * One routed model on a target: the model binding (routing key +
 * serving URL, including its lowercase-name refine) plus whether
 * traffic for it can be served right now (its slot is serving on a
 * routable domain). Per-model eligibility lets a partially degraded
 * domain keep serving its healthy models, matching the chat proxy.
 */
export const routeModelSchema = modelBindingSchema.extend({
  eligible: z.boolean(),
});
export type RouteModel = z.infer<typeof routeModelSchema>;

/**
 * Provider-neutral routing target. Consumers (external routers, DNS
 * or proxy reconcilers) decide how to act on it; haru never contains
 * router-vendor-specific logic.
 */
export const routeTargetSchema = z.object({
  domainId: z.uuid(),
  domainSlug: slugSchema,
  /** OpenAI-compatible base URL for the domain, null if not yet known. */
  endpointUrl: httpUrlSchema.nullable(),
  /**
   * Whether traffic may be routed to this target right now: active
   * role, an endpoint URL, and AT LEAST ONE eligible model. All-or-
   * nothing consumers can require `models.every((m) => m.eligible)`
   * themselves. Standby targets are never eligible in this slice.
   */
  eligible: z.boolean(),
  /** Relative traffic weight (active: 1, standby: 0 in this slice). */
  weight: z.number().min(0).max(1),
  models: z.array(routeModelSchema),
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
  /**
   * Every non-active domain, ranked by promotion preference (state,
   * then heartbeat freshness, then slug). Auto-failover promotes the
   * first promotable entry, so consumers see the same ordering the
   * reconciler acts on.
   */
  standbys: z.array(routeTargetSchema),
});
export type RouteIntent = z.infer<typeof routeIntentSchema>;
