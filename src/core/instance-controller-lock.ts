import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { parse, resolve } from "node:path";
import { createServer, type Server, type Socket } from "node:net";

const INSTANCE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTROLLER_ID_PATTERN = INSTANCE_ID_PATTERN;

export interface InstanceControllerLockInfo {
  readonly instanceId: string;
  readonly controllerId: string;
  readonly processId: number;
  readonly acquiredAt: string;
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
  readonly instanceId: string;
  readonly controllerId?: string;
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
        "Controller lock path must resolve to a directory",
      );
    }
    return canonical;
  } catch (error) {
    if (error instanceof InstanceControllerLockError) throw error;
    throw new InstanceControllerLockError(
      "CONTROLLER_LOCK_IO_FAILED",
      "Could not prepare the controller lock namespace",
    );
  }
}

function controllerEndpoint(directory: string, instanceId: string): string {
  const namespace = process.platform === "win32" ? directory.toLowerCase() : directory;
  const digest = createHash("sha256")
    .update(namespace, "utf8")
    .update("\0", "utf8")
    .update(instanceId, "utf8")
    .digest("hex");
  if (process.platform === "linux") {
    // Linux abstract sockets have no filesystem entry and disappear on process death.
    return `\0dolly-controller-${digest}`;
  }
  if (process.platform === "win32") {
    // The Windows named-pipe object is owned by the open server handle.
    return `\\\\.\\pipe\\dolly-controller-${digest}`;
  }
  throw new InstanceControllerLockError(
    "CONTROLLER_LOCK_PLATFORM_UNSUPPORTED",
    "Crash-recoverable controller locking is currently supported on Linux and Windows",
  );
}

function validateIdentity(options: AcquireInstanceControllerLockOptions): InstanceControllerLockInfo {
  if (!INSTANCE_ID_PATTERN.test(options.instanceId)) {
    throw new InstanceControllerLockError(
      "CONTROLLER_LOCK_INVALID",
      "Controller lock instanceId must be a lowercase UUIDv4",
    );
  }
  const controllerId = options.controllerId ?? randomUUID();
  if (!CONTROLLER_ID_PATTERN.test(controllerId)) {
    throw new InstanceControllerLockError(
      "CONTROLLER_LOCK_INVALID",
      "controllerId must be a lowercase UUIDv4",
    );
  }
  const processId = options.processId ?? process.pid;
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new InstanceControllerLockError(
      "CONTROLLER_LOCK_INVALID",
      "processId must be a positive safe integer",
    );
  }
  return Object.freeze({
    instanceId: options.instanceId,
    controllerId,
    processId,
    acquiredAt: canonicalTime(options.now ?? (() => new Date().toISOString())),
  });
}

function closeServer(server: Server, sockets: ReadonlySet<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
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
    server.on("error", (error) => {
      this.#leaseError = error;
    });
    server.on("close", () => {
      if (this.#held) {
        this.#leaseError = new InstanceControllerLockError(
          "CONTROLLER_LOCK_OWNERSHIP_LOST",
          "Controller ownership endpoint closed unexpectedly",
        );
      }
    });
  }

  static async acquire(
    options: AcquireInstanceControllerLockOptions,
  ): Promise<InstanceControllerLock> {
    const directory = canonicalDirectory(options.directory);
    const info = validateIdentity(options);
    const endpoint = controllerEndpoint(directory, info.instanceId);
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
      server.listen({ path: endpoint, exclusive: true }, () => {
        if (settled) return;
        settled = true;
        server.off("error", onStartError);
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
