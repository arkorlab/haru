import type { TrainingRunState } from "@haru/protocol";

/** Minimal child-process surface, injectable for tests. */
export interface ChildHandle {
  pid: number | undefined;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "exit", listener: () => void): void;
}

export type SpawnFunction = (
  command: readonly string[],
  options: { checkpointDir: string },
) => ChildHandle;

/**
 * Supervises one preemptible LoRA training process.
 *
 * Stop semantics: SIGTERM first so the trainer can flush a checkpoint,
 * then SIGKILL after the grace period. Failover never waits for a
 * perfect checkpoint: the trainer is required to be resume-oriented,
 * and losing the tail of a run is an accepted cost of promotion speed.
 */
export class TrainingRun {
  private child: ChildHandle | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private stateValue: TrainingRunState = "idle";
  private readonly command: readonly string[];
  private readonly checkpointDirectory: string;
  private readonly spawnFunction: SpawnFunction;

  constructor(
    command: readonly string[],
    checkpointDirectory: string,
    spawnFunction: SpawnFunction,
  ) {
    this.command = command;
    this.checkpointDirectory = checkpointDirectory;
    this.spawnFunction = spawnFunction;
  }

  private onExit(child: ChildHandle): void {
    if (this.child !== child) {
      return;
    }
    if (this.killTimer !== null) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    this.child = null;
    this.stateValue = "idle";
  }

  get state(): TrainingRunState {
    return this.stateValue;
  }

  get pids(): number[] {
    return this.child?.pid === undefined ? [] : [this.child.pid];
  }

  /** Idempotent: starting a running (or stopping) run is a no-op. */
  start(): TrainingRunState {
    if (this.stateValue !== "idle") {
      return this.stateValue;
    }
    const child = this.spawnFunction(this.command, {
      checkpointDir: this.checkpointDirectory,
    });
    this.child = child;
    this.stateValue = "running";
    child.once("exit", () => {
      this.onExit(child);
    });
    return this.stateValue;
  }

  /** Idempotent: stopping an idle run is a no-op. Repeated stops while
   * stopping keep the earlier (shorter) kill deadline. */
  stop(graceMs: number): TrainingRunState {
    if (this.stateValue !== "running" || this.child === null) {
      return this.stateValue;
    }
    const child = this.child;
    this.stateValue = "stopping";
    child.kill("SIGTERM");
    this.killTimer = setTimeout(() => {
      // Grace expired: force kill. Checkpoint recovery picks up from
      // the last flushed checkpoint.
      child.kill("SIGKILL");
    }, graceMs);
    return this.stateValue;
  }
}
