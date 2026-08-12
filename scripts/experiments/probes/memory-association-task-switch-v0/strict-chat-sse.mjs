function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  if (!plainObject(value)) throw new Error(`${label} is not an object`);
  const permitted = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !permitted.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unsupported fields: ${unknown.join(', ')}`);
}

function appendDelta(value, parts, label, state) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') throw new Error(`SSE ${label} delta is not a string`);
  if (state.finishReason !== null && value.length > 0) {
    throw new Error(`SSE ${label} arrived after finish_reason`);
  }
  state.outputBytes += Buffer.byteLength(value, 'utf8');
  if (state.outputBytes > state.maximumOutputBytes) {
    throw new Error('SSE reconstructed output exceeded its byte limit');
  }
  parts.push(value);
}

function acceptEvent(event, state) {
  state.eventCount += 1;
  if (state.eventCount > state.maximumEvents) throw new Error('SSE event count exceeded its limit');
  const data = [];
  for (const line of event.split(/\r?\n/u)) {
    if (line.startsWith(':')) continue;
    if (line === 'event: message' || line === 'event:message') continue;
    if (!line.startsWith('data:')) throw new Error('SSE event contains an unsupported field');
    data.push(line.slice(5).replace(/^ /u, ''));
  }
  if (data.length === 0) throw new Error('SSE event has no data field');
  const payload = data.join('\n');
  if (payload === '[DONE]') {
    state.doneCount += 1;
    if (state.doneCount !== 1 || state.finishReason === null || state.usage === null) {
      throw new Error('SSE [DONE] arrived without one finish reason and terminal usage');
    }
    state.done = true;
    return;
  }
  if (state.done) throw new Error('SSE data arrived after [DONE]');
  let envelope;
  try {
    envelope = JSON.parse(payload);
  } catch {
    throw new Error('SSE data is not JSON');
  }
  exactKeys(envelope, ['id', 'object', 'created', 'model', 'system_fingerprint', 'choices', 'usage'], 'SSE envelope');
  if (
    typeof envelope.id !== 'string' || envelope.id.length === 0 ||
    envelope.object !== 'chat.completion.chunk' ||
    !Number.isSafeInteger(envelope.created) ||
    typeof envelope.model !== 'string' || envelope.model.length === 0 ||
    !Array.isArray(envelope.choices)
  ) {
    throw new Error('SSE envelope identity is invalid');
  }
  if (state.providerId === null) {
    state.providerId = envelope.id;
    state.model = envelope.model;
  } else if (state.providerId !== envelope.id || state.model !== envelope.model) {
    throw new Error('SSE provider identity changed');
  }
  if (envelope.usage !== undefined && envelope.usage !== null) {
    if (!plainObject(envelope.usage) || state.usage !== null) {
      throw new Error('SSE stream must carry exactly one usage object');
    }
    if (envelope.choices.length === 1) {
      const usageChoice = envelope.choices[0];
      exactKeys(usageChoice, ['index', 'delta', 'finish_reason', 'logprobs'], 'SSE usage choice');
      exactKeys(usageChoice.delta, [], 'SSE usage delta');
      if (
        usageChoice.index !== 0 ||
        (usageChoice.finish_reason !== undefined && usageChoice.finish_reason !== null) ||
        (usageChoice.logprobs !== undefined && usageChoice.logprobs !== null)
      ) {
        throw new Error('SSE usage choice must be the measured empty delta');
      }
    } else if (envelope.choices.length !== 0) {
      throw new Error('SSE usage event choice count is invalid');
    }
    state.usage = envelope.usage;
    state.usageEventCount += 1;
    return;
  }
  if (envelope.choices.length !== 1) throw new Error('SSE choice count is invalid');
  const choice = envelope.choices[0];
  exactKeys(choice, ['index', 'delta', 'finish_reason', 'logprobs'], 'SSE choice');
  if (choice.index !== 0) throw new Error('SSE choice index is invalid');
  exactKeys(choice.delta, ['role', 'content', 'reasoning_content', 'tool_calls', 'refusal'], 'SSE delta');
  if (choice.delta.role !== undefined && choice.delta.role !== 'assistant') {
    throw new Error('SSE delta role is invalid');
  }
  if (choice.delta.tool_calls !== undefined || choice.delta.refusal !== undefined) {
    throw new Error('SSE tool calls and refusal are outside this Memory probe');
  }
  appendDelta(choice.delta.content, state.contentParts, 'content', state);
  appendDelta(choice.delta.reasoning_content, state.reasoningParts, 'reasoning', state);
  if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
    if (
      typeof choice.finish_reason !== 'string' || choice.finish_reason.length === 0 ||
      (state.finishReason !== null && state.finishReason !== choice.finish_reason)
    ) {
      throw new Error('SSE finish_reason is invalid');
    }
    state.finishReason = choice.finish_reason;
  }
}

export async function readStrictChatCompletionSse(response, options = {}) {
  const maximumResponseBytes = options.maximumResponseBytes ?? 2 * 1024 * 1024;
  const maximumBufferedBytes = options.maximumBufferedBytes ?? 256 * 1024;
  const maximumOutputBytes = options.maximumOutputBytes ?? 512 * 1024;
  const maximumEvents = options.maximumEvents ?? 20_000;
  for (const [label, value] of Object.entries({
    maximumResponseBytes,
    maximumBufferedBytes,
    maximumOutputBytes,
    maximumEvents,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be positive`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!/^text\/event-stream(?:\s*;|$)/iu.test(contentType)) {
    throw new Error('A successful streaming response must be text/event-stream');
  }
  if (response.body === null) throw new Error('A successful streaming response has no body');
  const state = {
    contentParts: [],
    reasoningParts: [],
    outputBytes: 0,
    maximumOutputBytes,
    maximumEvents,
    eventCount: 0,
    usageEventCount: 0,
    doneCount: 0,
    providerId: null,
    model: null,
    finishReason: null,
    usage: null,
    done: false,
  };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const reader = response.body.getReader();
  let buffer = '';
  let responseBytes = 0;
  const drain = () => {
    for (;;) {
      const match = /\r?\n\r?\n/u.exec(buffer);
      if (!match || match.index === undefined) return;
      const event = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (event.trim().length !== 0) acceptEvent(event, state);
      if (state.done && buffer.trim().length !== 0) throw new Error('SSE bytes arrived after [DONE]');
    }
  };
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    responseBytes += item.value.byteLength;
    if (responseBytes > maximumResponseBytes) {
      await reader.cancel('response byte limit exceeded');
      throw new Error('SSE response exceeded its byte limit');
    }
    buffer += decoder.decode(item.value, { stream: true });
    if (Buffer.byteLength(buffer, 'utf8') > maximumBufferedBytes) {
      await reader.cancel('buffer byte limit exceeded');
      throw new Error('SSE buffered event exceeded its byte limit');
    }
    drain();
  }
  buffer += decoder.decode();
  drain();
  if (buffer.trim().length !== 0) throw new Error('SSE response ended mid-event');
  if (!state.done || state.doneCount !== 1 || state.usageEventCount !== 1) {
    throw new Error('SSE response is missing its unique usage event or [DONE]');
  }
  return {
    body: {
      model: state.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: state.contentParts.join(''),
          reasoning_content: state.reasoningParts.join(''),
        },
        finish_reason: state.finishReason,
      }],
      usage: state.usage,
      error: null,
    },
    evidence: {
      contentType,
      responseBytes,
      eventCount: state.eventCount,
      usageEventCount: state.usageEventCount,
      doneCount: state.doneCount,
      providerIdObserved: state.providerId !== null,
    },
  };
}

export async function readBoundedResponseText(response, maximumBytes = 2 * 1024 * 1024) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new TypeError('maximumBytes must be positive');
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let result = '';
  let observed = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    observed += item.value.byteLength;
    if (observed > maximumBytes) {
      await reader.cancel('response byte limit exceeded');
      throw new Error('Response exceeded its byte limit');
    }
    result += decoder.decode(item.value, { stream: true });
  }
  return result + decoder.decode();
}
