import { canonicalJson, ProbeError, sha256 } from "./common.mjs";
import { readStrictChatCompletionSse } from "../memory-association-task-switch-v0/strict-chat-sse.mjs";

export const AETHER_MODEL_ID = "qwen3.6-27b";
export const IMAGE_TASK_PROMPT = [
  "你是一个通用代理。只依据本消息附带的图片作答；不要从问题猜测图片内容。",
  "返回一个 JSON 对象，不要使用 Markdown。对象必须严格包含：",
  "title（字符串）、visualNonce（字符串）、boxes（从左到右三个对象，每个对象严格包含 color、label、number）、checksum（三个 number 之和）、answerToken（按图片底部规则计算）。",
  "color 使用小写英文。不要省略任何字段。",
].join("\n");
export const FOLLOWUP_PROMPT = [
  "继续使用上一张图片，不要改写先前答案。",
  "计算 (ALPHA 的 number × GAMMA 的 number) - BETA 的 number。",
  "只返回 JSON：{\"followup\":整数}。",
].join("\n");

function configuredBaseUrl(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProbeError("AETHER_CONFIGURATION_MISSING", "AETHER_BASE_URL is absent");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ProbeError("AETHER_CONFIGURATION_INVALID", "AETHER_BASE_URL is not a valid URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ProbeError("AETHER_CONFIGURATION_INVALID", "AETHER_BASE_URL contains forbidden credentials or query data");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
    throw new ProbeError("AETHER_CONFIGURATION_INVALID", "AETHER_BASE_URL must use HTTPS outside loopback");
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "")}/v1/`;
  return url;
}

function route(baseUrl, suffix) {
  const url = new URL(baseUrl.href);
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/${suffix}`.replace(/\/+/gu, "/");
  url.search = "";
  url.hash = "";
  return url;
}

export function loadAetherConfiguration() {
  if (process.env.RUN_LIVE_INTEGRATION !== "1" || process.env.RUN_PAID_INTEGRATION !== "1") {
    throw new ProbeError(
      "AETHER_LIVE_OPT_IN_REQUIRED",
      "Both live and paid integration opt-ins are required",
    );
  }
  const baseUrl = configuredBaseUrl(process.env.AETHER_BASE_URL);
  const apiKey = process.env.AETHER_API_KEY;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new ProbeError("AETHER_CONFIGURATION_MISSING", "AETHER_API_KEY is absent");
  }
  return {
    baseUrl,
    apiKey,
    publicSummary: {
      configured: true,
      scheme: baseUrl.protocol,
      endpointRecorded: false,
      credentialRecorded: false,
      modelId: AETHER_MODEL_ID,
    },
  };
}

async function boundedResponse(response, maximumBytes = 2_000_000) {
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maximumBytes) {
    throw new ProbeError("AETHER_RESPONSE_LIMIT_EXCEEDED", "Aether response exceeded the probe byte limit", {
      byteLength: buffer.byteLength,
      maximumBytes,
    });
  }
  try {
    return { body: JSON.parse(buffer.toString("utf8")), byteLength: buffer.byteLength };
  } catch {
    throw new ProbeError("AETHER_RESPONSE_INVALID", "Aether response was not JSON", {
      status: response.status,
      byteLength: buffer.byteLength,
      digest: sha256(buffer),
    });
  }
}

async function requestWithTimeout(url, options, timeoutMs = 120_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: "error" });
  } catch (error) {
    throw new ProbeError(
      error?.name === "AbortError" ? "AETHER_DEADLINE_EXCEEDED" : "AETHER_TRANSPORT_FAILED",
      "Aether request failed before a bounded response was received",
      { errorName: error instanceof Error ? error.name : "unknown" },
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function probeAetherModels(configuration) {
  const response = await requestWithTimeout(route(configuration.baseUrl, "models"), {
    method: "GET",
    headers: { authorization: `Bearer ${configuration.apiKey}` },
  }, 30_000);
  const decoded = await boundedResponse(response);
  const modelIds = Array.isArray(decoded.body?.data)
    ? decoded.body.data.map((entry) => entry?.id).filter((id) => typeof id === "string")
    : [];
  return {
    status: response.status,
    responseBytes: decoded.byteLength,
    targetModelPresent: modelIds.includes(AETHER_MODEL_ID),
    modelCount: modelIds.length,
    modelIds,
  };
}

function publicMessage(message) {
  if (message === null || typeof message !== "object") return null;
  const content = typeof message.content === "string" ? message.content : null;
  const reasoningContent = typeof message.reasoning_content === "string"
    ? message.reasoning_content
    : null;
  return {
    role: typeof message.role === "string" ? message.role : null,
    content,
    reasoningObserved: typeof reasoningContent === "string" && reasoningContent.trim().length > 0,
    reasoningLength: typeof reasoningContent === "string" ? reasoningContent.length : 0,
  };
}

export function buildAetherChatRequest(messages, maximumOutputTokens = 1_200) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ProbeError("AETHER_REQUEST_INVALID", "Aether messages must be a non-empty array");
  }
  if (!Number.isSafeInteger(maximumOutputTokens) || maximumOutputTokens <= 0) {
    throw new ProbeError("AETHER_REQUEST_INVALID", "Aether output-token limit must be positive");
  }
  return {
    model: AETHER_MODEL_ID,
    messages,
    thinking: { type: "disabled" },
    stream: true,
    stream_options: { include_usage: true },
    response_format: { type: "json_object" },
    temperature: 0,
    max_tokens: maximumOutputTokens,
  };
}

function publicResponse(status, decoded) {
  if (status < 200 || status >= 300) {
    const error = decoded.body?.error;
    const message = typeof error?.message === "string" ? error.message : "";
    return {
      status,
      responseBytes: decoded.byteLength,
      error: {
        code: typeof error?.code === "string" ? error.code : null,
        type: typeof error?.type === "string" ? error.type : null,
        messageLength: message.length,
        messageDigest: sha256(Buffer.from(message, "utf8")),
      },
    };
  }
  const choice = decoded.body?.choices?.[0];
  return {
    status,
    responseBytes: decoded.byteLength,
    model: typeof decoded.body?.model === "string" ? decoded.body.model : null,
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
    message: publicMessage(choice?.message),
    usage: decoded.body?.usage && typeof decoded.body.usage === "object"
      ? {
          promptTokens: Number.isFinite(decoded.body.usage.prompt_tokens) ? decoded.body.usage.prompt_tokens : null,
          completionTokens: Number.isFinite(decoded.body.usage.completion_tokens) ? decoded.body.usage.completion_tokens : null,
          totalTokens: Number.isFinite(decoded.body.usage.total_tokens) ? decoded.body.usage.total_tokens : null,
        }
      : null,
  };
}

export async function callAetherChat(configuration, body) {
  if (
    body?.stream !== true ||
    body?.stream_options?.include_usage !== true ||
    body?.thinking?.type !== "disabled" ||
    Object.hasOwn(body, "enable_thinking")
  ) {
    throw new ProbeError(
      "AETHER_STREAM_PROFILE_REQUIRED",
      "Aether generation requires strict streaming, terminal usage, and no enable_thinking field",
    );
  }
  const requestText = canonicalJson(body);
  const response = await requestWithTimeout(route(configuration.baseUrl, "chat/completions"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${configuration.apiKey}`,
      "content-type": "application/json",
    },
    body: requestText,
  }, 1_800_000);
  if (!response.ok) {
    const decoded = await boundedResponse(response);
    return {
      requestDigest: sha256(Buffer.from(requestText, "utf8")),
      requestBytes: Buffer.byteLength(requestText, "utf8"),
      response: publicResponse(response.status, decoded),
      streamEvidence: null,
    };
  }
  let decoded;
  try {
    decoded = await readStrictChatCompletionSse(response, {
      maximumResponseBytes: 2_000_000,
      maximumBufferedBytes: 256_000,
      maximumOutputBytes: 512_000,
      maximumEvents: 20_000,
    });
  } catch (error) {
    throw new ProbeError("AETHER_STREAM_INVALID", "Aether response failed strict SSE validation", {
      errorName: error instanceof Error ? error.name : "unknown",
    });
  }
  return {
    requestDigest: sha256(Buffer.from(requestText, "utf8")),
    requestBytes: Buffer.byteLength(requestText, "utf8"),
    response: publicResponse(response.status, {
      body: decoded.body,
      byteLength: decoded.evidence.responseBytes,
    }),
    streamEvidence: decoded.evidence,
  };
}

function extractJsonObject(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  try {
    return JSON.parse(trimmed.slice(first, last + 1));
  } catch {
    return null;
  }
}

export const IMAGE_ANSWER_KEY = Object.freeze({
  title: "DOLLY VISUAL CHECK",
  visualNonce: "K8M2",
  boxes: Object.freeze([
    Object.freeze({ color: "red", label: "ALPHA", number: 7 }),
    Object.freeze({ color: "blue", label: "BETA", number: 4 }),
    Object.freeze({ color: "green", label: "GAMMA", number: 9 }),
  ]),
  checksum: 20,
  answerToken: 12,
});

export function evaluateImageAnswer(content) {
  const parsed = extractJsonObject(content);
  const exact = parsed !== null && canonicalJson(parsed) === canonicalJson(IMAGE_ANSWER_KEY);
  return { parsed, exact };
}

export function evaluateFollowupAnswer(content) {
  const parsed = extractJsonObject(content);
  return { parsed, exact: parsed !== null && canonicalJson(parsed) === canonicalJson({ followup: 59 }) };
}
