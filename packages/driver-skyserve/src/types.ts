import { z } from "zod";

import type { PlacementSpec } from "@haru/protocol";

/**
 * Everything needed to run one serving-oriented deployment through
 * SkyServe (SkyPilot's serving layer): replica management, recovery
 * and load balancing are SkyServe's job, not haru's.
 */
export interface ServiceLaunchSpec {
  serviceName: string;
  placement: PlacementSpec;
  /** Port the OpenAI-compatible server listens on inside the replica. */
  servicePort: number;
  /** Readiness probe path, e.g. /healthz or /v1/models. */
  readinessProbePath: string;
  replicas: number;
  envs: Readonly<Record<string, string>>;
  setup: string;
  run: string;
}

/** Tolerant view over `sky serve status --format json` output. */
export const skyServiceStatusSchema = z.looseObject({
  name: z.string(),
  status: z.string(),
});
export type SkyServiceStatus = z.infer<typeof skyServiceStatusSchema>;

export interface SkyserveDriver {
  launchService(spec: ServiceLaunchSpec): Promise<{ serviceName: string }>;
  getServiceStatus(serviceName: string): Promise<SkyServiceStatus | null>;
  teardownService(serviceName: string): Promise<void>;
}
