function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function closed(value, keys, label) {
  if (!object(value)) throw new Error(`${label} is not an object`);
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unsupported fields`);
}

function append(value, destination, state, label) {
  if (value === undefined || value === null) return;
  if (typeof value !== "string") throw new Error(`${label} delta is not a string`);
  if (state.finishReason !== null && value.length > 0) {
    throw new Error(`${label} arrived after finish_reason`);
  }
  state.outputBytes += Buffer.byteLength(value, "utf8");
  if (state.outputBytes > state.maximumOutputBytes) throw new Error("SSE output exceeded its byte limit");
  destination.push(value);
}

function acceptToolDelta(candidate, state) {
  closed(candidate, ["index", "id", "type", "function"], "SSE tool call");
  if (!Number.isSafeInteger(candidate.index) || candidate.index < 0 || candidate.index >= state.maximumToolCalls) {
    throw new Error("SSE tool-call index is invalid");
  }
  let current = state.toolCalls.get(candidate.index);
  if (current === undefined) {
    if (
      typeof candidate.id !== "string" || candidate.id.length === 0 ||
      candidate.type !== "function" ||
      !object(candidate.function) ||
      typeof candidate.function.name !== "string" || candidate.function.name.length === 0
    ) throw new Error("Initial SSE tool-call delta is incomplete");
    closed(candidate.function, ["name", "arguments"], "SSE tool function");
    current = {
      id: candidate.id,
      type: "function",
      name: candidate.function.name,
      argumentsParts: [],
    };
    state.toolCalls.set(candidate.index, current);
  } else {
    if (candidate.id !== undefined && candidate.id !== current.id) throw new Error("SSE tool-call id changed");
    if (candidate.type !== undefined && candidate.type !== "function") throw new Error("SSE tool-call type changed");
    if (candidate.function !== undefined) {
      closed(candidate.function, ["name", "arguments"], "SSE tool function");
      if (candidate.function.name !== undefined && candidate.function.name !== current.name) {
        throw new Error("SSE tool-call name changed");
      }
    }
  }
  append(candidate.function?.arguments, current.argumentsParts, state, "SSE tool arguments");
}

function acceptEvent(event, state) {
  state.eventCount += 1;
  if (state.eventCount > state.maximumEvents) throw new Error("SSE event count exceeded its limit");
  const data = [];
  for (const line of event.split(/\r?\n/u)) {
    if (line.startsWith(":")) continue;
    if (line === "event: message" || line === "event:message") continue;
    if (!line.startsWith("data:")) throw new Error("SSE event contains an unsupported field");
    data.push(line.slice(5).replace(/^ /u, ""));
  }
  if (data.length === 0) throw new Error("SSE event has no data field");
  const payload = data.join("\n");
  if (payload === "[DONE]") {
    state.doneCount += 1;
    if (state.doneCount !== 1 || state.finishReason === null || state.usage === null) {
      throw new Error("SSE DONE arrived without one finish reason and terminal usage");
    }
    state.done = true;
    return;
  }
  if (state.done) throw new Error("SSE data arrived after DONE");
  let envelope;
  try {
    envelope = JSON.parse(payload);
  } catch {
    throw new Error("SSE data is not JSON");
  }
  closed(envelope, ["id", "object", "created", "model", "system_fingerprint", "choices", "usage"], "SSE envelope");
  if (
    typeof envelope.id !== "string" || envelope.id.length === 0 ||
    envelope.object !== "chat.completion.chunk" ||
    !Number.isSafeInteger(envelope.created) ||
    typeof envelope.model !== "string" || envelope.model.length === 0 ||
    !Array.isArray(envelope.choices)
  ) throw new Error("SSE envelope identity is invalid");
  if (state.providerId === null) {
    state.providerId = envelope.id;
    state.model = envelope.model;
  } else if (state.providerId !== envelope.id || state.model !== envelope.model) {
    throw new Error("SSE provider identity changed");
  }
  if (envelope.usage !== undefined && envelope.usage !== null) {
    if (!object(envelope.usage) || state.usage !== null) throw new Error("SSE usage is duplicated or invalid");
    if (envelope.choices.length === 1) {
      const choice = envelope.choices[0];
      closed(choice, ["index", "delta", "finish_reason", "logprobs"], "SSE usage choice");
      closed(choice.delta, [], "SSE usage delta");
      if (choice.index !== 0 || (choice.finish_reason !== undefined && choice.finish_reason !== null)) {
        throw new Error("SSE usage choice is invalid");
      }
    } else if (envelope.choices.length !== 0) throw new Error("SSE usage choice count is invalid");
    state.usage = envelope.usage;
    state.usageEventCount += 1;
    return;
  }
  if (envelope.choices.length !== 1) throw new Error("SSE choice count is invalid");
  const choice = envelope.choices[0];
  closed(choice, ["index", "delta", "finish_reason", "logprobs"], "SSE choice");
  if (choice.index !== 0) throw new Error("SSE choice index is invalid");
  closed(choice.delta, ["role", "content", "reasoning_content", "tool_calls", "refusal"], "SSE delta");
  if (choice.delta.role !== undefined && choice.delta.role !== "assistant") throw new Error("SSE role is invalid");
  if (choice.delta.refusal !== undefined && choice.delta.refusal !== null) throw new Error("SSE refusal is unsupported");
  append(choice.delta.content, state.contentParts, state, "SSE content");
  append(choice.delta.reasoning_content, state.reasoningParts, state, "SSE reasoning");
  if (choice.delta.tool_calls !== undefined) {
    if (!Array.isArray(choice.delta.tool_calls) || choice.delta.tool_calls.length === 0) {
      throw new Error("SSE tool_calls delta is invalid");
    }
    for (const toolCall of choice.delta.tool_calls) acceptToolDelta(toolCall, state);
  }
  if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
    if (
      typeof choice.finish_reason !== "string" || choice.finish_reason.length === 0 ||
      (state.finishReason !== null && state.finishReason !== choice.finish_reason)
    ) throw new Error("SSE finish_reason is invalid");
    state.finishReason = choice.finish_reason;
  }
}

export async function readStrictOpenAiToolSse(response, options = {}) {
  const limits = {
    maximumResponseBytes: options.maximumResponseBytes ?? 2 * 1024 * 1024,
    maximumBufferedBytes: options.maximumBufferedBytes ?? 256 * 1024,
    maximumOutputBytes: options.maximumOutputBytes ?? 512 * 1024,
    maximumEvents: options.maximumEvents ?? 20_000,
    maximumToolCalls: options.maximumToolCalls ?? 32,
  };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${key} must be positive`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^text\/event-stream(?:\s*;|$)/iu.test(contentType)) throw new Error("Streaming response is not SSE");
  if (response.body === null) throw new Error("Streaming response has no body");
  const state = {
    contentParts: [],
    reasoningParts: [],
    toolCalls: new Map(),
    outputBytes: 0,
    eventCount: 0,
    usageEventCount: 0,
    doneCount: 0,
    providerId: null,
    model: null,
    finishReason: null,
    usage: null,
    done: false,
    ...limits,
  };
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let responseBytes = 0;
  let buffer = "";
  const drain = () => {
    for (;;) {
      const match = /\r?\n\r?\n/u.exec(buffer);
      if (!match || match.index === undefined) return;
      const event = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (event.trim().length > 0) acceptEvent(event, state);
      if (state.done && buffer.trim().length > 0) throw new Error("SSE bytes arrived after DONE");
    }
  };
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    responseBytes += item.value.byteLength;
    if (responseBytes > limits.maximumResponseBytes) {
      await reader.cancel("response limit exceeded");
      throw new Error("SSE response exceeded its byte limit");
    }
    buffer += decoder.decode(item.value, { stream: true });
    if (Buffer.byteLength(buffer, "utf8") > limits.maximumBufferedBytes) {
      await reader.cancel("buffer limit exceeded");
      throw new Error("SSE buffered event exceeded its byte limit");
    }
    drain();
  }
  buffer += decoder.decode();
  drain();
  if (buffer.trim().length > 0) throw new Error("SSE response ended mid-event");
  if (!state.done || state.doneCount !== 1 || state.usageEventCount !== 1) {
    throw new Error("SSE response lacks unique usage or DONE");
  }
  const indices = [...state.toolCalls.keys()].sort((left, right) => left - right);
  if (indices.some((value, index) => value !== index)) throw new Error("SSE tool-call indices are not contiguous");
  const toolCalls = indices.map((index) => {
    const entry = state.toolCalls.get(index);
    const argumentsText = entry.argumentsParts.join("");
    try {
      JSON.parse(argumentsText);
    } catch {
      throw new Error("SSE tool-call arguments are not complete JSON");
    }
    return {
      id: entry.id,
      type: "function",
      function: { name: entry.name, arguments: argumentsText },
    };
  });
  if ((state.finishReason === "tool_calls") !== (toolCalls.length > 0)) {
    throw new Error("SSE finish reason does not match reconstructed tool calls");
  }
  return {
    body: {
      model: state.model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: state.contentParts.join("") || null,
          reasoning_content: state.reasoningParts.join(""),
          ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
        },
        finish_reason: state.finishReason,
      }],
      usage: state.usage,
    },
    evidence: {
      contentType,
      responseBytes,
      eventCount: state.eventCount,
      usageEventCount: state.usageEventCount,
      doneCount: state.doneCount,
      toolCallCount: toolCalls.length,
      providerIdObserved: state.providerId !== null,
    },
  };
}
