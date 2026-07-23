import { stringify } from "yaml";

import type { DomainLaunchSpec } from "./types.js";
import type { PlacementSpec } from "@haru/protocol";

/** Translate haru's provider-neutral placement into SkyPilot resources. */
export function placementToResources(
  placement: PlacementSpec,
  ports: readonly number[],
): Record<string, unknown> {
  return {
    cloud: placement.cloud,
    region: placement.region,
    accelerators: `${placement.accelerator}:${placement.acceleratorCount}`,
    use_spot: placement.useSpot,
    ...(ports.length > 0 && { ports: [...ports] }),
  };
}

/**
 * Render a SkyPilot task YAML for one GPU domain. Pure: no filesystem
 * or process access, which keeps the translation snapshot-testable.
 *
 * Serialized with the `yaml-1.1` schema on purpose: SkyPilot loads task
 * YAML with PyYAML, whose implicit resolvers are YAML 1.1, so a string
 * env value like `off`/`no`/`y` or a sexagesimal `12:34:56` would be
 * reparsed as a boolean/integer under the 1.2 core schema's plain
 * output. The 1.1 schema quotes exactly those ambiguous scalars while
 * leaving genuine booleans and multi-line block scalars untouched.
 */
export function renderSkyTaskYaml(spec: DomainLaunchSpec): string {
  const task: Record<string, unknown> = {
    name: spec.clusterName,
    resources: placementToResources(spec.placement, spec.ports),
    ...(Object.keys(spec.envs).length > 0 && { envs: { ...spec.envs } }),
    setup: spec.setup,
    run: spec.run,
  };
  return stringify(task, { schema: "yaml-1.1" });
}
