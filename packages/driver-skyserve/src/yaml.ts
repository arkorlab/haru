import { placementToResources, stringifySkyYaml } from "@haru/driver-skypilot";

import type { ServiceLaunchSpec } from "./types.js";

/**
 * Render a SkyServe service YAML. Same placement translation as the
 * SkyPilot task renderer, plus the `service` block that SkyServe uses
 * for readiness probing and replica management. Serialized through the
 * shared `stringifySkyYaml` so the YAML-1.1 schema choice is not
 * duplicated here.
 */
export function renderSkyServiceYaml(spec: ServiceLaunchSpec): string {
  const service: Record<string, unknown> = {
    name: spec.serviceName,
    service: {
      readiness_probe: { path: spec.readinessProbePath },
      replicas: spec.replicas,
    },
    resources: {
      ...placementToResources(spec.placement, [spec.servicePort]),
    },
    ...(Object.keys(spec.envs).length > 0 && { envs: { ...spec.envs } }),
    setup: spec.setup,
    run: spec.run,
  };
  return stringifySkyYaml(service);
}
