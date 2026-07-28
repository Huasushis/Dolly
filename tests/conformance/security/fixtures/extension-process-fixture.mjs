import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { spawn } from "node:child_process";

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

async function invokeCapability(handle, operation = "read") {
  return request("capability.invoke", {
    protocolVersion,
    sessionId: initialized.sessionId,
    handle,
    operation,
    arguments: { key: "fixture-key" },
    ...(mode === "old-module-job-field"
      ? { processingId: "module-job-capability" }
      : { moduleJobId: "module-job-capability" }),
    ...(mode === "capability-missing-run-id" ? {} : { runId: "run-capability" }),
    idempotencyKey: "fixture-effect",
  });
}

function capabilityErrorCodeOf(response) {
  return response.result?.value ?? {
    capabilityErrorCode: response.error?.data?.errorCode ?? "unknown",
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
    if (mode === "module-result-then-cancel") {
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
      mode === "stale-capability" ||
      mode === "old-module-job-field" ||
      mode === "capability-missing-run-id"
    ) {
      const handle =
        mode === "stale-capability"
          ? initialized.config.staleHandle
          : initialized.capabilities[0].handle;
      const capabilityResponse = await invokeCapability(handle);
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
    respond(id, {
      protocolVersion,
      sessionId: params.sessionId,
      moduleId: params.moduleId,
      moduleGenerationId: params.moduleGenerationId,
      runId: mode === "stale-result" ? "stale-run" : params.runId,
      result: { ok: true, input: params.input },
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
