import { z } from "zod";

import { domainProviderSchema, slugSchema } from "./enums.js";
import { inferenceSlotSpecSchema, trainingSlotSpecSchema } from "./fleet.js";
import { placementSpecSchema } from "./placement.js";
import { fleetPolicySchema } from "./policy.js";

/**
 * Declarative fleet layout, used to seed or reconcile a fleet into the
 * state store. This is pure data: model names, serving URLs, GPU
 * assignments and placement all come from the operator's layout file,
 * never from haru itself.
 */
export const slotLayoutSchema = z.discriminatedUnion("kind", [
  inferenceSlotSpecSchema.extend({
    gpuIndex: z.number().int().nonnegative(),
  }),
  trainingSlotSpecSchema.extend({
    gpuIndex: z.number().int().nonnegative(),
  }),
]);
export type SlotLayout = z.infer<typeof slotLayoutSchema>;

export const domainLayoutSchema = z.object({
  slug: slugSchema,
  provider: domainProviderSchema.default("static"),
  placement: placementSpecSchema,
  supervisorUrl: z.url().optional(),
  servingBaseUrl: z.url().optional(),
  slots: z.array(slotLayoutSchema).min(1),
});
export type DomainLayout = z.infer<typeof domainLayoutSchema>;

export const fleetLayoutSchema = z
  .object({
    slug: slugSchema,
    displayName: z.string().min(1).optional(),
    /** Slug of the domain that starts active; must name a domain below. */
    activeDomainSlug: slugSchema.optional(),
    /** Partial policy; unset fields resolve to defaults on read. */
    policy: fleetPolicySchema.partial().optional(),
    domains: z.array(domainLayoutSchema).min(1),
  })
  .refine(
    (layout) =>
      layout.activeDomainSlug === undefined ||
      layout.domains.some((d) => d.slug === layout.activeDomainSlug),
    {
      message: "activeDomainSlug must reference one of the domains",
      path: ["activeDomainSlug"],
    },
  )
  .refine(
    (layout) =>
      new Set(layout.domains.map((d) => d.slug)).size === layout.domains.length,
    {
      message: "domain slugs must be unique within a fleet",
      path: ["domains"],
    },
  )
  // The DB enforces UNIQUE(domain, gpuIndex, kind) with ON CONFLICT DO
  // NOTHING on insert, which would silently drop a duplicate slot
  // entry; reject it at parse time instead.
  .refine(
    (layout) =>
      layout.domains.every((domain) => {
        const keys = domain.slots.map(
          (slot) => `${slot.gpuIndex}:${slot.kind}`,
        );
        return new Set(keys).size === keys.length;
      }),
    {
      message: "each (gpuIndex, kind) pair must be unique within a domain",
      path: ["domains"],
    },
  );
export type FleetLayout = z.infer<typeof fleetLayoutSchema>;
