import { z } from "zod";

import { domainProviderSchema, slugSchema } from "./enums.js";
import {
  httpUrlSchema,
  inferenceSlotSpecSchema,
  trainingSlotSpecSchema,
} from "./fleet.js";
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

// Strict: operator-authored config. A misspelled key (e.g.
// `supervisorUrl` -> `superviorUrl`) must fail at parse time rather
// than silently leave the domain with a null control URL.
export const domainLayoutSchema = z.strictObject({
  slug: slugSchema,
  provider: domainProviderSchema.default("static"),
  placement: placementSpecSchema,
  supervisorUrl: httpUrlSchema.optional(),
  servingBaseUrl: httpUrlSchema.optional(),
  slots: z.array(slotLayoutSchema).min(1),
});
export type DomainLayout = z.infer<typeof domainLayoutSchema>;

export const fleetLayoutSchema = z
  // Strict: the top-level operator layout rejects unknown keys so a
  // typo'd field is a config-time error, not a silently ignored one.
  .strictObject({
    /** Optional pointer to the bundled JSON Schema, so an editor can
     * validate / autocomplete the layout. Ignored by the loader. */
    $schema: z.string().optional(),
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
  // The promote path already rejects training-only targets (nothing to
  // serve); a seeded initial active must meet the same bar or the
  // fleet starts ready-but-unservable.
  .refine(
    (layout) => {
      if (layout.activeDomainSlug === undefined) {
        return true;
      }
      const active = layout.domains.find(
        (d) => d.slug === layout.activeDomainSlug,
      );
      // A dangling slug is the previous refinement's error, not this
      // one's.
      return (
        active === undefined ||
        active.slots.some((slot) => slot.kind === "inference")
      );
    },
    {
      message:
        "the active domain must bind at least one inference model (a training-only active cannot serve)",
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
  )
  // `model` is the routing key the chat proxy matches exactly; a name
  // bound twice within one domain would silently send all of that
  // model's traffic to whichever slot happens to sort first.
  .refine(
    (layout) =>
      layout.domains.every((domain) => {
        const names = domain.slots.flatMap((slot) =>
          slot.kind === "inference" ? slot.models.map((m) => m.name) : [],
        );
        return new Set(names).size === names.length;
      }),
    {
      message: "model binding names must be unique within a domain",
      path: ["domains"],
    },
  );
export type FleetLayout = z.infer<typeof fleetLayoutSchema>;
