/**
 * The deterministic interruption barrier of the fixed interruption matrix.
 *
 * The protocol requires that "a barrier confirms the exact interruption point
 * before termination". Sleeping for a guessed interval does not confirm
 * anything: it only makes an unconfirmed guess more likely to be right. This
 * barrier confirms the point instead.
 *
 * How the confirmation works:
 *
 *   1. Every durable boundary the stand-in reaches is appended to one trace
 *      file, written and synchronised before the boundary's own work is
 *      allowed to proceed. The trace is therefore an ordered, durable record
 *      of exactly how far this Core invocation got.
 *   2. At the one boundary this case names, the barrier writes an arrival file
 *      by the atomic write-and-rename that the rest of Core uses, so an
 *      external observer either sees no file or sees a complete one.
 *   3. It then blocks the only thread this process has, forever, using
 *      `Atomics.wait` on a value that is never changed. Nothing else in the
 *      process can run: no timer, no socket read, no pending promise. The
 *      program is stopped at the boundary, not merely slowed near it.
 *
 * The observer therefore learns "Core is at this exact point and has performed
 * nothing after it" from the existence of the arrival file, and can send
 * `SIGKILL` knowing precisely what was and was not durable. The signal goes to
 * the service's main process, which is this process.
 *
 * A barrier that blocks forever is safe here because the service manager owns
 * this process: the case terminates it, and `KillMode=control-group` removes
 * anything it created.
 */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Timing halves of one boundary: before it has happened, and after it has. */
export type BarrierTiming = "before" | "after";

/** `M06-before`, `M08.completion-after`, and so on. */
export type BarrierKey = string;

export function barrierKey(boundary: string, timing: BarrierTiming): BarrierKey {
  return `${boundary}-${timing}`;
}

function fsyncDirectory(path: string): void {
  // Mirrors the shipped Core-state writer: a directory descriptor cannot be
  // synchronised on Windows, where this experiment never runs.
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Writes a file the observer may only ever see complete. */
function atomicWrite(path: string, contents: string): void {
  const temporaryPath = `${path}.tmp`;
  const descriptor = openSync(temporaryPath, "w");
  try {
    writeSync(descriptor, contents);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, path);
  fsyncDirectory(dirname(path));
}

export interface BarrierOptions {
  readonly directory: string;
  /** The one boundary this case interrupts, or `null` for an uninterrupted run. */
  readonly target: BarrierKey | null;
  readonly invocation: number;
  /** Extra facts the arrival file carries, for the observer's snapshot. */
  readonly describe?: () => Record<string, unknown>;
}

export class Barrier {
  readonly #directory: string;
  readonly #target: BarrierKey | null;
  readonly #tracePath: string;
  readonly #arrivalPath: string;
  readonly #describe: (() => Record<string, unknown>) | undefined;
  #sequence = 0;
  #reachedTarget = false;

  constructor(options: BarrierOptions) {
    this.#directory = options.directory;
    this.#target = options.target;
    this.#describe = options.describe;
    mkdirSync(this.#directory, { recursive: true });
    this.#tracePath = join(this.#directory, `trace-${options.invocation}`);
    this.#arrivalPath = join(this.#directory, "arrived");
    if (options.invocation === 1) writeFileSync(this.#tracePath, "", { flag: "a" });
  }

  get target(): BarrierKey | null {
    return this.#target;
  }

  get reachedTarget(): boolean {
    return this.#reachedTarget;
  }

  /** Records one point of the run without any possibility of interruption. */
  note(key: string, detail?: string): void {
    this.#appendTrace(key, detail);
  }

  /**
   * Reaches one durable boundary. Returns normally unless this is the boundary
   * the case names, in which case the process stops here permanently.
   */
  reach(key: BarrierKey, detail?: string): void {
    this.#appendTrace(key, detail);
    if (this.#target === null || key !== this.#target) return;
    this.#reachedTarget = true;
    const arrival = {
      barrier: key,
      pid: process.pid,
      at: new Date().toISOString(),
      sequence: this.#sequence,
      ...(this.#describe?.() ?? {}),
    };
    atomicWrite(this.#arrivalPath, `${JSON.stringify(arrival)}\n`);
    // Stop. The only thread this process has now waits on a value nothing
    // writes, so no timer, socket, or promise continuation can run. The case
    // terminates the process from outside.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    // Unreachable: `Atomics.wait` on an unchanged value never returns.
    throw new Error("the interruption barrier returned, which cannot happen");
  }

  #appendTrace(key: string, detail?: string): void {
    this.#sequence += 1;
    const line = `${new Date().toISOString()} ${String(this.#sequence).padStart(4, "0")} ${key}${
      detail === undefined ? "" : ` ${detail}`
    }\n`;
    const descriptor = openSync(this.#tracePath, "a");
    try {
      writeSync(descriptor, line);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}
