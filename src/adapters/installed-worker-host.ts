/**
 * Installed worker-host adapter: the Host-owned production composition
 * owner between the Runtime authority storage repository and the installed
 * `worker_host` process.
 *
 * Responsibilities (and nothing more):
 * - project the durable Worker-start premise through the already-open
 *   repository (`installWorkerStartPremise`) BEFORE any spawn; a conflicting
 *   or refused projection spawns nothing;
 * - resolve the installed `worker_host` binary from the fixed installed-
 *   package layout (never from PATH, environment, cwd, or caller input);
 * - spawn through an injected process boundary with argv exactly
 *   `[database.path, premise.extensionAlias, premise.serverId]` and piped
 *   stdio; the caller cannot supply a command, endpoint, digest override,
 *   readiness result, or transport observation;
 * - own the framed control channel: validate the child's first frame is
 *   exactly the frozen `started` event for the requested server, answer one
 *   bounded `status` request pre-EOF, and terminate/reap on stop or failure.
 *
 * Framing reuses `FramedJsonChannel` (4-byte big-endian length prefix,
 * bounded frames); this module introduces no second framing convention.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, lstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  InstallWorkerStartPremiseInput,
  RuntimeAuthorityDatabase,
} from "./storage/runtime-authority-database.js";
import { FramedJsonChannel } from "../core/framed-json-channel.js";
import type { JsonValue } from "../core/canonical-json.js";

/** Frozen control-frame cap shared with the Rust binary's `FrameLimits`. */
const CONTROL_MAX_FRAME_BYTES = 262_144;

/**
 * Reviewed-build digest of the installed `worker_host` release binary.
 *
 * Reproducibility experiment (pinned toolchain, two clean `cargo build
 * --locked --release -p dolly-worker --bin worker_host` runs in separate
 * external CARGO_TARGET_DIRs): both artifacts hashed identically, so the
 * digest pins build provenance, not a machine-specific artifact.
 * Build-time enforcement lives in scripts/build.mjs; this runtime check
 * refuses a substituted binary before spawn.
 */
export const REVIEWED_WORKER_HOST_DIGEST =
  "sha256:ced65b28f7bacbdf233c5f712c8ab68a0e462b640d1df538d1def27aa40211ba";
/** Bounded diagnostics: retain at most this many stderr bytes. */
const STDERR_TAIL_BYTES = 8192;
/** Deadline for the mandatory first `started` frame. */
const STARTED_TIMEOUT_MS = 10_000;
/** Deadline for one bounded `status` reply. */
const STATUS_TIMEOUT_MS = 10_000;

export class InstalledWorkerHostError extends Error {
  constructor(
    readonly code:
      | "WORKER_HOST_BINARY_ABSENT"
      | "WORKER_PREMISE_REFUSED"
      | "WORKER_START_INVALID"
      | "WORKER_START_TIMEOUT",
    message: string,
  ) {
    super(message);
    this.name = "InstalledWorkerHostError";
  }
}

/** Shape of the process-boundary injection (tests inject a fake child). */
export interface InstalledWorkerHostSpawnOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdio: ["pipe", "pipe", "pipe"];
  readonly shell: false;
  readonly detached: false;
  readonly windowsHide: true;
  readonly env: Record<string, never>;
}

export interface InstalledWorkerHostHandle {
  readonly pid: number;
  /** One bounded framed request; resolves on the exact `status` reply. */
  status(): Promise<{ v: number; event: string; state: string; server_id: string }>;
  /** Idempotent stop: send stop, await exact stopped, await natural exit. */
  stop(): Promise<void>;
}

export interface LaunchInstalledWorkerHostOptions {
  /** Already-open Host-owned authority repository (never spawned over). */
  database: RuntimeAuthorityDatabase;
  /** The single closed projection input for the requested identity pair. */
  premise: InstallWorkerStartPremiseInput;
  /** Process-boundary injection for deterministic tests only. */
  spawn?: (
    command: string,
    args: readonly string[],
    options: InstalledWorkerHostSpawnOptions,
  ) => ChildProcess;
}

/**
 * Resolve the installed binary at the canonical `<packageRoot>/dist/bin/
 * worker_host` location. The module-layout check is exact, not a candidate
 * search:
 * - source layout  `/pkg/src/adapters/*.ts` -> `../../dist/bin/worker_host`
 * - built layout   `/pkg/dist/src/adapters/*.js` -> `../../../dist/bin/worker_host`
 * Any other module layout fails closed. Never PATH, environment, cwd, or a
 * caller-supplied executable.
 *
 * Returns the resolved command AND the canonical package root so install
 * safety can verify every fixed-layout component, not just the leaf.
 */
function resolveInstalledWorkerHostLayout(): {
  packageRoot: string;
  command: string;
} {
  const adapterDirUrl = new URL(".", import.meta.url);
  const inSourceLayout =
    adapterDirUrl.pathname.includes("/src/adapters/") &&
    !adapterDirUrl.pathname.includes("/dist/");
  let adapterDirToPackageRoot: string;
  if (inSourceLayout) {
    adapterDirToPackageRoot = "../..";
  } else if (adapterDirUrl.pathname.includes("/dist/src/adapters/")) {
    adapterDirToPackageRoot = "../../..";
  } else {
    throw new InstalledWorkerHostError(
      "WORKER_HOST_BINARY_ABSENT",
      `unrecognized module layout for worker_host resolution: ${adapterDirUrl.pathname}`,
    );
  }
  const packageRoot = fileURLToPath(
    new URL(`${adapterDirToPackageRoot}/`, import.meta.url),
  );
  const command = join(packageRoot, "dist", "bin", "worker_host");
  return { packageRoot, command };
}

/**
 * Install safety over EVERY fixed-layout component (packageRoot, dist, bin,
 * leaf), not only the leaf: each must exist via lstat as an ordinary
 * non-symlink directory/file, the leaf must carry an executable bit, no
 * component may be group/world writable, and every component owner must be
 * the current effective uid (or root).
 */
export interface WorkerHostInstallVerifier {
  assertInstallSafety(packageRoot: string, command: string): void;
  verifyDigest(command: string, reviewedDigest: string): void;
}

const nodeInstallVerifier: WorkerHostInstallVerifier = {
  assertInstallSafety,
  verifyDigest(command, reviewedDigest) {
    let actualDigest: string;
    try {
      actualDigest = `sha256:${createHash("sha256")
        .update(readFileSync(command))
        .digest("hex")}`;
    } catch (cause) {
      throw new InstalledWorkerHostError(
        "WORKER_HOST_BINARY_ABSENT",
        `installed worker_host could not be read for provenance: ${command}: ${String(cause)}`,
      );
    }
    if (actualDigest !== reviewedDigest) {
      throw new InstalledWorkerHostError(
        "WORKER_HOST_BINARY_ABSENT",
        `installed worker_host digest ${actualDigest} does not match the reviewed build`,
      );
    }
  },
};

/**
 * Active verifier. Production always uses the node implementation below;
 * conformance tests may substitute a deterministic verifier through
 * `setWorkerHostInstallVerifierForTests`. This module is not exported from
 * any product entry point, so the seam is unreachable in production while
 * the public migration guard remains unconditional.
 */
let activeInstallVerifier: WorkerHostInstallVerifier = nodeInstallVerifier;

/**
 * Test-only seam to replace the fixed-layout/digest verification. Returns a
 * restore function; tests must restore before finishing.
 */
export function setWorkerHostInstallVerifierForTests(
  verifier: WorkerHostInstallVerifier,
): () => void {
  const previous = activeInstallVerifier;
  activeInstallVerifier = verifier;
  return () => {
    activeInstallVerifier = previous;
  };
}

function assertInstallSafety(packageRoot: string, command: string): void {
  const components: Array<{ path: string; kind: "dir" | "file" }> = [
    { path: packageRoot, kind: "dir" },
    { path: join(packageRoot, "dist"), kind: "dir" },
    { path: join(packageRoot, "dist", "bin"), kind: "dir" },
    { path: command, kind: "file" },
  ];
  for (const { path, kind } of components) {
    let metadata;
    try {
      metadata = lstatSync(path);
    } catch (cause) {
      throw new InstalledWorkerHostError(
        "WORKER_HOST_BINARY_ABSENT",
        `missing worker_host layout component ${path}: ${String(cause)}`,
      );
    }
    if (metadata.isSymbolicLink()) {
      throw new InstalledWorkerHostError(
        "WORKER_HOST_BINARY_ABSENT",
        `worker_host layout component ${path} is a symlink`,
      );
    }
    const wantedKind = kind === "dir" ? metadata.isDirectory() : metadata.isFile();
    if (!wantedKind) {
      throw new InstalledWorkerHostError(
        "WORKER_HOST_BINARY_ABSENT",
        `worker_host layout component ${path} has the wrong file kind`,
      );
    }
    // Effective uid, not real uid: setuid-style launchers must not widen
    // what counts as a trusted owner.
    const euid =
      typeof process.geteuid === "function" ? process.geteuid() : undefined;
    const trustedOwner = euid !== undefined && metadata.uid === euid;
    if ((metadata.mode & 0o022) !== 0) {
      throw new InstalledWorkerHostError(
        "WORKER_HOST_BINARY_ABSENT",
        `worker_host layout component ${path} is group/world writable`,
      );
    }
    if (!trustedOwner && metadata.uid !== 0) {
      throw new InstalledWorkerHostError(
        "WORKER_HOST_BINARY_ABSENT",
        `worker_host layout component ${path} is owned by neither the effective user nor root`,
      );
    }
  }
  try {
    accessSync(command, constants.X_OK);
  } catch (cause) {
    throw new InstalledWorkerHostError(
      "WORKER_HOST_BINARY_ABSENT",
      `installed worker_host is not executable: ${command}: ${String(cause)}`,
    );
  }
}

/** Launch the installed worker-host for one admitted identity pair. */
export async function launchInstalledWorkerHost(
  options: LaunchInstalledWorkerHostOptions,
): Promise<InstalledWorkerHostHandle> {
  if (process.platform !== "linux") {
    // Refuse before ANY preflight, projection, binary check, or spawn: an
    // unsupported platform must observe zero durable or filesystem effects.
    throw new InstalledWorkerHostError(
      "WORKER_START_INVALID",
      "installed worker-host composition requires Linux",
    );
  }
  const { database, premise } = options;

  // 1. Resolve + validate the binary BEFORE premise projection (still project
  //    before spawn): layout, per-component lstat safety, digest provenance.
  const { packageRoot, command } = resolveInstalledWorkerHostLayout();
  activeInstallVerifier.assertInstallSafety(packageRoot, command);
  activeInstallVerifier.verifyDigest(command, REVIEWED_WORKER_HOST_DIGEST);

  // 2. Project the durable premise BEFORE any process exists. A conflict or
  //    refusal throws out of the repository and no spawn ever happens.
  database.installWorkerStartPremise(premise);

  // 3. Spawn with the frozen argv contract and no ambient authority.
  const doSpawn =
    options.spawn ??
    ((commandValue, argsValue, spawnOptions) =>
      spawn(commandValue, argsValue, spawnOptions));
  const child = doSpawn(command, [database.path, premise.extensionAlias, premise.serverId], {
    command,
    args: [database.path, premise.extensionAlias, premise.serverId],
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    detached: false,
    windowsHide: true,
    env: {},
  });

  // 4. Attach ONE error and ONE exit observer IMMEDIATELY after spawn —
  //    before any stdio validation — so ENOENT/launch failures and exits can
  //    never hang a launch. Node may emit error+close without exit (ENOENT);
  //    the close waiter resolves exactly once either way.
  let exited = false;
  let spawnError: Error | undefined;
  type PendingReply = {
    resolve: (message: JsonValue) => void;
    reject: (error: InstalledWorkerHostError) => void;
    deadline: NodeJS.Timeout | undefined;
  };
  let pendingReply: PendingReply | undefined;
  let stopped = false;
  let stopAcknowledged = false;

  function rejectPending(detail: string): void {
    const pending = pendingReply;
    pendingReply = undefined;
    if (pending) {
      if (pending.deadline) clearTimeout(pending.deadline);
      pending.reject(
        new InstalledWorkerHostError("WORKER_START_INVALID", stderrDiagnostics(detail)),
      );
    }
  }

  let closed = false;
  const closeWaiter: Promise<void> = new Promise<void>((resolveClose) => {
    child.once("close", (code, signal) => {
      closed = true;
      // ENOENT-style failures emit error+close without exit; close alone
      // settles the waiter so nothing waits forever. A pending reply at this
      // point was required and can never arrive.
      if (pendingReply !== undefined) {
        rejectPending("worker_host stdio closed before replying");
      }
      resolveClose();
    });
  });
  child.once("exit", (code, signal) => {
    exited = true;
    if (!closed) {
      rejectPending(
        `worker_host exited before replying (${code ?? signal ?? "unknown"})`,
      );
    }
  });
  child.once("error", (error) => {
    spawnError = error;
    rejectPending(`worker_host failed to launch: ${error.message}`);
  });

  // Missing piped stdio cannot run the protocol: terminate via the attached
  // waiter and refuse.
  if (!child.stdin || !child.stdout || !child.stderr) {
    if (!child.killed) child.kill();
    await closeWaiter;
    throw new InstalledWorkerHostError(
      "WORKER_START_INVALID",
      "worker_host must be spawned with piped stdin/stdout/stderr",
    );
  }

  // 5. Bounded stderr tail: retain exactly the last <= STDERR_TAIL_BYTES
  // bytes as a single buffer.
  let stderrTail: Buffer = Buffer.alloc(0);
  child.stderr.on("data", (chunk: Buffer) => {
    // Reduce an arbitrarily large chunk to its own last <=8192 bytes first,
    // then append only the required suffix of old-tail + reduced-chunk.
    // Every allocation stays within the bound.
    let piece = chunk.byteLength > STDERR_TAIL_BYTES
      ? chunk.subarray(chunk.byteLength - STDERR_TAIL_BYTES)
      : chunk;
    if (stderrTail.byteLength + piece.byteLength > STDERR_TAIL_BYTES) {
      const keepNew = Math.min(piece.byteLength, STDERR_TAIL_BYTES);
      const keepOld = STDERR_TAIL_BYTES - keepNew;
      piece = Buffer.concat([
        stderrTail.subarray(stderrTail.byteLength - keepOld),
        piece,
      ]);
    }
    stderrTail = piece;
  });

  /** Kill-and-reap: kills if needed and resolves on observed close/exit. */
  async function killAndReap(): Promise<void> {
    if (!closed && !child.killed) child.kill();
    await closeWaiter;
  }

  function stderrDiagnostics(detail: string): string {
    if (stderrTail.byteLength === 0) return detail;
    return `${detail} | worker_host stderr tail: ${stderrTail.toString("utf8").slice(-STDERR_TAIL_BYTES)}`;
  }

  /** Reject the current pending reply (if any) with a typed detail. */
  function failPending(detail: string): void {
    const pending = pendingReply;
    pendingReply = undefined;
    if (pending) {
      if (pending.deadline) clearTimeout(pending.deadline);
      pending.reject(
        new InstalledWorkerHostError("WORKER_START_INVALID", stderrDiagnostics(detail)),
      );
    }
  }

  // One serialized pending slot; a second concurrent request fails closed.
  // Startup gate registered BEFORE the channel attaches: a fast `started`
  // frame is consumed by this slot, not classified unsolicited.
  const startedGate = awaitReply(STARTED_TIMEOUT_MS);

  const channel = new FramedJsonChannel(child.stdout, child.stdin, {
    maxFrameBytes: CONTROL_MAX_FRAME_BYTES,
    onMessage: (message) => {
      const pending = pendingReply;
      if (!pending) {
        // Unsolicited frame is FATAL under the frozen protocol.
        failPending("unsolicited frame");
        void killAndReap();
        return;
      }
      pendingReply = undefined;
      if (pending.deadline) clearTimeout(pending.deadline);
      pending.resolve(message);
    },
    onError: (error) => {
      failPending(error.message);
      if (!stopAcknowledged && !child.killed) child.kill();
    },
    onEnd: () => {
      // Normal EOF is accepted only after an exact `stopped` acknowledgement;
      // every earlier end-of-stream is fatal.
      if (!(stopped && stopAcknowledged)) {
        failPending("worker_host closed stdout before stopping");
        if (!stopAcknowledged && !child.killed) child.kill();
      }
    },
  });

  /**
   * Await one framed reply. The pending slot MUST be registered by the
   * caller BEFORE the request is sent (fast-reply race safety). Timeout
   * records the typed failure, clears the slot, and terminates the child;
   * the caller awaits close/reap and propagates this original error.
   */
  function awaitReply(deadlineMs: number): Promise<JsonValue> {
    if (pendingReply !== undefined) {
      // Serialized queue should prevent this; fail closed if it ever happens.
      return Promise.reject(
        new InstalledWorkerHostError(
          "WORKER_START_INVALID",
          "concurrent request while another reply is pending",
        ),
      );
    }
    return new Promise<JsonValue>((_resolveReply, rejectReply) => {
      let settled = false;
      const deadline = setTimeout(() => {
        if (pendingReply?.resolve === onMessage) {
          pendingReply = undefined;
          if (!child.killed) child.kill();
        }
        settled = true;
        rejectReply(
          new InstalledWorkerHostError(
            "WORKER_START_TIMEOUT",
            `no framed reply within ${deadlineMs}ms`,
          ),
        );
      }, deadlineMs);
      const onMessage = (message: JsonValue): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        _resolveReply(message);
      };
      pendingReply = { resolve: onMessage, reject: rejectReply, deadline };
    });
  }

  /** Validate EXACT key set and values of one control frame. */
  function assertExactKeys(
    message: JsonValue,
    expected: Record<string, unknown>,
    context: string,
  ): void {
    const value = message as Record<string, unknown>;
    const keys = Object.keys(value).sort();
    const wanted = Object.keys(expected).sort();
    if (
      keys.length !== wanted.length ||
      keys.some((key, index) => key !== wanted[index])
    ) {
      throw new InstalledWorkerHostError(
        "WORKER_START_INVALID",
        `${context} frame has unexpected keys: ${JSON.stringify(value)}`,
      );
    }
    for (const [key, expectedValue] of Object.entries(expected)) {
      if (value[key] !== expectedValue) {
        throw new InstalledWorkerHostError(
          "WORKER_START_INVALID",
          `${context} frame field ${key} is ${JSON.stringify(value[key])}`,
        );
      }
    }
  }


  try {
    assertExactKeys(
      await startedGate,
      { v: 1, event: "started", server_id: premise.serverId },
      "started",
    );
  } catch (error) {
    if (!closed && !child.killed) child.kill();
    await closeWaiter;
    throw error;
  }
  if (spawnError) {
    throw new InstalledWorkerHostError(
      "WORKER_HOST_BINARY_ABSENT",
      `worker_host failed to launch: ${spawnError.message}`,
    );
  }

  // Serialized operation queue: one in-flight status/stop at a time.
  let operationChain: Promise<unknown> = Promise.resolve();
  let stopPromise: Promise<void> | undefined;

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = operationChain.then(operation, operation);
    operationChain = run.catch(() => {});
    return run;
  }

  const handle: InstalledWorkerHostHandle = {
    get pid() {
      return child.pid ?? 0;
    },
    status(): Promise<{
      v: number;
      event: string;
      state: string;
      server_id: string;
    }> {
      if (stopped || stopPromise) {
        return Promise.reject(
          new InstalledWorkerHostError(
            "WORKER_START_INVALID",
            "status is not available once stop has been requested",
          ),
        );
      }
      return enqueue(async () => {
        // ENTIRE operation covered — pending registration, send, await,
        // validation. ANY failure terminates and reaps before the original
        // typed error propagates.
        try {
          const pendingReplyGate = awaitReply(STATUS_TIMEOUT_MS);
          try {
            await channel.send({ v: 1, op: "status" });
          } catch (sendError) {
            const typed = new InstalledWorkerHostError(
              "WORKER_START_INVALID",
              stderrDiagnostics(
                sendError instanceof Error
                  ? `status send failed: ${sendError.message}`
                  : "status send failed",
              ),
            );
            rejectPending(typed.message);
            await pendingReplyGate.catch(() => undefined);
            throw typed;
          }
          const raw = (await pendingReplyGate) as Record<string, unknown>;
          assertExactKeys(
            raw as JsonValue,
            { v: 1, event: "status", state: "ready", server_id: premise.serverId },
            "status",
          );
          return raw as { v: number; event: string; state: string; server_id: string };
        } catch (error) {
          if (!closed && !child.killed) child.kill();
          await closeWaiter;
          throw error;
        }
      });
    },
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      stopped = true;
      stopPromise = enqueue(async () => {
        try {
          const replyPromise = awaitReply(STATUS_TIMEOUT_MS);
          try {
            await channel.send({ v: 1, op: "stop" });
          } catch (sendError) {
            const typed = new InstalledWorkerHostError(
              "WORKER_START_INVALID",
              stderrDiagnostics(
                sendError instanceof Error
                  ? `stop send failed: ${sendError.message}`
                  : "stop send failed",
              ),
            );
            rejectPending(typed.message);
            await replyPromise.catch(() => undefined);
            throw typed;
          }
          const reply = (await replyPromise) as Record<string, unknown>;
          assertExactKeys(reply as JsonValue, { v: 1, event: "stopped" }, "stopped");
          stopAcknowledged = true;
        } catch (firstError) {
          // Protocol or timeout failure: terminate, reap, then propagate
          // the ORIGINAL typed error (never converted to success).
          if (!closed && !child.killed) child.kill();
          await closeWaiter;
          throw firstError;
        }
        // A valid `stopped` frame still requires PROOF of stdio closure:
        // race the close waiter against a bounded grace period; timeout here
        // is a typed failure, not silent success.
        const closedInTime = await new Promise<boolean>((resolveClosed) => {
          const graceTimer = setTimeout(() => resolveClosed(false), 5000);
          void closeWaiter.then(() => {
            clearTimeout(graceTimer);
            resolveClosed(true);
          });
        });
        if (!closedInTime) {
          if (!closed && !child.killed) child.kill();
          await closeWaiter;
          throw new InstalledWorkerHostError(
            "WORKER_START_INVALID",
            "worker_host acknowledged stop but never closed stdio",
          );
        }
      });
      return stopPromise;
    },
  };
  return handle;
}
