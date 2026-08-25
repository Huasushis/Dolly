import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { parse, resolve } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { observeHostPlatform } from "./host-platform.js";
import { canonicalRuntimeInstanceId } from "./runtime-authority-identities.js";
import { generateRuntimeUuidV7 } from "./runtime-authority-identities.js";

const INSTANCE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const STABLE_INSTANCE_ID_PATTERN = /^instance-[0-9a-f]{32}$/u;

export interface InstanceControllerLockInfo {
  readonly instanceId: string;
  /**
   * The live controller generation for THIS acquisition: a fresh RFC9562
   * lowercase UUIDv7 minted only after the kernel bind succeeded. It has no
   * persistent owner and every release, crash, or reacquire invalidates it.
   */
  readonly controllerGenerationId: string;
  readonly processId: number;
  readonly createdAt: string;
}

export type InstanceControllerLockErrorCode =
  | "CONTROLLER_LOCK_PATH_INVALID"
  | "CONTROLLER_LOCK_HELD"
  | "CONTROLLER_LOCK_INVALID"
  | "CONTROLLER_LOCK_PLATFORM_UNSUPPORTED"
  | "CONTROLLER_LOCK_OWNERSHIP_LOST"
  | "CONTROLLER_LOCK_IO_FAILED";

export class InstanceControllerLockError extends Error {
  constructor(readonly code: InstanceControllerLockErrorCode, message: string) {
    super(message);
    this.name = "InstanceControllerLockError";
  }
}

export interface AcquireInstanceControllerLockOptions {
  /** A stable per-user registry directory. Its canonical path namespaces the lock. */
  readonly directory: string;
  /** The user-facing instance identity (registry UUIDv4 or its StableId). */
  readonly instanceId: string;
  /**
   * Optional generator for the per-acquisition live controller
   * generation. If omitted a strict RFC9562 lowercase UUIDv7 is minted once
   * the kernel bind has succeeded. The caller may inject a generator for
   * deterministic tests but may never supply or reuse a generation value.
   */
  readonly controllerGenerationIdGenerator?: () => string;
  readonly processId?: number;
  readonly now?: () => string;
}

function canonicalTime(now: () => string): string {
  const candidate = now();
  const timestamp = Date.parse(candidate);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== candidate) {
    throw new InstanceControllerLockError(
      "CONTROLLER_LOCK_INVALID",
      "Controller lock clock must return a canonical ISO timestamp",
    );
  }
  return candidate;
}

function canonicalDirectory(input: string): string {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
    throw new InstanceControllerLockError(
      "CONTROLLER_LOCK_PATH_INVALID",
      "Controller lock directory is invalid",
    );
  }
  const absolute = resolve(input);
  if (absolute === parse(absolute).root) {
    throw new InstanceControllerLockError(
      "CONTROLLER_LOCK_PATH_INVALID",
      "Controller lock directory cannot be a filesystem root",
    );
  }
  try {
    mkdirSync(absolute, { recursive: true, mode: 0o700 });
    const canonical = realpathSync.native(absolute);
    if (!statSync(canonical).isDirectory()) {
      throw new InstanceControllerLockError(
        "CONTROLLER_LOCK_PATH_INVALID",
        "path must resolve to a directory",
      );
    }
    return canonical;
  } catch (e) {
    if (e instanceof InstanceControllerLockError) throw e;
    throw new InstanceControllerLockError(
      "CONTROLLER_LOCK_IO_FAILED",
      "Could not prepare the controller lock namespace",
    );
  }
}

function controllerEndpoint(id: string): { name: string } {
  // The acquire preflight (see `observeHostPlatform` above) refuses every
  // non-Linux host before this function can run, so a Windows named-pipe
  // endpoint is unreachable and a Windows support claim would be untrue.
  // Linux abstract Unix-domain sockets are the only supported endpoint.
  const digest = createHash("sha256").update(id, "utf8").digest("hex");
  if (process.platform !== "linux") {
    throw new InstanceControllerLockError(
      "CONTROLLER_LOCK_PLATFORM_UNSUPPORTED",
      "Crash-recoverable controller locking requires Linux but this process is not on Linux",
    );
  }
  return { name: `\0dolly-controller-${digest}` };
}

function validateInstanceId(instanceId: unknown): asserts instanceId is string {
  if (
    typeof instanceId !== "string" ||
    (!INSTANCE_ID_PATTERN.test(instanceId) && !STABLE_INSTANCE_ID_PATTERN.test(instanceId))
  ) {
    throw new InstanceControllerLockError(
      "CONTROLLER_LOCK_INVALID",
      "Controller lock instanceId must be a lowercase UUIDv4 or its deterministic Runtime StableId",
    );
  }
}

function mintId(): string {
  return generateRuntimeUuidV7({
    now: () => Date.now(),
    randomBytes: (size) => randomBytes(size),
  });
}

function closeServer(server: Server, sockets: ReadonlySet<Socket>): Promise<void> {
  for (const s of sockets) s.destroy();
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

export class InstanceControllerLock {
  readonly #server: Server;
  readonly #sockets: Set<Socket>;
  readonly #info: InstanceControllerLockInfo;
  #held = true;
  #leaseError: Error | undefined;

  private constructor(
    server: Server,
    sockets: Set<Socket>,
    info: InstanceControllerLockInfo,
  ) {
    this.#server = server;
    this.#sockets = sockets;
    this.#info = info;
    server.on("error", (error) => { this.#leaseError = error; });
    server.on("close", () => {
      if (this.#held) {
        this.#leaseError = new InstanceControllerLockError(
          "CONTROLLER_LOCK_OWNERSHIP_LOST",
          "Controller ownership endpoint closed unexpectedly",
        );
      }
    });
  }

  static async acquire(options: {
    readonly directory: string;
    readonly instanceId: string;
    readonly controllerGenerationIdGenerator?: () => string;
    readonly processId?: number;
    readonly now?: () => string;
  }): Promise<InstanceControllerLock> {
    // Trusted internal platform preflight, read through the same host-owned
    // observer the daemon, Linux Module activation, and Core service binding
    // gates use. It runs before `canonicalDirectory` so an unsupported host is
    // refused before any durable mutation (the controller namespace mkdir) or
    // before the kernel listen that proves ownership.
    const platform = observeHostPlatform();
    if (platform !== "linux") {
      throw new InstanceControllerLockError(
        "CONTROLLER_LOCK_PLATFORM_UNSUPPORTED",
        `Crash-recoverable controller locking requires Linux but this process runs on ${platform}`,
      );
    }
    const directory = canonicalDirectory(options.directory);
    validateInstanceId(options.instanceId);
    // The retired pre-cutover callers supplied a fixed `controllerId`; the
    // live generation is now minted here. Refuse any such object rather than
    // silently ignore the field, so a dead callsite can never believe its
    // supplied controller identity survived the cutover.
    if ("controllerId" in options) {
      throw new InstanceControllerLockError(
        "CONTROLLER_LOCK_INVALID",
        "controllerId is retired; the live controllerGenerationId is minted by the lock",
      );
    }
    const processId = options.processId ?? process.pid;
    if (!Number.isSafeInteger(processId) || processId <= 0) {
      throw new InstanceControllerLockError(
        "CONTROLLER_LOCK_INVALID",
        "processId must be a positive safe integer",
      );
    }
    // The controller namespace is keyed by the deterministic StableId, so a
    // manager passing the registry UUIDv4 and a manager passing the projected
    // StableId always contend for the same kernel object. The registry UUIDv4
    // remains the durable source; this lock only ever sees the projection.
    const instanceId = canonicalRuntimeInstanceId(options.instanceId);
    const acquiredAt = canonicalTime(options.now ?? (() => new Date().toISOString()));
    const mint = options.controllerGenerationIdGenerator ?? mintId;
    const endpoint = controllerEndpoint(`${directory}\0${instanceId}`);

    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      if (sockets.size >= 16) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.setTimeout(1_000, () => socket.destroy());
      socket.once("close", () => sockets.delete(socket));
      // Ownership is proven by the bound kernel object, not by a data protocol.
      socket.destroy();
    });
    server.maxConnections = 16;

    return new Promise((resolveAcquire, rejectAcquire) => {
      let settled = false;
      const onStartError = (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        const failure = error.code === "EADDRINUSE"
          ? new InstanceControllerLockError(
              "CONTROLLER_LOCK_HELD",
              "Instance already has a live controller ownership endpoint",
            )
          : new InstanceControllerLockError(
              "CONTROLLER_LOCK_IO_FAILED",
              "Could not bind the controller ownership endpoint",
            );
        void closeServer(server, sockets).finally(() => rejectAcquire(failure));
      };
      server.once("error", onStartError);
      server.listen({ path: endpoint.name, exclusive: true }, () => {
        if (settled) return;
        settled = true;
        server.off("error", onStartError);
        // The kernel bind has succeeded; mint the live generation NOW so a
        // refused acquisition can never fabricate one for later reuse.
        const info = Object.freeze({
          instanceId,
          controllerGenerationId: mint(),
          processId,
          createdAt: acquiredAt,
        }) as InstanceControllerLockInfo;
        resolveAcquire(new InstanceControllerLock(server, sockets, info));
      });
    });
  }

  get info(): InstanceControllerLockInfo {
    return this.#info;
  }

  get held(): boolean {
    return this.#held && this.#server.listening && this.#leaseError === undefined;
  }

  assertHeld(): void {
    if (!this.held) {
      throw new InstanceControllerLockError(
        "CONTROLLER_LOCK_OWNERSHIP_LOST",
        "Controller no longer owns its kernel endpoint",
      );
    }
  }

  async release(): Promise<void> {
    if (!this.#held) return;
    this.assertHeld();
    // Fence this owner before closing the kernel object that permits a successor.
    this.#held = false;
    try {
      await closeServer(this.#server, this.#sockets);
    } catch {
      throw new InstanceControllerLockError(
        "CONTROLLER_LOCK_IO_FAILED",
        "Could not release the controller ownership endpoint",
      );
    }
  }
}

