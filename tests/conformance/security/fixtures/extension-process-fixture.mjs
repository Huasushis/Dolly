import { existsSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] ?? "normal";
const protocolVersion = mode === "old-protocol" ? "2.0" : "3.0";
let initialized;
let extensionRequest = 0;
let activeRun;
let moduleExecutionCount = 0;
let outsideRunOutcome;
const pending = new Map();
let inputBuffer = Buffer.alloc(0);

function send(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.byteLength, 0);
  process.stdout.write(Buffer.concat([header, payload]));
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function request(method, params) {
  const id = `extension-${++extensionRequest}`;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

async function probeListener() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => server.close(resolve));
  return true;
}

async function probeSubprocess() {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
    env: {},
    stdio: "ignore",
  });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  return code === 0;
}

async function invokeCapability(
  handle,
  operation = "read",
  executionScope = {
    moduleJobId: "module-job-capability",
    runId: "run-capability",
    idempotencyKey: "fixture-effect",
  },
  argumentsValue = { key: "fixture-key" },
) {
  return request("capability.invoke", {
    protocolVersion,
    sessionId: initialized.sessionId,
    handle,
    operation,
    arguments: argumentsValue,
    ...(mode === "old-module-job-field"
      ? { processingId: "module-job-capability" }
      : { moduleJobId: executionScope.moduleJobId }),
    ...(mode === "capability-missing-run-id" ? {} : { runId: executionScope.runId }),
    idempotencyKey: executionScope.idempotencyKey,
  });
}

function capabilityErrorCodeOf(response) {
  return response.result?.value ?? {
    capabilityErrorCode: response.error?.data?.errorCode ?? "unknown",
  };
}

function deniedOperation(operation) {
  try {
    operation();
    return { outcome: "allowed" };
  } catch (error) {
    return {
      outcome: "denied",
      code: typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "unknown",
    };
  }
}

function confinementReport() {
  const corePid = initialized.config.coreProcessId;
  return {
    processId: process.pid,
    userId: process.getuid?.() ?? null,
    currentDirectory: process.cwd(),
    entrypointPath: fileURLToPath(import.meta.url),
    cgroup: readFileSync("/proc/self/cgroup", "utf8").trim(),
    cgroupNamespace: readlinkSync("/proc/self/ns/cgroup"),
    networkNamespace: readlinkSync("/proc/self/ns/net"),
    networkRouteRows: readFileSync("/proc/net/route", "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .filter((line) => line.trim().length > 0)
      .length,
    environmentKeys: Object.keys(process.env).sort(),
    cgroupWrite: deniedOperation(() =>
      writeFileSync("/sys/fs/cgroup/cgroup.procs", String(process.pid), "utf8")
    ),
    coreSignal: deniedOperation(() => process.kill(corePid, 0)),
    coreProcessRead: deniedOperation(() =>
      readFileSync(`/proc/${corePid}/status`, "utf8")
    ),
    coreStateRead: deniedOperation(() =>
      readFileSync(initialized.config.coreStatePath, "utf8")
    ),
    userManagerVisible: existsSync(initialized.config.userManagerPath),
  };
}

async function handleHostRequest(message) {
  const { id, method, params } = message;
  if (method === "dolly.initialize") {
    if (mode === "initialize-hang") return;
    initialized = params;
    respond(id, {
      protocolVersion,
      sessionId: params.sessionId,
      extensionId: mode === "bad-initialize" ? "com.attacker.wrong" : params.extensionId,
      packageVersion: "1.0.0",
      moduleKinds: ["fixture"],
    });
    return;
  }
  if (method === "module.create") {
    if (mode === "module-create-hang") {
      writeFileSync(initialized.config.markerPath, "module.create", "utf8");
      return;
    }
    if (mode === "capability-outside-run") {
      // Invoke the capability before module.create is answered, so the host
      // provably has no active Run. The outcome is recorded and returned by
      // the later module.execute, which keeps the assertion deterministic.
      outsideRunOutcome = capabilityErrorCodeOf(
        await invokeCapability(initialized.capabilities[0].handle),
      );
    }
    respond(id, {
      protocolVersion,
      sessionId: params.sessionId,
      ...(mode === "old-module-id-field"
        ? { moduleInstanceId: params.moduleId }
        : { moduleId: params.moduleId }),
      moduleGenerationId: params.moduleGenerationId,
      ...(mode === "old-module-handle-field"
        ? { moduleHandle: "removed-module-handle" }
        : {}),
    });
    return;
  }
  if (method === "module.execute") {
    if (mode === "model-stream-required") {
      const handle = initialized.capabilities[0].handle;
      const common = {
        messages: [{ role: "user", parts: [{ kind: "text", text: "hello" }] }],
        outputContract: { kind: "text" },
        reasoning: "disable",
      };
      const nonStreaming = capabilityErrorCodeOf(
        await invokeCapability(
          handle,
          "chat",
          {
            moduleJobId: params.moduleJobId,
            runId: params.runId,
            idempotencyKey: `${params.moduleJobId}-non-streaming`,
          },
          { ...common, stream: false },
        ),
      );
      const streaming = capabilityErrorCodeOf(
        await invokeCapability(
          handle,
          "chat",
          {
            moduleJobId: params.moduleJobId,
            runId: params.runId,
            idempotencyKey: `${params.moduleJobId}-streaming`,
          },
          { ...common, stream: true },
        ),
      );
      respond(id, {
        protocolVersion,
        sessionId: params.sessionId,
        moduleId: params.moduleId,
        moduleGenerationId: params.moduleGenerationId,
        runId: params.runId,
        result: { nonStreaming, streaming },
      });
      return;
    }
    if (mode === "private-storage-checkpoint-active-run") {
      const handle = initialized.capabilities[0].handle;
      const scope = (suffix) => ({
        moduleJobId: params.moduleJobId,
        runId: params.runId,
        idempotencyKey: `${params.moduleJobId}-${suffix}`,
      });
      const stored = await invokeCapability(
        handle,
        "set",
        scope("checkpoint-set"),
        {
          key: "task-checkpoint",
          value: {
            schemaVersion: "dolly.task-checkpoint/1",
            taskId: "task-a",
            nextAction: "resume-step-2",
            evidenceKeys: ["source-a"],
          },
        },
      );
      const listed = await invokeCapability(
        handle,
        "list",
        scope("checkpoint-list"),
        { prefix: "task-", limit: 8 },
      );
      const loaded = await invokeCapability(
        handle,
        "get",
        scope("checkpoint-get"),
        { key: "task-checkpoint" },
      );
      respond(id, {
        protocolVersion,
        sessionId: params.sessionId,
        moduleId: params.moduleId,
        moduleGenerationId: params.moduleGenerationId,
        runId: params.runId,
        result: {
          stored: capabilityErrorCodeOf(stored),
          listed: capabilityErrorCodeOf(listed),
          loaded: capabilityErrorCodeOf(loaded),
        },
      });
      return;
    }
    if (
      mode === "module-result-then-cancel" ||
      mode === "module-result-then-ignore-cancel"
    ) {
      moduleExecutionCount += 1;
      if (moduleExecutionCount === 1) {
        respond(id, {
          protocolVersion,
          sessionId: params.sessionId,
          moduleId: params.moduleId,
          moduleGenerationId: params.moduleGenerationId,
          runId: params.runId,
          result: {
            schemaVersion: "dolly.module-result/1",
            blockProposal: {
              payload: {
                schema: "dolly.content/1",
                value: {
                  items: [
                    {
                      type: "text",
                      text: "processed by the real child process",
                      format: "plain",
                    },
                  ],
                },
              },
            },
          },
        });
      } else {
        // This mode holds later executions so a runtime stop can release the active Claim.
        writeFileSync(initialized.config.markerPath, "module.execute", "utf8");
        activeRun = { id, params };
      }
      return;
    }
    if (mode === "crash") {
      process.exit(23);
    }
    if (mode === "business-error") {
      send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32_000,
          message: "fixture business error",
          data: { errorCode: "FIXTURE_FAILURE", retryable: false },
        },
      });
      return;
    }
    if (mode === "capability-then-business-error") {
      await invokeCapability(
        initialized.capabilities[0].handle,
        "read",
        {
          moduleJobId: params.moduleJobId,
          runId: params.runId,
          idempotencyKey: `${params.moduleJobId}-fixture-effect`,
        },
      );
      send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32_000,
          message: "fixture business error after capability",
          data: { errorCode: "FIXTURE_FAILURE", retryable: false },
        },
      });
      return;
    }
    if (mode === "capability-quota-then-business-error") {
      await invokeCapability(
        initialized.capabilities[0].handle,
        "read",
        {
          moduleJobId: params.moduleJobId,
          runId: params.runId,
          idempotencyKey: `${params.moduleJobId}-fixture-effect-1`,
        },
      );
      await invokeCapability(
        initialized.capabilities[0].handle,
        "read",
        {
          moduleJobId: params.moduleJobId,
          runId: params.runId,
          idempotencyKey: `${params.moduleJobId}-fixture-effect-2`,
        },
      );
      send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32_000,
          message: "fixture business error after capability quota refusal",
          data: { errorCode: "FIXTURE_FAILURE", retryable: false },
        },
      });
      return;
    }
    if (mode === "cpu-loop") {
      while (true) {
        // Deliberately block this child process only.
      }
    }
    if (mode === "oversized-frame") {
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(initialized.limits.maxFrameBytes + 1, 0);
      process.stdout.write(header);
      return;
    }
    if (mode === "cancel-aware" || mode === "late-after-cancel") {
      activeRun = { id, params };
      return;
    }
    if (mode === "initialization-fields") {
      respond(id, {
        protocolVersion,
        sessionId: params.sessionId,
        moduleId: params.moduleId,
        moduleGenerationId: params.moduleGenerationId,
        runId: params.runId,
        result: {
          isolation: initialized.isolation,
          hasProfile: Object.hasOwn(initialized, "profile"),
        },
      });
      return;
    }
    if (mode === "authority-probe") {
      const fileValue = readFileSync(initialized.config.probeFilePath, "utf8");
      const listenerOpened = await probeListener();
      const subprocessCreated = await probeSubprocess();
      respond(id, {
        protocolVersion,
        sessionId: params.sessionId,
        moduleId: params.moduleId,
        moduleGenerationId: params.moduleGenerationId,
        runId: params.runId,
        result: {
          inheritedSecret: process.env.DOLLY_HOST_SECRET ?? null,
          fileValue,
          listenerOpened,
          subprocessCreated,
        },
      });
      return;
    }
    if (mode === "process-id") {
      respond(id, {
        protocolVersion,
        sessionId: params.sessionId,
        moduleId: params.moduleId,
        moduleGenerationId: params.moduleGenerationId,
        runId: params.runId,
        result: { processId: process.pid },
      });
      return;
    }
    if (mode === "capability-outside-run") {
      respond(id, {
        protocolVersion,
        sessionId: params.sessionId,
        moduleId: params.moduleId,
        moduleGenerationId: params.moduleGenerationId,
        runId: params.runId,
        result: outsideRunOutcome,
      });
      return;
    }
    if (
      mode === "capability" ||
      mode === "capability-active-run" ||
      mode === "stale-capability" ||
      mode === "old-module-job-field" ||
      mode === "capability-missing-run-id"
    ) {
      const handle =
        mode === "stale-capability"
          ? initialized.config.staleHandle
          : initialized.capabilities[0].handle;
      const capabilityResponse = await invokeCapability(
        handle,
        "read",
        mode === "capability-active-run"
          ? {
              moduleJobId: params.moduleJobId,
              runId: params.runId,
              idempotencyKey: `${params.moduleJobId}-fixture-effect`,
            }
          : undefined,
      );
      respond(id, {
        protocolVersion,
        sessionId: params.sessionId,
        moduleId: params.moduleId,
        moduleGenerationId: params.moduleGenerationId,
        runId: params.runId,
        result: capabilityErrorCodeOf(capabilityResponse),
      });
      return;
    }
    if (mode === "tool-registry-active-run") {
      const capabilityResponse = await invokeCapability(
        initialized.capabilities[0].handle,
        "list-tools",
        {
          moduleJobId: params.moduleJobId,
          runId: params.runId,
          idempotencyKey: `${params.moduleJobId}-tool-registry`,
        },
        {},
      );
      respond(id, {
        protocolVersion,
        sessionId: params.sessionId,
        moduleId: params.moduleId,
        moduleGenerationId: params.moduleGenerationId,
        runId: params.runId,
        result: capabilityErrorCodeOf(capabilityResponse),
      });
      return;
    }
    if (mode === "tool-registry-execute-active-run") {
      const handle = initialized.capabilities[0].handle;
      const view = await invokeCapability(
        handle,
        "list-tools",
        {
          moduleJobId: params.moduleJobId,
          runId: params.runId,
          idempotencyKey: `${params.moduleJobId}-tool-registry`,
        },
        {},
      );
      const round = await invokeCapability(
        handle,
        "execute-round",
        {
          moduleJobId: params.moduleJobId,
          runId: params.runId,
          idempotencyKey: `${params.moduleJobId}-tool-round-1`,
        },
        {
          roundIndex: 1,
          calls: [{
            callId: "call-read-note",
            name: "read_note",
            argumentsJson: '{"key":"deployment-note"}',
          }],
        },
      );
      respond(id, {
        protocolVersion,
        sessionId: params.sessionId,
        moduleId: params.moduleId,
        moduleGenerationId: params.moduleGenerationId,
        runId: params.runId,
        result: {
          view: capabilityErrorCodeOf(view),
          round: capabilityErrorCodeOf(round),
        },
      });
      return;
    }
    if (mode === "capability-result-before-effect") {
      const capabilityResponse = invokeCapability(
        initialized.capabilities[0].handle,
        "read",
        {
          moduleJobId: params.moduleJobId,
          runId: params.runId,
          idempotencyKey: `${params.moduleJobId}-fixture-effect`,
        },
      );
      const markerPath = initialized.config.capabilityStartedMarkerPath;
      for (let attempt = 0; attempt < 200 && !existsSync(markerPath); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (!existsSync(markerPath)) throw new Error("capability handler did not start");
      respond(id, {
        protocolVersion,
        sessionId: params.sessionId,
        moduleId: params.moduleId,
        moduleGenerationId: params.moduleGenerationId,
        runId: params.runId,
        result: { respondedBeforeCapability: true },
      });
      await capabilityResponse;
      return;
    }
    respond(id, {
      protocolVersion,
      sessionId: params.sessionId,
      moduleId: params.moduleId,
      moduleGenerationId: params.moduleGenerationId,
      runId: mode === "stale-result" ? "stale-run" : params.runId,
      result: initialized.config.confinementProbe === true
        ? { ok: true, input: params.input, confinement: confinementReport() }
        : { ok: true, input: params.input },
    });
    return;
  }
  if (method === "dolly.cancel") {
    if (
      (mode === "cancel-aware" || mode === "module-result-then-cancel") &&
      activeRun?.id === params.requestId
    ) {
      const current = activeRun;
      activeRun = undefined;
      respond(current.id, {
        protocolVersion,
        sessionId: current.params.sessionId,
        moduleId: current.params.moduleId,
        moduleGenerationId: current.params.moduleGenerationId,
        runId: current.params.runId,
        result:
          mode === "module-result-then-cancel"
            ? { schemaVersion: "dolly.module-result/1" }
            : { cancelled: true, reason: params.reason },
      });
    } else if (mode === "late-after-cancel" && activeRun?.id === params.requestId) {
      const current = activeRun;
      activeRun = undefined;
      setTimeout(() => {
        respond(current.id, {
          protocolVersion,
          sessionId: current.params.sessionId,
          moduleId: current.params.moduleId,
          moduleGenerationId: current.params.moduleGenerationId,
          runId: current.params.runId,
          result: { late: true },
        });
      }, 100);
    }
    return;
  }
  if (method === "module.stop") {
    respond(id, {
      protocolVersion,
      sessionId: params.sessionId,
      stopped: true,
    });
    return;
  }
  if (method === "dolly.shutdown") {
    respond(id, {
      protocolVersion,
      sessionId: params.sessionId,
      stopped: true,
    });
    setImmediate(() => process.exit(0));
  }
}

function handleMessage(message) {
  if (typeof message.id === "string" && (message.result !== undefined || message.error !== undefined)) {
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
    return;
  }
  if (typeof message.method === "string") void handleHostRequest(message);
}

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  while (inputBuffer.byteLength >= 4) {
    const length = inputBuffer.readUInt32BE(0);
    if (inputBuffer.byteLength < 4 + length) return;
    const payload = inputBuffer.subarray(4, 4 + length);
    inputBuffer = inputBuffer.subarray(4 + length);
    handleMessage(JSON.parse(payload.toString("utf8")));
  }
});

process.stdin.once("end", () => process.exit(0));
