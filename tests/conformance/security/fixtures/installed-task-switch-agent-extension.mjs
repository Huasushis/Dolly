import process from "node:process";

const PROTOCOL_VERSION = "3.0";
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
      message: "Installed task-switch Agent execution failed",
      data: { errorCode: "TASK_SWITCH_AGENT_FAILED", retryable: false },
    },
  });
}

function capability(type) {
  return initialized.capabilities.find((entry) => entry.capabilityType === type);
}

function invokeCapability(descriptor, operation, argumentsValue, run, effectKey) {
  const id = `installed-task-switch-capability-${++requestSequence}`;
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  send({
    jsonrpc: "2.0",
    id,
    method: "capability.invoke",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: initialized.sessionId,
      handle: descriptor.handle,
      operation,
      arguments: argumentsValue,
      moduleJobId: run.moduleJobId,
      runId: run.runId,
      idempotencyKey: `${run.moduleJobId}:${effectKey}`,
    },
  });
  return promise;
}

function exactObject(value, keys, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} is not one object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} keys do not match`);
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function taskPayload(input) {
  for (const group of input?.blockGroups ?? []) {
    const items = group?.block?.payload?.value?.items;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (item?.type !== "text" || typeof item.text !== "string") continue;
      const parsed = JSON.parse(item.text);
      const keys = parsed?.phase === "checkpoint"
        ? ["phase", "taskId", "checkpointKey", "checkpoint"]
        : parsed?.phase === "unrelated"
          ? ["phase", "taskId", "question"]
          : parsed?.phase === "resume"
            ? ["phase", "taskId", "request"]
            : undefined;
      if (!keys) throw new Error("task phase is unsupported");
      return exactObject(parsed, keys, "task input");
    }
  }
  throw new Error("task input contains no text payload");
}

function successfulModelOutput(result) {
  if (
    result?.schemaVersion !== "dolly.model-operation-result/1" ||
    result.status !== "succeeded" ||
    typeof result.output?.finalContent !== "string"
  ) {
    throw new Error("model operation did not return successful text");
  }
  const text = result.output.finalContent;
  if (text.includes("```")) throw new Error("model output is not bare JSON");
  return JSON.parse(text);
}

async function modelAction(run, task, checkpoint) {
  const model = capability("model-operation");
  if (!model || model.capabilityVersion !== "v2") {
    throw new Error("model-operation/v2 is absent");
  }
  const system = task.phase === "checkpoint"
    ? "Return one bare JSON object that copies this sourced task checkpoint into a store_checkpoint action."
    : task.phase === "unrelated"
      ? "Solve only this arithmetic task. Do not inspect or mention any prior task. Return one bare JSON answer action."
      : "Use only the Host-retrieved checkpoint evidence to resume the requested task. Return one bare JSON resume action.";
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
            text: JSON.stringify(checkpoint === undefined ? { task } : { task, checkpoint }),
          }],
        },
      ],
      reasoning: "disable",
      maxOutputTokens: 800,
      stream: true,
      outputContract: { kind: "json-object" },
    },
    run,
    `model:${task.phase}`,
  );
  return successfulModelOutput(result);
}

async function runAgent(run) {
  const task = taskPayload(run.input);
  const storage = capability("module-private-storage");
  if (!storage || storage.capabilityVersion !== "v2") {
    throw new Error("module-private-storage/v2 is absent");
  }

  if (task.phase === "checkpoint") {
    const action = exactObject(
      await modelAction(run, task),
      ["action", "taskId", "checkpointKey", "checkpoint"],
      "checkpoint action",
    );
    if (
      action.action !== "store_checkpoint" ||
      action.taskId !== task.taskId ||
      action.checkpointKey !== task.checkpointKey ||
      canonicalJson(action.checkpoint) !== canonicalJson(task.checkpoint)
    ) {
      throw new Error("model checkpoint action is not grounded in the current task");
    }
    const stored = await invokeCapability(
      storage,
      "set",
      { key: action.checkpointKey, value: action.checkpoint },
      run,
      "checkpoint:set",
    );
    if (stored?.schemaVersion !== "dolly.storage-set/1" || stored.stored !== true) {
      throw new Error("checkpoint was not stored");
    }
    return {
      phase: task.phase,
      actions: ["model", "storage.set"],
      final: {
        action: "checkpointed",
        taskId: task.taskId,
        checkpointKey: task.checkpointKey,
        stored: true,
      },
    };
  }

  if (task.phase === "unrelated") {
    const action = exactObject(
      await modelAction(run, task),
      ["action", "taskId", "answer"],
      "unrelated action",
    );
    if (action.action !== "answer" || action.taskId !== task.taskId || action.answer !== 17) {
      throw new Error("unrelated task answer is invalid");
    }
    return {
      phase: task.phase,
      actions: ["model"],
      final: action,
    };
  }

  const listed = await invokeCapability(
    storage,
    "list",
    { prefix: `task.${task.taskId}.`, limit: 1 },
    run,
    "checkpoint:list",
  );
  if (
    listed?.schemaVersion !== "dolly.storage-list/1" ||
    !Array.isArray(listed.keys) ||
    listed.keys.length !== 1 ||
    listed.truncated !== false
  ) {
    throw new Error("resume did not find exactly one task checkpoint");
  }
  const checkpointKey = listed.keys[0];
  const loaded = await invokeCapability(
    storage,
    "get",
    { key: checkpointKey },
    run,
    "checkpoint:get",
  );
  if (
    loaded?.schemaVersion !== "dolly.storage-get/1" ||
    loaded.found !== true ||
    loaded.value?.schemaVersion !== "dolly.task-checkpoint/1" ||
    loaded.value.taskId !== task.taskId
  ) {
    throw new Error("resume checkpoint is invalid");
  }
  const action = exactObject(
    await modelAction(run, task, { key: checkpointKey, value: loaded.value }),
    ["action", "taskId", "nextAction", "evidenceKeys"],
    "resume action",
  );
  if (
    action.action !== "resume" ||
    action.taskId !== task.taskId ||
    canonicalJson(action.nextAction) !== canonicalJson(loaded.value.nextAction) ||
    JSON.stringify(action.evidenceKeys) !== JSON.stringify([checkpointKey])
  ) {
    throw new Error("resume action is not grounded in the stored checkpoint");
  }
  return {
    phase: task.phase,
    actions: ["storage.list", "storage.get", "model"],
    final: action,
  };
}

async function handleRequest(message) {
  const { id, method, params } = message;
  if (method === "dolly.initialize") {
    initialized = params;
    respond(id, {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: params.sessionId,
      extensionId: params.extensionId,
      packageVersion: "1.0.0",
      moduleKinds: ["task-switch-agent"],
    });
    return;
  }
  if (method === "module.create") {
    respond(id, {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: params.sessionId,
      moduleId: params.moduleId,
      moduleGenerationId: params.moduleGenerationId,
    });
    return;
  }
  if (method === "module.execute") {
    const result = await runAgent(params);
    respond(id, {
      protocolVersion: PROTOCOL_VERSION,
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
              items: [{ type: "text", text: JSON.stringify(result), format: "plain" }],
            },
          },
        },
      },
    });
    return;
  }
  if (method === "module.stop") {
    respond(id, { protocolVersion: PROTOCOL_VERSION, sessionId: params.sessionId, stopped: true });
    return;
  }
  if (method === "dolly.shutdown") {
    respond(id, { protocolVersion: PROTOCOL_VERSION, sessionId: params.sessionId, stopped: true });
    setImmediate(() => process.exit(0));
  }
}

function receive(message) {
  if (typeof message.id === "string" && (message.result !== undefined || message.error !== undefined)) {
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
