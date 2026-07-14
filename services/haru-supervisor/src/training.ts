import type { TrainingRunState } from "@haru/protocol";

/** Minimal child-process surface, injectable for tests. */
export interface ChildHandle {
  pid: number | undefined;
  kill(signal: NodeJS.Signals): boolean;
  /**
   * `error` fires on spawn failure (ENOENT/EACCES), in which case
   * `exit` never fires; both must be wired or a spawn failure raises
   * an unhandled 'error' event that kills the whole process.
   */
  once(event: "exit" | "error", listener: () => void): void;
}

export type SpawnFunction = (
  command: readonly string[],
  options: {
    checkpointDir: string;
    /** Which physical GPU this slot owns. The trainer needs it to pin
     * itself (CUDA_VISIBLE_DEVICES): without it a slot on GPU 1 would
     * default to cuda:0, which on a standby domain is an INFERENCE GPU
     * with a sleeping vLLM on it - the training process would fight the
     * wake path for VRAM and wedge the next promotion. */
    gpuIndex: number;
  },
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
  private killDeadlineMs: number | null = null;
  private stateValue: TrainingRunState = "idle";
  private readonly command: readonly string[];
  private readonly checkpointDirectory: string;
  private readonly gpuIndex: number;
  private readonly spawnFunction: SpawnFunction;

  constructor(
    command: readonly string[],
    checkpointDirectory: string,
    gpuIndex: number,
    spawnFunction: SpawnFunction,
  ) {
    this.command = command;
    this.checkpointDirectory = checkpointDirectory;
    this.gpuIndex = gpuIndex;
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
    this.killDeadlineMs = null;
    this.child = null;
    this.stateValue = "idle";
  }

  private scheduleKill(child: ChildHandle, graceMs: number): void {
    if (this.killTimer !== null) {
      clearTimeout(this.killTimer);
    }
    this.killDeadlineMs = Date.now() + graceMs;
    this.killTimer = setTimeout(() => {
      // Grace expired: force kill. Checkpoint recovery picks up from
      // the last flushed checkpoint.
      child.kill("SIGKILL");
    }, graceMs);
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
      gpuIndex: this.gpuIndex,
    });
    this.child = child;
    this.stateValue = "running";
    child.once("exit", () => {
      this.onExit(child);
    });
    // Spawn failures emit 'error' instead of 'exit'; treat them as an
    // immediate exit so the run returns to idle instead of reporting
    // "running" forever with no process behind it.
    child.once("error", () => {
      this.onExit(child);
    });
    return this.stateValue;
  }

  /** Idempotent: stopping an idle run is a no-op. Repeated stops while
   * stopping keep the EARLIEST kill deadline: a failover stop with a
   * short grace must be able to tighten a longer manual stop already
   * in flight (never loosen it - promotion speed wins). */
  stop(graceMs: number): TrainingRunState {
    if (this.stateValue === "stopping" && this.child !== null) {
      const requestedDeadlineMs = Date.now() + graceMs;
      if (
        this.killDeadlineMs === null ||
        requestedDeadlineMs < this.killDeadlineMs
      ) {
        this.scheduleKill(this.child, graceMs);
      }
      return this.stateValue;
    }
    if (this.stateValue !== "running" || this.child === null) {
      return this.stateValue;
    }
    const child = this.child;
    this.stateValue = "stopping";
    child.kill("SIGTERM");
    this.scheduleKill(child, graceMs);
    return this.stateValue;
  }
}
