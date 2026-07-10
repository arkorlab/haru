import { z } from "zod";

import type { PlacementSpec } from "@haru/protocol";

/**
 * Everything needed to launch one GPU domain as a SkyPilot cluster.
 * The placement constraints (cloud, region, accelerator, spot) come
 * from the haru domain row; haru never calls cloud APIs directly.
 */
export interface DomainLaunchSpec {
  /** SkyPilot cluster name, e.g. haru-<fleetSlug>-<domainSlug>. */
  clusterName: string;
  placement: PlacementSpec;
  /** Ports to open (supervisor + serving ports). */
  ports: readonly number[];
  /** Environment for the task (supervisor token, slot config, ...). */
  envs: Readonly<Record<string, string>>;
  /** Setup script (install vLLM, the supervisor, the trainer). */
  setup: string;
  /** Run command (start the supervisor). */
  run: string;
}

/** Tolerant view over `sky status --output json` output. */
export const skyClusterStatusSchema = z.looseObject({
  name: z.string(),
  status: z.string(),
});
export type SkyClusterStatus = z.infer<typeof skyClusterStatusSchema>;

export interface SkypilotDriver {
  launchDomain(spec: DomainLaunchSpec): Promise<{ clusterName: string }>;
  getDomainStatus(clusterName: string): Promise<SkyClusterStatus | null>;
  /** Stop instances but keep the cluster definition (sky stop). */
  stopDomain(clusterName: string): Promise<void>;
  /** Tear the cluster down entirely (sky down). */
  teardownDomain(clusterName: string): Promise<void>;
}
