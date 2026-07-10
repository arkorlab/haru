import { readFileSync } from "node:fs";

import { supervisorConfigSchema, type SupervisorConfig } from "@haru/protocol";

/**
 * Load the slot layout from HARU_SUPERVISOR_CONFIG. The value is
 * either inline JSON (starts with "{") or a path to a JSON file.
 */
export function loadSupervisorConfig(value: string): SupervisorConfig {
  const raw = value.trimStart().startsWith("{")
    ? value
    : readFileSync(value, "utf8");
  return supervisorConfigSchema.parse(JSON.parse(raw));
}
