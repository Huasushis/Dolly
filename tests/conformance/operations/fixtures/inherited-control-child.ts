import { createReadStream, createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";
import { InheritedControlProcessLauncher } from "../../../../src/adapters/inherited-control-process-launcher.js";
import { startInheritedControlChild } from "../../../../src/adapters/inherited-control-child.js";
import { canonicalizeJson, type JsonValue } from "../../../../src/core/canonical-json.js";
import { FramedJsonChannel } from "../../../../src/core/framed-json-channel.js";
import {
  asControlJson,
  createChildControlAuthenticated,
  createChildControlHello,
  createChildControlReadiness,
  INHERITED_CONTROL_MAX_FRAME_BYTES,
  parseParentControlBootstrap,
} from "../../../../src/core/inherited-child-control-protocol.js";
import {
  createAuthenticatedReadinessEnvelope,
  type ProcessLaunchObserver,
  type SupervisorSpawnRequest,
} from "../../../../src/core/process-supervisor.js";

const mode = process.argv[2] ?? "valid-fragmented";
const fixturePath = fileURLToPath(import.meta.url);

function request(): SupervisorSpawnRequest {
  return {
    schemaVersion: "dolly.supervisor-bootstrap/1",
    instanceId: "eof-fixture-instance",
    processGenerationId: "eof-fixture-generation",
    processIdentityToken: "I".repeat(43),
    daemonProtocolVersion: "daemon-v1",
    ipcProtocolVersion: "ipc-v1",
    configRevision: `sha256:${"e".repeat(64)}`,
    readinessChallenge: "C".repeat(43),
    readinessSecret: "S".repeat(43),
    requestedAt: new Date().toISOString(),
  };
}

async function runParentHarness(): Promise<void> {
  const launcher = new InheritedControlProcessLauncher({
    command: process.execPath,
    args: ["--import", "tsx/esm", fixturePath, "eof-cleanup"],
    cwd: process.cwd(),
    authenticationTimeoutMs: 5_000,
  });
  let resolveReady!: () => void;
  let rejectReady!: (reason: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const observer: ProcessLaunchObserver = {
    ready: () => resolveReady(),
    channelLost: () => rejectReady(new Error("Grandchild control channel was lost early")),
    exit: () => rejectReady(new Error("Grandchild exited before readiness")),
    error: () => rejectReady(new Error("Grandchild process transport failed")),
  };
  const child = await launcher.launch(request(), observer);
  await ready;
  process.stdout.write(`GRANDCHILD:${child.pid}\n`, () => process.exit(0));
}

async function runEofCleanupChild(): Promise<void> {
  await startInheritedControlChild({
    initialize: () => ({
      endpoints: [],
      durableStateReady: true,
      requiredListenersReady: true,
    }),
    shutdown: () => new Promise<void>(() => undefined),
    parentLossShutdownTimeoutMs: 150,
    authenticationTimeoutMs: 5_000,
  });
}

function frameText(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

function frameJson(value: JsonValue): Buffer {
  return frameText(canonicalizeJson(value));
}

function write(output: Writable, bytes: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    output.write(bytes, (error) => (error ? reject(error) : resolve()));
  });
}

async function writeFragmented(output: Writable, bytes: Buffer): Promise<void> {
  const widths = [1, 2, 3, 5, 8, 13];
  let offset = 0;
  let index = 0;
  while (offset < bytes.byteLength) {
    const end = Math.min(bytes.byteLength, offset + widths[index % widths.length]!);
    await write(output, bytes.subarray(offset, end));
    offset = end;
    index += 1;
  }
}

function alterProof(proof: string): string {
  return `${proof[0] === "A" ? "B" : "A"}${proof.slice(1)}`;
}

async function runProtocolFixture(): Promise<void> {
  const input = createReadStream("", { fd: 3, autoClose: false });
  const output = createWriteStream("", { fd: 4, autoClose: true });
  const childNonce = "N".repeat(43);
  let stopping = false;
  let keepRunningAfterAuthenticationFailure = false;

  const stop = (code: number): void => {
    if (stopping) return;
    stopping = true;
    channel.close();
    process.exit(code);
  };
  process.once("SIGTERM", () => {
    if (!keepRunningAfterAuthenticationFailure) stop(0);
  });
  process.once("SIGINT", () => stop(0));

  const channel = new FramedJsonChannel(input, output, {
    maxFrameBytes: INHERITED_CONTROL_MAX_FRAME_BYTES,
    onMessage: (message) => {
      void (async () => {
        try {
          const parent = parseParentControlBootstrap(message, childNonce);
          const authenticated = createChildControlAuthenticated(parent);
          if (mode === "authentication-failure-then-valid") {
            process.stdout.write(
              `PROCESS:${parent.bootstrap.processGenerationId}:${process.pid}\n`,
            );
          }
          if (
            mode === "authentication-failure-then-valid" &&
            parent.bootstrap.processGenerationId === "replacement-generation-1"
          ) {
            keepRunningAfterAuthenticationFailure = true;
            setInterval(() => undefined, 1_000);
            await write(output, frameJson({
              ...authenticated,
              proof: alterProof(authenticated.proof),
            } as unknown as JsonValue));
            return;
          }
          if (mode === "wrong-auth-mac") {
            await write(output, frameJson({
              ...authenticated,
              proof: alterProof(authenticated.proof),
            } as unknown as JsonValue));
            return;
          }
          if (mode === "wrong-auth-binding") {
            await write(output, frameJson({
              ...authenticated,
              binding: {
                ...authenticated.binding,
                configRevision: `sha256:${"f".repeat(64)}`,
              },
            } as unknown as JsonValue));
            return;
          }
          await writeFragmented(output, frameJson(asControlJson(authenticated)));

          const readiness = createAuthenticatedReadinessEnvelope(parent.bootstrap, {
            endpoints:
              mode === "public-endpoint"
                ? [{ kind: "http", address: "http://0.0.0.0:32123" }]
                : [],
            durableStateReady: true,
            requiredListenersReady: true,
          });
          const readinessValue =
            mode === "stale-generation"
              ? { ...readiness, processGenerationId: "old-generation" }
              : mode === "wrong-readiness-mac"
                ? { ...readiness, proof: alterProof(readiness.proof) }
                : readiness;
          await writeFragmented(
            output,
            frameJson(asControlJson(createChildControlReadiness(
              readinessValue as typeof readiness,
            ))),
          );
          process.stdout.write(`${JSON.stringify({
            inheritedSecretPresent: Object.hasOwn(process.env, "DOLLY_PARENT_SECRET"),
            allowedValue: process.env.DOLLY_ALLOWED_VALUE ?? null,
          })}\n`);
          if (mode === "drop-control") {
            setTimeout(() => output.end(), 50);
          }
        } catch {
          stop(76);
        }
      })();
    },
    onError: () => {
      if (!keepRunningAfterAuthenticationFailure) stop(76);
    },
    onEnd: () => {
      if (!keepRunningAfterAuthenticationFailure) stop(75);
    },
  });

  if (mode === "duplicate-key") {
    await write(
      output,
      frameText(
        `{"schemaVersion":"dolly.inherited-child-control/1","type":"child.hello","childNonce":"${childNonce}","childNonce":"${"D".repeat(43)}"}`,
      ),
    );
    return;
  }
  if (mode === "malformed-json") {
    await write(output, frameText('{"schemaVersion":'));
    return;
  }
  if (mode === "oversized-frame") {
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(INHERITED_CONTROL_MAX_FRAME_BYTES + 1, 0);
    await write(output, header);
    return;
  }
  await writeFragmented(
    output,
    frameJson(asControlJson(createChildControlHello(childNonce))),
  );
}

if (mode === "parent-harness") {
  void runParentHarness().catch(() => process.exit(70));
} else if (mode === "eof-cleanup") {
  void runEofCleanupChild().catch(() => undefined);
} else {
  void runProtocolFixture().catch(() => process.exit(70));
}
