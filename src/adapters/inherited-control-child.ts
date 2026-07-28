import { createReadStream, createWriteStream } from "node:fs";
import type { Readable, Writable } from "node:stream";
import {
  createAuthenticatedReadinessEnvelope,
  type ChildReadinessReport,
  type SupervisorBootstrapMessage,
} from "../core/process-supervisor.js";
import { FramedJsonChannel } from "../core/framed-json-channel.js";
import {
  asControlJson,
  createChildControlAuthenticated,
  createChildControlHello,
  createChildControlReadiness,
  createControlNonce,
  INHERITED_CONTROL_MAX_FRAME_BYTES,
  parseParentControlBootstrap,
} from "../core/inherited-child-control-protocol.js";

export interface InheritedControlChildOptions {
  readonly initialize: (
    bootstrap: SupervisorBootstrapMessage,
  ) => ChildReadinessReport | Promise<ChildReadinessReport>;
  readonly shutdown: () => void | Promise<void>;
  readonly authenticationTimeoutMs?: number;
  readonly parentLossShutdownTimeoutMs?: number;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly childNonce?: string;
  readonly exit?: (code: number) => void;
}

export interface InheritedControlChildHandle {
  readonly bootstrap: SupervisorBootstrapMessage;
  close(): Promise<void>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  settled: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const result: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    resolve: (value) => {
      if (result.settled) return;
      result.settled = true;
      resolvePromise(value);
    },
    reject: (reason) => {
      if (result.settled) return;
      result.settled = true;
      rejectPromise(reason);
    },
    settled: false,
  };
  void result.promise.catch(() => undefined);
  return result;
}

function assertTimeout(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new TypeError(`${label} must be an integer between 1 and 60000`);
  }
}

function inheritedReadable(fd: number): Readable {
  return createReadStream("", { fd, autoClose: false });
}

function inheritedWritable(fd: number): Writable {
  return createWriteStream("", { fd, autoClose: false });
}

export async function startInheritedControlChild(
  options: InheritedControlChildOptions,
): Promise<InheritedControlChildHandle> {
  const authenticationTimeoutMs = options.authenticationTimeoutMs ?? 5_000;
  const parentLossShutdownTimeoutMs = options.parentLossShutdownTimeoutMs ?? 1_000;
  assertTimeout(authenticationTimeoutMs, "authenticationTimeoutMs");
  assertTimeout(parentLossShutdownTimeoutMs, "parentLossShutdownTimeoutMs");

  const input = options.input ?? inheritedReadable(3);
  const output = options.output ?? inheritedWritable(4);
  const childNonce = options.childNonce ?? createControlNonce();
  const completion = deferred<InheritedControlChildHandle>();
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let authenticated = false;
  let closing = false;
  let lossHandled = false;
  let bootstrap: SupervisorBootstrapMessage | undefined;
  let authenticationTimer: ReturnType<typeof setTimeout> | undefined;

  const boundedShutdownAndExit = (code: number): void => {
    if (lossHandled || closing) return;
    lossHandled = true;
    if (authenticationTimer) clearTimeout(authenticationTimer);
    completion.reject(new Error("Inherited parent control channel was lost"));
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, parentLossShutdownTimeoutMs);
      timer.unref?.();
    });
    void Promise.race([
      Promise.resolve().then(() => options.shutdown()).catch(() => undefined),
      timeout,
    ]).finally(() => {
      channel.close();
      exit(code);
    });
  };

  const channel = new FramedJsonChannel(input, output, {
    maxFrameBytes: INHERITED_CONTROL_MAX_FRAME_BYTES,
    onMessage: (message) => {
      if (authenticated || closing || lossHandled) {
        boundedShutdownAndExit(76);
        return;
      }
      void (async () => {
        try {
          const parent = parseParentControlBootstrap(message, childNonce);
          bootstrap = parent.bootstrap;
          authenticated = true;
          if (authenticationTimer) clearTimeout(authenticationTimer);
          await channel.send(asControlJson(createChildControlAuthenticated(parent)));
          const report = await options.initialize(parent.bootstrap);
          const readiness = createAuthenticatedReadinessEnvelope(parent.bootstrap, report);
          await channel.send(asControlJson(createChildControlReadiness(readiness)));
          completion.resolve({
            bootstrap: parent.bootstrap,
            close: async () => {
              if (closing) return;
              closing = true;
              await Promise.resolve(options.shutdown());
              channel.close();
            },
          });
        } catch {
          boundedShutdownAndExit(76);
        }
      })();
    },
    onError: () => boundedShutdownAndExit(75),
    onEnd: () => boundedShutdownAndExit(75),
  });

  authenticationTimer = setTimeout(
    () => boundedShutdownAndExit(76),
    authenticationTimeoutMs,
  );
  authenticationTimer.unref?.();
  try {
    await channel.send(asControlJson(createChildControlHello(childNonce)));
  } catch {
    boundedShutdownAndExit(75);
  }
  return completion.promise;
}
