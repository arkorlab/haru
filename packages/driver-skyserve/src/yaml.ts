import { placementToResources } from "@haru/driver-skypilot";
import { stringify } from "yaml";

import type { ServiceLaunchSpec } from "./types.js";

/**
 * Render a SkyServe service YAML. Same placement translation as the
 * SkyPilot task renderer, plus the `service` block that SkyServe uses
 * for readiness probing and replica management.
 */
export function renderSkyServiceYaml(spec: ServiceLaunchSpec): string {
  const service: Record<string, unknown> = {
    name: spec.serviceName,
    service: {
      readiness_probe: { path: spec.readinessProbePath },
      replicas: spec.replicas,
    },
    resources: {
      ...placementToResources(spec.placement, []),
      ports: [spec.servicePort],
    },
    ...(Object.keys(spec.envs).length > 0 && { envs: { ...spec.envs } }),
    setup: spec.setup,
    run: spec.run,
  };
  return stringify(service);
}
