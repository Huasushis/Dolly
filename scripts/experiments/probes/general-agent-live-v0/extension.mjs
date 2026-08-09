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

function respondError(id) {
  send({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32_000,
      message: "Agent execution failed",
      data: { errorCode: "AGENT_EXECUTION_FAILED", retryable: false },
    },
  });
}

function capability(capabilityType) {
  return initialized.capabilities.find((entry) => entry.capabilityType === capabilityType);
}

function invokeCapability(descriptor, operation, argumentsValue, run, idempotencyKey) {
  const id = `agent-capability-${++requestSequence}`;
  const operationPromise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
  send({
    jsonrpc: "2.0",
    id,
    method: "capability.invoke",
    params: {
      protocolVersion,
      sessionId: initialized.sessionId,
      handle: descriptor.handle,
      operation,
      arguments: argumentsValue,
      moduleJobId: run.moduleJobId,
      runId: run.runId,
      idempotencyKey,
    },
  });
  return operationPromise;
}

function parseModelObject(text) {
  if (typeof text !== "string" || text.trim() === "") throw new Error("empty model content");
  let normalized = text.trim();
  const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/u.exec(normalized);
  if (fenced) normalized = fenced[1];
  else if (normalized.startsWith("```") || normalized.endsWith("```")) {
    throw new Error("model content contains an unsupported code fence");
  }
  const value = JSON.parse(normalized);
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("model content is not one JSON object");
  }
  return value;
}

function strictObject(text, allowed) {
  const value = parseModelObject(text);
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...allowed].sort())) {
    throw new Error("model content keys do not match the action contract");
  }
  return value;
}

function taskText(input) {
  for (const group of input?.blockGroups ?? []) {
    const items = group?.block?.payload?.value?.items;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (item?.type === "text" && typeof item.text === "string") return item.text;
    }
  }
  throw new Error("task input contains no text item");
}

function modelOutput(result) {
  if (
    result?.schemaVersion !== "dolly.model-operation-result/1" ||
    result.status !== "succeeded" ||
    typeof result.output?.finalContent !== "string"
  ) {
    throw new Error("model capability did not return a successful text result");
  }
  return result.output;
}

async function runAgent(params) {
  const model = capability("model-operation");
  if (!model) throw new Error("model-operation capability is absent");
  const storage = capability("module-private-storage");
  const task = taskText(params.input);
  const observations = [];
  const reasoningObserved = [];

  if (!storage) {
    const result = await invokeCapability(
      model,
      "chat",
      {
        messages: [
          {
            role: "system",
            parts: [{
              kind: "text",
              text: "You are a grounded task Agent. No tools or evidence are available. Never guess hidden values. Return exactly JSON with keys answer, grounded, evidenceKeys. grounded must be false and evidenceKeys must be an empty array.",
            }],
          },
          { role: "user", parts: [{ kind: "text", text: task }] },
        ],
        reasoning: "disable",
        maxOutputTokens: 800,
        stream: false,
      },
      params,
      `${params.moduleJobId}:model-baseline`,
    );
    const output = modelOutput(result);
    const answer = strictObject(output.finalContent, ["answer", "grounded", "evidenceKeys"]);
    return {
      conditionId: "no-storage-tool",
      task,
      actions: ["answer"],
      answer,
      reasoningObserved: output.reasoning?.state === "observed",
      childCredentialEnvironmentPresent:
        Object.hasOwn(process.env, "AETHER_API_KEY") ||
        Object.hasOwn(process.env, "AETHER_BASE_URL"),
    };
  }

  for (let round = 1; round <= 3; round += 1) {
    const system = [
      "You are a grounded task Agent with two private-memory tools.",
      "Available actions are storage.list with exactly arguments {\"prefix\":\"\",\"limit\":8}, storage.get with exactly arguments {\"key\":<one key returned by list>}, and answer.",
      "First list keys, then get the relevant key, then answer. Never guess hidden values.",
      "Return exactly one JSON object and no markdown.",
      "For a tool action use exactly keys action,arguments.",
      "For the final action use exactly keys action,answer,grounded,evidenceKeys.",
      "Keep internal reasoning under 120 words and reserve output budget for JSON.",
    ].join(" ");
    const result = await invokeCapability(
      model,
      "chat",
      {
        messages: [
          { role: "system", parts: [{ kind: "text", text: system }] },
          {
            role: "user",
            parts: [{
              kind: "text",
              text: JSON.stringify({ task, observations }),
            }],
          },
        ],
        reasoning: round === 1 ? "require" : "disable",
        maxOutputTokens: round === 1 ? 5200 : 800,
        stream: false,
      },
      params,
      `${params.moduleJobId}:model-round-${round}`,
    );
    const output = modelOutput(result);
    reasoningObserved.push(
      output.reasoning?.state === "observed" &&
      Array.isArray(output.reasoning.parts) &&
      output.reasoning.parts.some((part) => typeof part === "string" && part.length > 0),
    );
    const rawAction = parseModelObject(output.finalContent);
    if (rawAction?.action === "answer") {
      const action = strictObject(
        output.finalContent,
        ["action", "answer", "grounded", "evidenceKeys"],
      );
      if (!observations.some((entry) => entry.operation === "list")) {
        throw new Error("Agent answered before listing private memory");
      }
      if (!observations.some((entry) => entry.operation === "get")) {
        throw new Error("Agent answered before reading private memory");
      }
      return {
        conditionId: "private-storage-tool",
        task,
        actions: [...observations.map((entry) => `storage.${entry.operation}`), "answer"],
        answer: {
          answer: action.answer,
          grounded: action.grounded,
          evidenceKeys: action.evidenceKeys,
        },
        reasoningObserved,
        childCredentialEnvironmentPresent:
          Object.hasOwn(process.env, "AETHER_API_KEY") ||
          Object.hasOwn(process.env, "AETHER_BASE_URL"),
      };
    }
    const action = strictObject(output.finalContent, ["action", "arguments"]);
    if (action.action === "storage.list") {
      const toolResult = await invokeCapability(
        storage,
        "list",
        action.arguments,
        params,
        `${params.moduleJobId}:storage-list`,
      );
      observations.push({ operation: "list", result: toolResult });
      continue;
    }
    if (action.action === "storage.get") {
      const toolResult = await invokeCapability(
        storage,
        "get",
        action.arguments,
        params,
        `${params.moduleJobId}:storage-get`,
      );
      observations.push({ operation: "get", result: toolResult });
      continue;
    }
    throw new Error("model selected an unsupported action");
  }
  throw new Error("Agent exhausted its registered round budget without answering");
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
    const agentResult = await runAgent(params);
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
              items: [{ type: "text", text: JSON.stringify(agentResult), format: "plain" }],
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
  if (typeof message.id === "string" && (message.result !== undefined || message.error !== undefined)) {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error !== undefined) entry.reject(new Error(message.error?.data?.errorCode ?? "capability failed"));
    else entry.resolve(message.result.value);
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
