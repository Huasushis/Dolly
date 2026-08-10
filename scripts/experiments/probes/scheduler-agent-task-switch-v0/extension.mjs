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

function respondError(id, errorCode = "AGENT_EXECUTION_FAILED") {
  send({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32_000,
      message: "Task-switch Agent execution failed",
      data: { errorCode, retryable: false },
    },
  });
}

function capability(type) {
  return initialized.capabilities.find((entry) => entry.capabilityType === type);
}

function invokeCapability(descriptor, operation, argumentsValue, run, effectKey) {
  const id = `task-switch-capability-${++requestSequence}`;
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

function parseJsonObject(text, keys, label) {
  if (typeof text !== "string" || text.trim() === "" || text.includes("```")) {
    throw new Error(`${label} is not bare JSON`);
  }
  return exactObject(JSON.parse(text), keys, label);
}

function modelOutput(result) {
  if (
    result?.schemaVersion !== "dolly.model-operation-result/1" ||
    result.status !== "succeeded" ||
    typeof result.output?.finalContent !== "string"
  ) {
    throw new Error("model operation did not return successful text");
  }
  return result.output;
}

function taskPayload(input) {
  for (const group of input?.blockGroups ?? []) {
    const items = group?.block?.payload?.value?.items;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (item?.type !== "text" || typeof item.text !== "string") continue;
      const parsed = JSON.parse(item.text);
      if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error("task input is not one object");
      }
      const keys = parsed.phase === "checkpoint"
        ? ["phase", "taskId", "checkpointKey", "checkpoint"]
        : parsed.phase === "unrelated"
          ? ["phase", "taskId", "question"]
          : parsed.phase === "resume"
            ? ["phase", "taskId", "request"]
            : undefined;
      if (!keys) throw new Error("task input phase is unsupported");
      return exactObject(
        parsed,
        keys,
        "task input",
      );
    }
  }
  throw new Error("task input has no text payload");
}

async function modelCall(run, purpose, messages, reasoning, outputKind, maxOutputTokens) {
  const model = capability("model-operation");
  if (!model || model.capabilityVersion !== "v2") {
    throw new Error("model-operation/v2 is absent");
  }
  const result = await invokeCapability(
    model,
    "chat",
    {
      messages,
      reasoning,
      maxOutputTokens,
      stream: false,
      outputContract: { kind: outputKind },
    },
    run,
    `model:${purpose}`,
  );
  return modelOutput(result);
}

async function plan(run, phase, task, registry) {
  const output = await modelCall(
    run,
    `${phase}:plan`,
    [
      {
        role: "system",
        parts: [{
          kind: "text",
          text: [
            "Plan one grounded task-memory action sequence.",
            "Use only the Host registry. Do not invent prior task state.",
            "Keep the final plan under 100 words.",
            `Registry: ${JSON.stringify(registry)}`,
          ].join(" "),
        }],
      },
      { role: "user", parts: [{ kind: "text", text: JSON.stringify(task) }] },
    ],
    "require",
    "text",
    5_200,
  );
  const observed =
    output.reasoning?.state === "observed" &&
    Array.isArray(output.reasoning.parts) &&
    output.reasoning.parts.some((part) => typeof part === "string" && part.length > 0);
  if (!observed || output.finalContent.trim() === "") {
    throw new Error("planning call returned no observed reasoning and final plan");
  }
  return { text: output.finalContent.trim(), reasoningObserved: true };
}

function registryView(value, moduleJobId) {
  const registry = exactObject(
    value,
    ["schemaVersion", "moduleJobId", "registryDigest", "budget", "tools"],
    "tool registry",
  );
  if (
    registry.schemaVersion !== "dolly.tool-registry-view/2" ||
    registry.moduleJobId !== moduleJobId ||
    typeof registry.registryDigest !== "string" ||
    !Array.isArray(registry.tools)
  ) {
    throw new Error("tool registry identity is invalid");
  }
  return registry;
}

function successfulToolResult(value, registry, callId, name, roundIndex) {
  if (
    value?.schemaVersion !== "dolly.tool-round-result/2" ||
    value.moduleJobId !== registry.moduleJobId ||
    value.registryDigest !== registry.registryDigest ||
    value.roundIndex !== roundIndex ||
    value.state !== "complete" ||
    value.canContinue !== true ||
    !Array.isArray(value.results) ||
    value.results.length !== 1
  ) {
    throw new Error("tool round result is incomplete");
  }
  const result = value.results[0];
  if (
    result?.callId !== callId ||
    result.name !== name ||
    result.status !== "succeeded" ||
    result.code !== "OK" ||
    !Object.hasOwn(result, "content")
  ) {
    throw new Error("tool call did not succeed");
  }
  return result.content;
}

async function executeTool(run, registry, roundIndex, action) {
  const tool = registry.tools.find((entry) => entry.name === action.action);
  if (!tool) throw new Error("model selected a tool outside the Host registry");
  const callId = `task-switch-tool-${roundIndex}`;
  const value = await invokeCapability(
    capability("tool-invocation"),
    "execute-round",
    {
      roundIndex,
      calls: [{
        callId,
        name: action.action,
        argumentsJson: JSON.stringify(action.arguments),
      }],
    },
    run,
    `tool-round:${roundIndex}`,
  );
  return {
    name: action.action,
    arguments: action.arguments,
    result: successfulToolResult(value, registry, callId, action.action, roundIndex),
  };
}

function actionPrompt(phase, registry, task, planText, observations) {
  const phaseRule = phase === "checkpoint"
    ? [
        "First call storage_set with the checkpointKey and exact checkpoint object from the task.",
        "After a successful store, return exactly {action:'checkpointed',taskId,checkpointKey,stored:true}.",
      ]
    : [
        "First call storage_list with the exact task prefix and limit 3.",
        "Then call storage_get with the returned checkpoint key.",
        "After a successful read, return exactly {action:'resumed',taskId,resumed:true,nextAction,evidenceKeys:[checkpointKey]} using nextAction verbatim from the checkpoint.",
      ];
  return [
    "You are a task-switching Agent using a Host-owned structured checkpoint store.",
    "Tool actions have exactly keys action,arguments. Final actions use only the keys specified below.",
    "Return one bare JSON object; no prose and no Markdown fence.",
    ...phaseRule,
    `Registry: ${JSON.stringify(registry)}`,
    `Task: ${JSON.stringify(task)}`,
    `Untrusted plan: ${JSON.stringify(planText)}`,
    `Successful observations: ${JSON.stringify(observations)}`,
  ].join(" ");
}

async function runTreatment(run, task) {
  if (task.phase === "unrelated") {
    const output = await modelCall(
      run,
      "unrelated:answer",
      [
        {
          role: "system",
          parts: [{
            kind: "text",
            text: "Solve only the current arithmetic task. Do not inspect memory. Return exactly {\"action\":\"answered\",\"taskId\":<taskId>,\"answer\":<integer>} as bare JSON.",
          }],
        },
        { role: "user", parts: [{ kind: "text", text: JSON.stringify(task) }] },
      ],
      "disable",
      "json-object",
      800,
    );
    const action = parseJsonObject(output.finalContent, ["action", "taskId", "answer"], "unrelated answer");
    if (action.action !== "answered" || action.taskId !== task.taskId || action.answer !== 17) {
      throw new Error("unrelated task answer is incorrect");
    }
    return { phase: task.phase, actions: ["answer"], final: action, reasoningObserved: [] };
  }

  const toolInvocation = capability("tool-invocation");
  if (!toolInvocation || toolInvocation.capabilityVersion !== "v2") {
    throw new Error("tool-invocation/v2 is absent");
  }
  const registry = registryView(
    await invokeCapability(toolInvocation, "list-tools", {}, run, "tool-registry"),
    run.moduleJobId,
  );
  const planned = await plan(run, task.phase, task, registry);
  const observations = [];
  const requiredRounds = task.phase === "checkpoint" ? 2 : 3;
  for (let modelRound = 1; modelRound <= requiredRounds; modelRound += 1) {
    const output = await modelCall(
      run,
      `${task.phase}:action:${modelRound}`,
      [
        {
          role: "system",
          parts: [{ kind: "text", text: actionPrompt(task.phase, registry, task, planned.text, observations) }],
        },
        { role: "user", parts: [{ kind: "text", text: JSON.stringify({ phase: task.phase }) }] },
      ],
      "disable",
      "json-object",
      1_200,
    );
    const raw = JSON.parse(output.finalContent);
    if (raw?.action === "checkpointed") {
      const final = exactObject(raw, ["action", "taskId", "checkpointKey", "stored"], "checkpoint final");
      if (
        task.phase !== "checkpoint" ||
        observations.length !== 1 ||
        final.taskId !== task.taskId ||
        final.checkpointKey !== task.checkpointKey ||
        final.stored !== true
      ) {
        throw new Error("checkpoint final action is invalid");
      }
      return {
        phase: task.phase,
        actions: [...observations.map((entry) => entry.name), "checkpointed"],
        final,
        reasoningObserved: [planned.reasoningObserved],
        registryDigest: registry.registryDigest,
      };
    }
    if (raw?.action === "resumed") {
      const final = exactObject(
        raw,
        ["action", "taskId", "resumed", "nextAction", "evidenceKeys"],
        "resume final",
      );
      if (
        task.phase !== "resume" ||
        observations.length !== 2 ||
        final.taskId !== task.taskId ||
        final.resumed !== true ||
        canonicalJson(final.nextAction) !== canonicalJson(observations[1]?.result?.value?.nextAction) ||
        JSON.stringify(final.evidenceKeys) !== JSON.stringify([observations[0]?.result?.keys?.[0]])
      ) {
        throw new Error("resume final action is not grounded in the checkpoint");
      }
      return {
        phase: task.phase,
        actions: [...observations.map((entry) => entry.name), "resumed"],
        final,
        reasoningObserved: [planned.reasoningObserved],
        registryDigest: registry.registryDigest,
      };
    }
    const action = exactObject(raw, ["action", "arguments"], "tool action");
    observations.push(await executeTool(run, registry, observations.length + 1, action));
  }
  throw new Error("task-switch Agent exhausted its action rounds");
}

async function runBaseline(run, task) {
  const contracts = task.phase === "checkpoint"
    ? "Return exactly {\"action\":\"checkpointed\",\"taskId\":<taskId>,\"checkpointKey\":null,\"stored\":false}."
    : task.phase === "unrelated"
      ? "Return exactly {\"action\":\"answered\",\"taskId\":<taskId>,\"answer\":17}."
      : "Return exactly {\"action\":\"resumed\",\"taskId\":<taskId>,\"resumed\":false,\"nextAction\":null,\"evidenceKeys\":[]}.";
  const output = await modelCall(
    run,
    `baseline:${task.phase}`,
    [
      {
        role: "system",
        parts: [{
          kind: "text",
          text: `You have no memory or tools. Use only the current message and never invent forgotten task state. ${contracts} Return bare JSON only.`,
        }],
      },
      { role: "user", parts: [{ kind: "text", text: JSON.stringify(task) }] },
    ],
    "disable",
    "json-object",
    800,
  );
  const expectedKeys = task.phase === "checkpoint"
    ? ["action", "taskId", "checkpointKey", "stored"]
    : task.phase === "unrelated"
      ? ["action", "taskId", "answer"]
      : ["action", "taskId", "resumed", "nextAction", "evidenceKeys"];
  const final = parseJsonObject(output.finalContent, expectedKeys, "baseline final");
  if (
    final.taskId !== task.taskId ||
    (task.phase === "checkpoint" && (final.stored !== false || final.checkpointKey !== null)) ||
    (task.phase === "unrelated" && final.answer !== 17) ||
    (task.phase === "resume" &&
      (final.resumed !== false || final.nextAction !== null || JSON.stringify(final.evidenceKeys) !== "[]"))
  ) {
    throw new Error("baseline final action is invalid");
  }
  return { phase: task.phase, actions: ["answer"], final, reasoningObserved: [] };
}

async function runAgent(run) {
  const task = taskPayload(run.input);
  return capability("tool-invocation")
    ? runTreatment(run, task)
    : runBaseline(run, task);
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
    const agentResult = await runAgent(params);
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
              items: [{ type: "text", text: JSON.stringify(agentResult), format: "plain" }],
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
