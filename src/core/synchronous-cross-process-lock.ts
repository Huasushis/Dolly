import { createHash, randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";

const ACQUIRE_STATE = 0;
const RELEASE_STATE = 1;
const OWNERSHIP_STATE = 2;
const PENDING = 0;
const ACQUIRED = 1;
const LOCK_HELD = 2;
const HELPER_FAILED = 3;
const RELEASED = 1;
const RELEASE_FAILED = 2;
const OWNERSHIP_HELD = 1;
const OWNERSHIP_LOST = 2;
const HELPER_RESPONSE_TIMEOUT_MS = 10_000;

const LOCK_WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");
const { createServer } = require("node:net");

const ACQUIRE_STATE = 0;
const RELEASE_STATE = 1;
const OWNERSHIP_STATE = 2;
const ACQUIRED = 1;
const LOCK_HELD = 2;
const HELPER_FAILED = 3;
const RELEASED = 1;
const RELEASE_FAILED = 2;
const OWNERSHIP_HELD = 1;
const OWNERSHIP_LOST = 2;
const leases = new Map();

function signal(view, index, value) {
  Atomics.store(view, index, value);
  Atomics.notify(view, index);
}

function failLease(requestId, lease) {
  if (leases.get(requestId) !== lease) return;
  leases.delete(requestId);
  signal(lease.view, OWNERSHIP_STATE, OWNERSHIP_LOST);
  signal(lease.view, RELEASE_STATE, RELEASE_FAILED);
}

function acquire(message) {
  const view = new Int32Array(message.signal);
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.destroy();
  });
  const lease = { server, sockets, view };
  let starting = true;
  const onError = (error) => {
    if (starting) {
      starting = false;
      signal(
        view,
        ACQUIRE_STATE,
        error && error.code === "EADDRINUSE" ? LOCK_HELD : HELPER_FAILED,
      );
      try { server.close(); } catch {}
      return;
    }
    failLease(message.requestId, lease);
  };
  server.on("error", onError);
  try {
    server.listen({ path: message.endpoint, exclusive: true }, () => {
      if (!starting) return;
      starting = false;
      leases.set(message.requestId, lease);
      signal(view, OWNERSHIP_STATE, OWNERSHIP_HELD);
      signal(view, ACQUIRE_STATE, ACQUIRED);
    });
  } catch {
    starting = false;
    signal(view, ACQUIRE_STATE, HELPER_FAILED);
  }
}

function release(message) {
  const lease = leases.get(message.requestId);
  if (!lease) {
    const view = new Int32Array(message.signal);
    signal(view, OWNERSHIP_STATE, OWNERSHIP_LOST);
    signal(view, RELEASE_STATE, RELEASE_FAILED);
    return;
  }
  leases.delete(message.requestId);
  for (const socket of lease.sockets) socket.destroy();
  if (!lease.server.listening) {
    signal(lease.view, OWNERSHIP_STATE, OWNERSHIP_LOST);
    signal(lease.view, RELEASE_STATE, RELEASE_FAILED);
    return;
  }
  lease.server.close((error) => {
    if (error) {
      signal(lease.view, OWNERSHIP_STATE, OWNERSHIP_LOST);
      signal(lease.view, RELEASE_STATE, RELEASE_FAILED);
      return;
    }
    signal(lease.view, OWNERSHIP_STATE, OWNERSHIP_LOST);
    signal(lease.view, RELEASE_STATE, RELEASED);
  });
}

parentPort.on("message", (message) => {
  if (message && message.type === "acquire") acquire(message);
  else if (message && message.type === "release") release(message);
});
`;

export type SynchronousCrossProcessLockErrorCode =
  | "CROSS_PROCESS_LOCK_HELD"
  | "CROSS_PROCESS_LOCK_PLATFORM_UNSUPPORTED"
  | "CROSS_PROCESS_LOCK_HELPER_FAILED"
  | "CROSS_PROCESS_LOCK_OWNERSHIP_LOST";

export class SynchronousCrossProcessLockError extends Error {
  constructor(readonly code: SynchronousCrossProcessLockErrorCode, message: string) {
    super(message);
    this.name = "SynchronousCrossProcessLockError";
  }
}

export interface SynchronousCrossProcessLockOptions {
  /** Stable, absolute resource identity shared by all competing processes. */
  readonly resourceId: string;
}

interface LockHelper {
  readonly worker: Worker;
  disabled: boolean;
}

let lockHelperInstance: LockHelper | undefined;

function lockEndpoint(resourceId: string): string {
  if (typeof resourceId !== "string" || resourceId.length === 0 || resourceId.includes("\0")) {
    throw new SynchronousCrossProcessLockError(
      "CROSS_PROCESS_LOCK_HELPER_FAILED",
      "Cross-process lock resource identity is invalid",
    );
  }
  if (process.platform !== "linux" && process.platform !== "win32") {
    throw new SynchronousCrossProcessLockError(
      "CROSS_PROCESS_LOCK_PLATFORM_UNSUPPORTED",
      "Crash-recoverable synchronous cross-process locking is supported only on Linux and Windows",
    );
  }
  const namespace = process.platform === "win32" ? resourceId.toLowerCase() : resourceId;
  const digest = createHash("sha256").update(namespace, "utf8").digest("hex");
  return process.platform === "linux"
    ? `\0dolly-sync-lock-${digest}`
    : `\\\\.\\pipe\\dolly-sync-lock-${digest}`;
}

function lockHelper(): LockHelper {
  if (lockHelperInstance?.disabled) {
    throw new SynchronousCrossProcessLockError(
      "CROSS_PROCESS_LOCK_HELPER_FAILED",
      "Cross-process lock helper thread is unavailable; restart this process",
    );
  }
  if (lockHelperInstance) return lockHelperInstance;
  const worker = new Worker(LOCK_WORKER_SOURCE, {
    eval: true,
    name: "dolly-cross-process-lock-worker",
  });
  worker.unref();
  const created: LockHelper = { worker, disabled: false };
  worker.once("error", () => {
    created.disabled = true;
  });
  worker.once("exit", () => {
    created.disabled = true;
  });
  lockHelperInstance = created;
  return created;
}

function disableLockHelper(lockHelperValue: LockHelper): void {
  if (lockHelperValue.disabled) return;
  lockHelperValue.disabled = true;
  // Termination is initiated before control returns. Future lock attempts in
  // this process reject writes instead of creating a replacement helper.
  void lockHelperValue.worker.terminate();
}

function waitForState(
  lockHelperValue: LockHelper,
  view: Int32Array,
  index: number,
): number {
  const result = Atomics.wait(view, index, PENDING, HELPER_RESPONSE_TIMEOUT_MS);
  const state = Atomics.load(view, index);
  if (result === "timed-out" || state === PENDING) {
    disableLockHelper(lockHelperValue);
    throw new SynchronousCrossProcessLockError(
      "CROSS_PROCESS_LOCK_HELPER_FAILED",
      "Cross-process lock helper thread did not respond; restart this process",
    );
  }
  return state;
}

function releaseLock(
  lockHelperValue: LockHelper,
  requestId: string,
  signal: SharedArrayBuffer,
  view: Int32Array,
): void {
  lockHelperValue.worker.postMessage({ type: "release", requestId, signal });
  const releaseState = waitForState(lockHelperValue, view, RELEASE_STATE);
  if (releaseState !== RELEASED || Atomics.load(view, OWNERSHIP_STATE) !== OWNERSHIP_LOST) {
    disableLockHelper(lockHelperValue);
    throw new SynchronousCrossProcessLockError(
      "CROSS_PROCESS_LOCK_OWNERSHIP_LOST",
      "Cross-process lock ownership was lost before clean release",
    );
  }
}

/**
 * Runs one fully synchronous critical section while a dedicated helper thread
 * keeps an operating-system socket or pipe address bound. The helper is a
 * Node.js Worker, and the bound address is the
 * cross-process lock: only one process can bind it, and it disappears when its
 * process terminates, including after SIGKILL. A response timeout disables and
 * terminates the helper; it never authorizes taking a lock from another owner.
 * Address names provide cooperative local-process exclusion, not
 * authentication or a cross-user access-control boundary.
 *
 * The helper and calling thread can fail independently. An isolated helper or
 * native-runtime failure during operation can release the address
 * before the caller reaches the mandatory release round-trip. Stores therefore keep
 * critical sections synchronous and short, and a failed round-trip permanently
 * disables further lock use in this process.
 */
export function withSynchronousCrossProcessLock<Result>(
  options: SynchronousCrossProcessLockOptions,
  operation: () => Result,
): Result {
  const endpoint = lockEndpoint(options.resourceId);
  const lockHelperValue = lockHelper();
  const requestId = randomUUID();
  const signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
  const view = new Int32Array(signal);
  lockHelperValue.worker.postMessage({
    type: "acquire",
    requestId,
    endpoint,
    signal,
  });
  const acquireState = waitForState(lockHelperValue, view, ACQUIRE_STATE);
  if (acquireState === LOCK_HELD) {
    throw new SynchronousCrossProcessLockError(
      "CROSS_PROCESS_LOCK_HELD",
      "Another process owns the cross-process lock",
    );
  }
  if (
    acquireState !== ACQUIRED ||
    Atomics.load(view, OWNERSHIP_STATE) !== OWNERSHIP_HELD
  ) {
    disableLockHelper(lockHelperValue);
    throw new SynchronousCrossProcessLockError(
      "CROSS_PROCESS_LOCK_HELPER_FAILED",
      "Could not acquire the cross-process lock",
    );
  }

  let operationFailed = false;
  try {
    return operation();
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      releaseLock(lockHelperValue, requestId, signal, view);
    } catch (releaseError) {
      if (!operationFailed) throw releaseError;
    }
  }
}
