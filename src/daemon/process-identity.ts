/**
 * Operating-system identity for daemon-managed instance processes.
 *
 * A process identifier is not an identity because operating systems reuse
 * identifiers, so `security-operations.md` Section 7.4 forbids signalling a
 * recovered identifier before the live process is matched against a stored
 * identity. A probe therefore answers one of three things, and only an
 * `identity` observation whose token equals the durable record permits a
 * signal:
 *
 * - `absent`: the operating system reports that no process holds the
 *   identifier, which proves the recorded child is gone;
 * - `identity`: a process holds the identifier and the operating system
 *   supplied a token that survives identifier reuse; and
 * - `unprovable`: a process holds the identifier but this platform cannot
 *   supply such a token, so the record is stale and must never be signalled.
 */

import { readFileSync } from "node:fs";

/** Longest `/proc` file this module will read; these files are tiny. */
const MAX_PROC_FILE_BYTES = 8_192;

const BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type ProcessIdentityObservation =
  | { readonly kind: "identity"; readonly identityToken: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unprovable"; readonly reason: string };

export interface ProcessIdentityProbe {
  /** Observes the live process holding `pid`, if any. Never signals it. */
  observe(pid: number): Promise<ProcessIdentityObservation>;
}

export type ProcessIdentityErrorCode = "PROCESS_IDENTITY_PID_INVALID";

export class ProcessIdentityError extends Error {
  constructor(
    readonly code: ProcessIdentityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProcessIdentityError";
  }
}

export function assertSignallablePid(pid: unknown): asserts pid is number {
  // A non-positive value addresses a process group or the caller itself on
  // POSIX, so it is rejected before it can reach any signalling primitive.
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) {
    throw new ProcessIdentityError(
      "PROCESS_IDENTITY_PID_INVALID",
      "A process identifier must be a positive safe integer",
    );
  }
}

export type ProcessLiveness = "absent" | "present";

export interface ProcessLivenessOptions {
  /** Injectable for tests; defaults to the real zero-signal existence check. */
  readonly signal?: (pid: number, signal: 0) => void;
}

/**
 * Reports whether any process currently holds `pid`. Only `ESRCH` proves
 * absence; every other failure leaves the process possibly alive.
 */
export function observeProcessLiveness(
  pid: number,
  options: ProcessLivenessOptions = {},
): ProcessLiveness {
  assertSignallablePid(pid);
  const signal = options.signal ?? ((target: number) => process.kill(target, 0));
  try {
    signal(pid, 0);
    return "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "ESRCH"
      ? "absent"
      : "present";
  }
}

/**
 * Proves death only. A live process yields `unprovable`, which keeps the
 * no-signal rule intact on platforms without a readable identity token.
 */
export class PortableLivenessIdentityProbe implements ProcessIdentityProbe {
  readonly #reason: string;
  readonly #liveness: (pid: number) => ProcessLiveness;

  constructor(
    reason: string,
    options: ProcessLivenessOptions = {},
  ) {
    if (reason.length === 0) {
      throw new TypeError("An unprovable identity probe requires a reason");
    }
    this.#reason = reason;
    this.#liveness = (pid) => observeProcessLiveness(pid, options);
  }

  observe(pid: number): Promise<ProcessIdentityObservation> {
    assertSignallablePid(pid);
    if (this.#liveness(pid) === "absent") {
      return Promise.resolve({ kind: "absent" });
    }
    return Promise.resolve({ kind: "unprovable", reason: this.#reason });
  }
}

export interface LinuxProcIdentityProbeOptions extends ProcessLivenessOptions {
  /** Injectable `/proc` reader so the parser can be tested without Linux. */
  readonly readProcFile?: (path: string) => string;
}

/**
 * Derives an identity token from the Linux boot identifier and the process
 * start time in `/proc/<pid>/stat`. The pair survives identifier reuse: a
 * reused identifier has a later start time, and a reboot changes the boot
 * identifier.
 */
export class LinuxProcIdentityProbe implements ProcessIdentityProbe {
  readonly #readProcFile: (path: string) => string;
  readonly #liveness: (pid: number) => ProcessLiveness;

  constructor(options: LinuxProcIdentityProbeOptions = {}) {
    this.#readProcFile =
      options.readProcFile ??
      ((path) => readFileSync(path, { encoding: "utf8" }).slice(0, MAX_PROC_FILE_BYTES));
    this.#liveness = (pid) => observeProcessLiveness(pid, options);
  }

  observe(pid: number): Promise<ProcessIdentityObservation> {
    assertSignallablePid(pid);
    let bootId: string;
    try {
      bootId = this.#readProcFile("/proc/sys/kernel/random/boot_id").trim();
    } catch {
      return Promise.resolve({
        kind: "unprovable",
        reason: "linux-boot-id-unreadable",
      });
    }
    if (!BOOT_ID_PATTERN.test(bootId)) {
      return Promise.resolve({ kind: "unprovable", reason: "linux-boot-id-invalid" });
    }

    let stat: string;
    try {
      stat = this.#readProcFile(`/proc/${pid}/stat`);
    } catch (error) {
      // A missing entry is absence only when the identifier is also unused;
      // any other read failure leaves the process possibly alive.
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        return Promise.resolve(
          this.#liveness(pid) === "absent"
            ? { kind: "absent" }
            : { kind: "unprovable", reason: "linux-proc-stat-unreadable" },
        );
      }
      return Promise.resolve({
        kind: "unprovable",
        reason: "linux-proc-stat-unreadable",
      });
    }

    const startTime = parseProcStatStartTime(stat);
    if (startTime === undefined) {
      return Promise.resolve({ kind: "unprovable", reason: "linux-proc-stat-invalid" });
    }
    return Promise.resolve({
      kind: "identity",
      identityToken: `linux-proc/1:${bootId}:${startTime}`,
    });
  }
}

/**
 * Extracts field 22 (`starttime`) of `/proc/<pid>/stat`. The executable name
 * in field 2 may contain spaces and parentheses, so parsing resumes after its
 * final `)`.
 */
export function parseProcStatStartTime(stat: string): string | undefined {
  const commEnd = stat.lastIndexOf(")");
  if (commEnd < 0 || stat.indexOf("(") < 0 || stat.indexOf("(") > commEnd) return undefined;
  const fields = stat.slice(commEnd + 1).trim().split(/\s+/u);
  // `fields[0]` is field 3 (state), so field 22 lives at offset 19.
  const startTime = fields[19];
  if (startTime === undefined || !/^\d{1,20}$/u.test(startTime)) return undefined;
  return startTime;
}

/**
 * Returns the strongest identity probe this platform supports. Platforms
 * without a readable identity token still prove death, which is what restart
 * policy needs; they simply never authorize a signal to a recovered
 * identifier.
 */
export function createOsProcessIdentityProbe(
  platform: NodeJS.Platform = process.platform,
): ProcessIdentityProbe {
  if (platform === "linux") return new LinuxProcIdentityProbe();
  return new PortableLivenessIdentityProbe(`process-identity-unsupported-on-${platform}`);
}
