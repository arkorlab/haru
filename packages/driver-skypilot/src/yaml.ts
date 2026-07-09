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
 */
export function renderSkyTaskYaml(spec: DomainLaunchSpec): string {
  const task: Record<string, unknown> = {
    name: spec.clusterName,
    resources: placementToResources(spec.placement, spec.ports),
    ...(Object.keys(spec.envs).length > 0 && { envs: { ...spec.envs } }),
    setup: spec.setup,
    run: spec.run,
  };
  return stringify(task);
}
