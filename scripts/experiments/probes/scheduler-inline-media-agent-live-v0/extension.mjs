import process from "node:process";

const protocolVersion = "3.0";
let initialized;
let inputBuffer = Buffer.alloc(0);
let requestSequence = 0;
const pending = new Map();

function send(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.byteLength, 0);
  process.stdout.write(Buffer.concat([header, payload]));
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, errorCode = "INLINE_MEDIA_AGENT_FAILED") {
  send({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32_000,
      message: "Inline Media Agent execution failed",
      data: { errorCode, retryable: false },
    },
  });
}

function modelCapability() {
  const model = initialized.capabilities.find(
    (entry) => entry.capabilityType === "model-operation",
  );
  if (!model || model.capabilityVersion !== "v3") {
    throw new Error("model-operation/v3 is absent");
  }
  return model;
}

function inputParts(input) {
  const textItems = [];
  const mediaItems = [];
  for (const group of input?.blockGroups ?? []) {
    const items = group?.block?.payload?.value?.items;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (item?.type === "text" && typeof item.text === "string") textItems.push(item);
      if (item?.type === "media-reference" && typeof item.mediaId === "string") {
        mediaItems.push(item);
      }
    }
  }
  if (textItems.length !== 1 || mediaItems.length !== 1) {
    throw new Error("Agent input must contain one text item and one Media reference");
  }
  return { text: textItems[0].text, mediaReference: mediaItems[0] };
}

function invokeModel(model, params, parts) {
  const id = `inline-media-capability-${++requestSequence}`;
  const operation = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
  send({
    jsonrpc: "2.0",
    id,
    method: "capability.invoke",
    params: {
      protocolVersion,
      sessionId: initialized.sessionId,
      handle: model.handle,
      operation: "chat",
      arguments: {
        messages: [{
          role: "user",
          parts: [
            { kind: "text", text: parts.text },
            {
              kind: "media",
              mediaReference: parts.mediaReference,
              requirementId: "aether-inline-png-v0",
            },
          ],
        }],
        outputContract: { kind: "json-object" },
        reasoning: "disable",
        maxOutputTokens: 1_200,
        stream: true,
      },
      moduleJobId: params.moduleJobId,
      runId: params.runId,
      idempotencyKey: `${params.moduleJobId}:inline-media-model`,
    },
  });
  return operation;
}

function parseModelResult(value) {
  if (
    value?.schemaVersion !== "dolly.model-operation-result/1" ||
    value.status !== "succeeded" ||
    typeof value.output?.finalContent !== "string" ||
    value.output.finishReason !== "stop"
  ) {
    throw new Error("model-operation/v3 did not return one successful terminal result");
  }
  const parsed = JSON.parse(value.output.finalContent);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("model output is not one JSON object");
  }
  return {
    parsed,
    finalContent: value.output.finalContent,
    finishReason: value.output.finishReason,
    reasoningState: value.output.reasoning?.state,
  };
}

async function handleRequest(message) {
  const { id, method, params } = message;
  if (method === "dolly.initialize") {
    initialized = params;
    respond(id, {
      protocolVersion,
      sessionId: params.sessionId,
      extensionId: params.extensionId,
      packageVersion: "1.0.0",
      moduleKinds: ["general-agent"],
    });
    return;
  }
  if (method === "module.create") {
    respond(id, {
      protocolVersion,
      sessionId: params.sessionId,
      moduleId: params.moduleId,
      moduleGenerationId: params.moduleGenerationId,
    });
    return;
  }
  if (method === "module.execute") {
    const model = modelCapability();
    const parts = inputParts(params.input);
    const result = parseModelResult(await invokeModel(model, params, parts));
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
              items: [{
                type: "text",
                format: "plain",
                text: JSON.stringify({
                  capabilityVersion: model.capabilityVersion,
                  strictStreamRequested: true,
                  childCredentialEnvironmentPresent:
                    Object.hasOwn(process.env, "AETHER_API_KEY") ||
                    Object.hasOwn(process.env, "AETHER_BASE_URL"),
                  ...result,
                }),
              }],
            },
          },
        },
      },
    });
    return;
  }
  if (method === "module.stop") {
    respond(id, { protocolVersion, sessionId: params.sessionId, stopped: true });
    return;
  }
  if (method === "dolly.shutdown") {
    respond(id, { protocolVersion, sessionId: params.sessionId, stopped: true });
    setImmediate(() => process.exit(0));
  }
}

function receive(message) {
  if (
    typeof message.id === "string" &&
    (message.result !== undefined || message.error !== undefined)
  ) {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error !== undefined) {
      entry.reject(new Error(message.error?.data?.errorCode ?? "capability failed"));
    } else {
      entry.resolve(message.result.value);
    }
    return;
  }
  if (typeof message.method === "string") {
    void handleRequest(message).catch(() => {
      if (typeof message.id === "string") respondError(message.id);
      else process.exit(31);
    });
  }
}

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  while (inputBuffer.byteLength >= 4) {
    const length = inputBuffer.readUInt32BE(0);
    if (length <= 0 || length > 1024 * 1024 || inputBuffer.byteLength < 4 + length) break;
    const payload = inputBuffer.subarray(4, 4 + length);
    inputBuffer = inputBuffer.subarray(4 + length);
    receive(JSON.parse(payload.toString("utf8")));
  }
});
