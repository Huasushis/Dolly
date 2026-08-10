let initialized;
let inputBuffer = Buffer.alloc(0);
let executionCount = 0;

function send(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.byteLength, 0);
  process.stdout.write(Buffer.concat([header, payload]));
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function handle(message) {
  const { id, method, params } = message;
  if (method === "dolly.initialize") {
    initialized = params;
    respond(id, {
      protocolVersion: "3.0",
      sessionId: params.sessionId,
      extensionId: "org.example.scheduler-installed",
      packageVersion: "1.0.0",
      moduleKinds: ["transform"],
    });
    return;
  }
  if (method === "module.create") {
    respond(id, {
      protocolVersion: "3.0",
      sessionId: params.sessionId,
      moduleId: params.moduleId,
      moduleGenerationId: params.moduleGenerationId,
    });
    return;
  }
  if (method === "module.execute") {
    executionCount += 1;
    respond(id, {
      protocolVersion: "3.0",
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
              items: [{
                type: "text",
                text: `${initialized.config.prefix}:${params.input.blockGroups.length}:run-${executionCount}`,
              }],
            },
          },
        },
      },
    });
    return;
  }
  if (method === "module.stop") {
    respond(id, {
      protocolVersion: "3.0",
      sessionId: params.sessionId,
      stopped: true,
    });
    return;
  }
  if (method === "dolly.shutdown") {
    respond(id, {
      protocolVersion: "3.0",
      sessionId: params.sessionId,
      stopped: true,
    });
    setImmediate(() => process.exit(0));
  }
}

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  while (inputBuffer.byteLength >= 4) {
    const length = inputBuffer.readUInt32BE(0);
    if (inputBuffer.byteLength < 4 + length) return;
    const payload = inputBuffer.subarray(4, 4 + length);
    inputBuffer = inputBuffer.subarray(4 + length);
    handle(JSON.parse(payload.toString("utf8")));
  }
});

process.stdin.once("end", () => process.exit(0));
