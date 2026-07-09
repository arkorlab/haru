import { domainStateSchema, type DomainState } from "@haru/protocol";
import { describe, expect, it } from "vitest";

import {
  assertDomainTransition,
  canTransitionDomain,
  InvalidTransitionError,
} from "./domain-state.js";

const ALL: readonly DomainState[] = domainStateSchema.options;

/** The full allowed-edge set, asserted exhaustively below. */
const ALLOWED: ReadonlySet<string> = new Set([
  "provisioning>ready",
  "provisioning>failed",
  "provisioning>stopping",
  "ready>degraded",
  "ready>failed",
  "ready>stopping",
  "degraded>ready",
  "degraded>failed",
  "degraded>stopping",
  "failed>provisioning",
  "failed>stopping",
  "stopping>stopped",
  "stopped>provisioning",
]);

describe("domain state machine", () => {
  it("allows exactly the documented edges (exhaustive)", () => {
    for (const from of ALL) {
      for (const to of ALL) {
        expect(canTransitionDomain(from, to), `${from} -> ${to}`).toBe(
          ALLOWED.has(`${from}>${to}`),
        );
      }
    }
  });

  it("never allows a self-transition", () => {
    for (const state of ALL) {
      expect(canTransitionDomain(state, state)).toBe(false);
    }
  });

  it("assertDomainTransition throws a typed error on bad edges", () => {
    expect(() => assertDomainTransition("stopped", "ready")).toThrow(
      InvalidTransitionError,
    );
    expect(() => assertDomainTransition("ready", "degraded")).not.toThrow();
  });
});
