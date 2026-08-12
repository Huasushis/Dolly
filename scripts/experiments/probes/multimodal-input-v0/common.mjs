import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { relative, resolve, sep } from "node:path";
import { createServer } from "node:http";
import sharp from "sharp";

export const EXPERIMENT_ID = "multimodal-input-v0";
export const FIXED_SEED = 20260809;
export const FIXTURE_SIGNING_KEY =
  "multimodal-input-v0-public-test-key-not-a-secret";
export const BASE_CLOCK_SECONDS = 1_800_000_000;
export const MAX_TOOL_CHUNK_BYTES = 64;

export class ProbeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ProbeError";
    this.code = code;
    this.details = details;
  }
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function byteLengthJson(value) {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

function rawPixels(width, height, version, noisy = false) {
  const bytes = Buffer.alloc(width * height * 3);
  let state = FIXED_SEED ^ (version * 0x9e3779b9);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      if (noisy) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        bytes[offset] = state & 0xff;
        bytes[offset + 1] = (state >>> 8) & 0xff;
        bytes[offset + 2] = (state >>> 16) & 0xff;
      } else {
        bytes[offset] = (x * 31 + version * 47) & 0xff;
        bytes[offset + 1] = (y * 43 + version * 61) & 0xff;
        bytes[offset + 2] = ((x + y) * 19 + version * 73) & 0xff;
      }
    }
  }
  return bytes;
}

export async function generateFixtures() {
  const width = 8;
  const height = 6;
  const v1Raw = rawPixels(width, height, 1);
  const v2Raw = rawPixels(width, height, 2);
  const pngOptions = { compressionLevel: 9, adaptiveFiltering: false };
  const pngV1 = await sharp(v1Raw, { raw: { width, height, channels: 3 } })
    .png(pngOptions)
    .toBuffer();
  const pngV2 = await sharp(v2Raw, { raw: { width, height, channels: 3 } })
    .png(pngOptions)
    .toBuffer();
  const webpV1 = await sharp(v1Raw, { raw: { width, height, channels: 3 } })
    .webp({ lossless: true })
    .toBuffer();
  const largeWidth = 48;
  const largeHeight = 48;
  const largePng = await sharp(
    rawPixels(largeWidth, largeHeight, 3, true),
    { raw: { width: largeWidth, height: largeHeight, channels: 3 } },
  )
    .png({ compressionLevel: 0, adaptiveFiltering: false })
    .toBuffer();
  const crop = { left: 2, top: 1, width: 3, height: 2 };
  const croppedV1 = await sharp(pngV1, { failOn: "error" })
    .extract(crop)
    .png(pngOptions)
    .toBuffer();
  const agentTaskSvg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">
      <rect width="640" height="360" fill="#ffffff"/>
      <text x="320" y="45" text-anchor="middle" font-family="DejaVu Sans" font-size="28" font-weight="bold" fill="#111827">DOLLY VISUAL CHECK</text>
      <text x="320" y="75" text-anchor="middle" font-family="DejaVu Sans" font-size="18" fill="#374151">Visual nonce: K8M2</text>
      <rect x="45" y="115" width="150" height="120" rx="12" fill="#dc2626" stroke="#7f1d1d" stroke-width="4"/>
      <rect x="245" y="115" width="150" height="120" rx="12" fill="#2563eb" stroke="#1e3a8a" stroke-width="4"/>
      <rect x="445" y="115" width="150" height="120" rx="12" fill="#16a34a" stroke="#14532d" stroke-width="4"/>
      <text x="120" y="160" text-anchor="middle" font-family="DejaVu Sans" font-size="22" font-weight="bold" fill="white">ALPHA</text>
      <text x="120" y="210" text-anchor="middle" font-family="DejaVu Sans" font-size="42" font-weight="bold" fill="white">7</text>
      <text x="320" y="160" text-anchor="middle" font-family="DejaVu Sans" font-size="22" font-weight="bold" fill="white">BETA</text>
      <text x="320" y="210" text-anchor="middle" font-family="DejaVu Sans" font-size="42" font-weight="bold" fill="white">4</text>
      <text x="520" y="160" text-anchor="middle" font-family="DejaVu Sans" font-size="22" font-weight="bold" fill="white">GAMMA</text>
      <text x="520" y="210" text-anchor="middle" font-family="DejaVu Sans" font-size="42" font-weight="bold" fill="white">9</text>
      <path d="M200 175 L235 175" stroke="#111827" stroke-width="6"/>
      <path d="M225 164 L238 175 L225 186" fill="none" stroke="#111827" stroke-width="6"/>
      <path d="M400 175 L435 175" stroke="#111827" stroke-width="6"/>
      <path d="M425 164 L438 175 L425 186" fill="none" stroke="#111827" stroke-width="6"/>
      <rect x="95" y="275" width="450" height="52" rx="8" fill="#f3f4f6" stroke="#4b5563" stroke-width="2"/>
      <text x="320" y="307" text-anchor="middle" font-family="DejaVu Sans" font-size="19" font-weight="bold" fill="#111827">Answer token = number in BLUE box × 3</text>
    </svg>
  `, "utf8");
  const agentTaskPng = await sharp(agentTaskSvg, { density: 96 })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
  return {
    pngV1,
    pngV2,
    webpV1,
    largePng,
    truncatedPng: pngV1.subarray(0, Math.floor(pngV1.byteLength / 2)),
    croppedV1,
    agentTaskPng,
    crop,
  };
}

const FORMAT_TO_MIME = new Map([
  ["png", "image/png"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
  ["gif", "image/gif"],
]);

export async function inspectImage(bytes) {
  try {
    const pipeline = sharp(bytes, { failOn: "error", limitInputPixels: 16_777_216 });
    const metadata = await pipeline.metadata();
    await pipeline.clone().raw().toBuffer();
    const mimeType = FORMAT_TO_MIME.get(metadata.format);
    if (!mimeType || !metadata.width || !metadata.height) {
      throw new Error("unsupported decoded image metadata");
    }
    return {
      digest: sha256(bytes),
      byteLength: bytes.byteLength,
      mimeType,
      width: metadata.width,
      height: metadata.height,
    };
  } catch (error) {
    throw new ProbeError("LOCAL_IMAGE_DECODE_FAILED", "Image bytes did not fully decode", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export const PROFILES = Object.freeze({
  "inline-vision-v0": Object.freeze({
    endpointId: "local-openai-compatible-mock",
    modelId: "inline-vision-v0",
    maxRequestBytes: 16_384,
    media: Object.freeze({
      mimeTypes: Object.freeze(["image/png"]),
      deliveryModes: Object.freeze(["inline-data-url"]),
      maxItems: 1,
      maxBytesPerItem: 4096,
      maxAggregateBytes: 4096,
      maxWidth: 64,
      maxHeight: 64,
      fetchesAfterAcceptance: false,
    }),
  }),
  "url-only-vision-v0": Object.freeze({
    endpointId: "local-openai-compatible-mock",
    modelId: "url-only-vision-v0",
    maxRequestBytes: 16_384,
    media: Object.freeze({
      mimeTypes: Object.freeze(["image/png"]),
      deliveryModes: Object.freeze(["private-signed-url"]),
      maxItems: 1,
      maxBytesPerItem: 4096,
      maxAggregateBytes: 4096,
      maxWidth: 64,
      maxHeight: 64,
      maxSignedUrlLifetimeSeconds: 60,
      fetchesAfterAcceptance: true,
    }),
  }),
  "text-only-v0": Object.freeze({
    endpointId: "local-openai-compatible-mock",
    modelId: "text-only-v0",
    maxRequestBytes: 16_384,
    media: null,
  }),
});

export async function preflightLocalImage(profile, bytes, declaredMimeType) {
  if (!profile.media) {
    throw new ProbeError("CAPABILITY_MEDIA_UNSUPPORTED", "Exact endpoint/model profile is text-only");
  }
  const inspected = await inspectImage(bytes);
  if (
    !profile.media.mimeTypes.includes(declaredMimeType) ||
    !profile.media.mimeTypes.includes(inspected.mimeType)
  ) {
    throw new ProbeError("CAPABILITY_MIME_UNSUPPORTED", "Profile does not support the image MIME type", {
      declaredMimeType,
      decodedMimeType: inspected.mimeType,
    });
  }
  if (declaredMimeType !== inspected.mimeType) {
    throw new ProbeError("CAPABILITY_MIME_MISMATCH", "Declared and decoded MIME types differ");
  }
  if (bytes.byteLength > profile.media.maxBytesPerItem) {
    throw new ProbeError("CAPABILITY_MEDIA_BYTES_EXCEEDED", "Image exceeds the profile byte limit", {
      actual: bytes.byteLength,
      limit: profile.media.maxBytesPerItem,
    });
  }
  if (inspected.width > profile.media.maxWidth || inspected.height > profile.media.maxHeight) {
    throw new ProbeError("CAPABILITY_MEDIA_DIMENSIONS_EXCEEDED", "Image dimensions exceed the profile");
  }
  return inspected;
}

export function dataUrl(mimeType, bytes) {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

export function parseDataUrl(value) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(value);
  if (!match) throw new ProbeError("MODEL_IMAGE_DECODE_FAILED", "Image data URL is invalid");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.toString("base64") !== match[2]) {
    throw new ProbeError("MODEL_IMAGE_DECODE_FAILED", "Image base64 is non-canonical");
  }
  return { mimeType: match[1], bytes };
}

export function buildChatRequest(modelId, imageUrl, text = "Describe transport evidence only.") {
  const content = [{ type: "text", text }];
  if (imageUrl !== undefined) {
    content.push({ type: "image_url", image_url: { url: imageUrl } });
  }
  return {
    model: modelId,
    messages: [{ role: "user", content }],
    stream: false,
  };
}

export function enforceRequestLimit(profile, request) {
  const bytes = byteLengthJson(request);
  if (bytes > profile.maxRequestBytes) {
    throw new ProbeError(
      "CAPABILITY_REQUEST_BYTES_EXCEEDED",
      "Canonical request exceeds the exact endpoint/model profile",
      { actual: bytes, limit: profile.maxRequestBytes },
    );
  }
  return bytes;
}

function respondJson(response, status, body, extraHeaders = {}) {
  const bytes = Buffer.from(canonicalJson(body), "utf8");
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(bytes.byteLength),
    ...extraHeaders,
  });
  response.end(bytes);
}

async function readBody(request, maximum) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.byteLength;
    if (total > maximum) throw new ProbeError("MODEL_REQUEST_TOO_LARGE", "Request exceeded server limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function listen(handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      if (!response.headersSent) {
        respondJson(response, 500, {
          error: { code: "MOCK_INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) },
        });
      } else {
        response.destroy();
      }
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback server address unavailable");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    }),
  };
}

export function signedQueryCanonical(pathname, searchParams) {
  const entries = [...searchParams.entries()]
    .filter(([key]) => key !== "sig")
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey),
    );
  return `${pathname}?${new URLSearchParams(entries).toString()}`;
}

export function signCanonicalPath(pathAndQuery, key = FIXTURE_SIGNING_KEY) {
  return createHmac("sha256", key).update(pathAndQuery, "utf8").digest("hex");
}

function safeEqualHex(left, right) {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function parseCrop(value) {
  if (value === null) return undefined;
  const match = /^(0|[1-9][0-9]*),(0|[1-9][0-9]*),([1-9][0-9]*),([1-9][0-9]*)$/u.exec(value);
  if (!match) return null;
  return {
    left: Number(match[1]),
    top: Number(match[2]),
    width: Number(match[3]),
    height: Number(match[4]),
  };
}

export async function createPrivateObjectServer() {
  const objects = new Map();
  const fetchEvents = [];
  const deleteFailures = new Map();
  let clockSeconds = BASE_CLOCK_SECONDS;
  let origin;

  const service = await listen(async (request, response) => {
    if (request.method !== "GET" || !request.url) {
      respondJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED" } });
      return;
    }
    const url = new URL(request.url, origin);
    const match = /^\/private\/([A-Za-z0-9._-]+)$/u.exec(url.pathname);
    if (!match) {
      respondJson(response, 404, { error: { code: "OBJECT_NOT_FOUND" } });
      return;
    }
    const keys = [...url.searchParams.keys()].sort();
    if (
      keys.some((key) => !["crop", "exp", "sig", "version"].includes(key)) ||
      url.searchParams.getAll("version").length !== 1 ||
      url.searchParams.getAll("exp").length !== 1 ||
      url.searchParams.getAll("sig").length !== 1 ||
      url.searchParams.getAll("crop").length > 1
    ) {
      fetchEvents.push({ objectId: match[1], status: 403, reason: "query-shape" });
      respondJson(response, 403, { error: { code: "SIGNED_URL_FORBIDDEN" } });
      return;
    }
    const signature = url.searchParams.get("sig") ?? "";
    const expected = signCanonicalPath(signedQueryCanonical(url.pathname, url.searchParams));
    const expiry = Number(url.searchParams.get("exp"));
    if (!safeEqualHex(signature, expected) || !Number.isSafeInteger(expiry) || clockSeconds > expiry) {
      fetchEvents.push({ objectId: match[1], status: 403, reason: clockSeconds > expiry ? "expired" : "signature" });
      respondJson(response, 403, { error: { code: "SIGNED_URL_FORBIDDEN" } });
      return;
    }
    const version = url.searchParams.get("version");
    const entry = objects.get(match[1]);
    const source = version === null ? undefined : entry?.versions.get(version);
    if (!source) {
      fetchEvents.push({ objectId: match[1], version, status: 404, reason: "not-found" });
      respondJson(response, 404, { error: { code: "OBJECT_NOT_FOUND" } });
      return;
    }
    const crop = parseCrop(url.searchParams.get("crop"));
    if (crop === null) {
      fetchEvents.push({ objectId: match[1], version, status: 403, reason: "crop-shape" });
      respondJson(response, 403, { error: { code: "SIGNED_URL_FORBIDDEN" } });
      return;
    }
    let bytes = source;
    if (crop) {
      try {
        bytes = await sharp(source, { failOn: "error" })
          .extract(crop)
          .png({ compressionLevel: 9, adaptiveFiltering: false })
          .toBuffer();
      } catch {
        fetchEvents.push({ objectId: match[1], version, status: 416, reason: "crop-range" });
        respondJson(response, 416, { error: { code: "CROP_RANGE_INVALID" } });
        return;
      }
    }
    fetchEvents.push({
      objectId: match[1],
      version,
      status: 200,
      ...(crop ? { crop } : {}),
      digest: sha256(bytes),
      byteLength: bytes.byteLength,
    });
    response.writeHead(200, {
      "content-type": "image/png",
      "content-length": String(bytes.byteLength),
      "x-object-version": version,
    });
    response.end(bytes);
  });
  origin = service.origin;

  return {
    origin,
    fetchEvents,
    put(objectId, version, bytes, makeCurrent = true) {
      let entry = objects.get(objectId);
      if (!entry) {
        entry = { currentVersion: version, versions: new Map() };
        objects.set(objectId, entry);
      }
      entry.versions.set(version, Buffer.from(bytes));
      if (makeCurrent) entry.currentVersion = version;
    },
    currentVersion(objectId) {
      return objects.get(objectId)?.currentVersion ?? null;
    },
    sign({ objectId, version, crop, requestedLifetimeSeconds }) {
      if (!version) {
        throw new ProbeError("PRIVATE_URL_VERSION_REQUIRED", "Private signed URLs require an explicit object version");
      }
      const entry = objects.get(objectId);
      if (!entry?.versions.has(version)) {
        throw new ProbeError("PRIVATE_URL_VERSION_NOT_FOUND", "Requested object version does not exist");
      }
      if (!Number.isSafeInteger(requestedLifetimeSeconds) || requestedLifetimeSeconds <= 0) {
        throw new ProbeError("SIGNED_URL_LIFETIME_INVALID", "Signed URL lifetime must be positive");
      }
      const lifetimeSeconds = Math.min(requestedLifetimeSeconds, 60);
      const pathname = `/private/${objectId}`;
      const params = new URLSearchParams({
        version,
        exp: String(clockSeconds + lifetimeSeconds),
      });
      if (crop) params.set("crop", `${crop.left},${crop.top},${crop.width},${crop.height}`);
      params.set("sig", signCanonicalPath(signedQueryCanonical(pathname, params)));
      return {
        url: `${origin}${pathname}?${params.toString()}`,
        issuedAt: clockSeconds,
        expiresAt: clockSeconds + lifetimeSeconds,
        lifetimeSeconds,
        clamped: requestedLifetimeSeconds !== lifetimeSeconds,
        objectId,
        version,
        ...(crop ? { crop } : {}),
      };
    },
    setClock(next) {
      if (!Number.isSafeInteger(next)) throw new TypeError("clock must be an integer");
      clockSeconds = next;
    },
    getClock() {
      return clockSeconds;
    },
    failNextDeletes(objectId, version, count) {
      deleteFailures.set(`${objectId}\0${version}`, count);
    },
    deleteVersion(objectId, version) {
      const key = `${objectId}\0${version}`;
      const failures = deleteFailures.get(key) ?? 0;
      if (failures > 0) {
        deleteFailures.set(key, failures - 1);
        throw new ProbeError("OBJECT_DELETE_ACCESS_DENIED", "Simulated private object delete permission failure");
      }
      const entry = objects.get(objectId);
      if (!entry?.versions.delete(version)) return "not-found";
      if (entry.currentVersion === version) entry.currentVersion = null;
      return "deleted";
    },
    hasVersion(objectId, version) {
      return objects.get(objectId)?.versions.has(version) ?? false;
    },
    close: service.close,
  };
}

function modelError(response, status, code, message) {
  respondJson(response, status, { error: { code, message } });
}

export async function createModelMock({ allowedPrivateOrigin }) {
  const requestEvents = [];
  let origin;
  const service = await listen(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      modelError(response, 404, "MODEL_ROUTE_NOT_FOUND", "Unknown mock route");
      return;
    }
    let raw;
    try {
      raw = await readBody(request, 65_536);
    } catch (error) {
      modelError(response, 413, error.code ?? "MODEL_REQUEST_TOO_LARGE", error.message);
      return;
    }
    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      modelError(response, 400, "MODEL_REQUEST_INVALID", "Request is not JSON");
      return;
    }
    const profile = PROFILES[body.model];
    if (!profile) {
      modelError(response, 400, "MODEL_PROFILE_UNKNOWN", "Exact endpoint/model profile is absent");
      return;
    }
    if (raw.byteLength > profile.maxRequestBytes) {
      modelError(response, 413, "MODEL_REQUEST_TOO_LARGE", "Request exceeds profile limit");
      return;
    }
    const content = body?.messages?.[0]?.content;
    if (!Array.isArray(content)) {
      modelError(response, 400, "MODEL_REQUEST_INVALID", "Message content is invalid");
      return;
    }
    const imageParts = content.filter((part) => part?.type === "image_url");
    if (imageParts.length === 0) {
      requestEvents.push({ modelId: profile.modelId, requestBytes: raw.byteLength, status: 200, imageCount: 0 });
      respondJson(response, 200, {
        id: "mock-text-response",
        choices: [{ message: { role: "assistant", content: canonicalJson({ imageCount: 0 }) }, finish_reason: "stop" }],
      });
      return;
    }
    if (!profile.media) {
      modelError(response, 400, "MODEL_MEDIA_UNSUPPORTED", "Profile is text-only");
      return;
    }
    if (imageParts.length > profile.media.maxItems) {
      modelError(response, 400, "MODEL_MEDIA_ITEMS_EXCEEDED", "Too many image items");
      return;
    }
    const imageUrl = imageParts[0]?.image_url?.url;
    if (typeof imageUrl !== "string") {
      modelError(response, 400, "MODEL_REQUEST_INVALID", "image_url.url is invalid");
      return;
    }
    let bytes;
    let declaredMimeType;
    let fetchStatus;
    let objectVersion;
    if (imageUrl.startsWith("data:")) {
      if (!profile.media.deliveryModes.includes("inline-data-url")) {
        modelError(response, 400, "MODEL_DELIVERY_UNSUPPORTED", "Profile is URL-only");
        return;
      }
      try {
        ({ mimeType: declaredMimeType, bytes } = parseDataUrl(imageUrl));
      } catch (error) {
        modelError(response, 400, error.code ?? "MODEL_IMAGE_DECODE_FAILED", error.message);
        return;
      }
    } else {
      if (!profile.media.deliveryModes.includes("private-signed-url")) {
        modelError(response, 400, "MODEL_DELIVERY_UNSUPPORTED", "Profile accepts inline images only");
        return;
      }
      let parsed;
      try {
        parsed = new URL(imageUrl);
      } catch {
        modelError(response, 400, "MODEL_URL_INVALID", "Image URL is invalid");
        return;
      }
      if (parsed.origin !== allowedPrivateOrigin || parsed.protocol !== "http:") {
        modelError(response, 400, "MODEL_URL_SCOPE_DENIED", "Mock fetch is restricted to its loopback object server");
        return;
      }
      const fetched = await fetch(parsed, { redirect: "error" });
      fetchStatus = fetched.status;
      if (fetched.status === 403) {
        modelError(response, 422, "MODEL_FETCH_FORBIDDEN", "Private image fetch was forbidden");
        return;
      }
      if (fetched.status === 404) {
        modelError(response, 422, "MODEL_FETCH_NOT_FOUND", "Private image version was not found");
        return;
      }
      if (!fetched.ok) {
        modelError(response, 422, "MODEL_FETCH_FAILED", `Private image fetch returned ${fetched.status}`);
        return;
      }
      bytes = Buffer.from(await fetched.arrayBuffer());
      declaredMimeType = fetched.headers.get("content-type")?.split(";", 1)[0] ?? "";
      objectVersion = fetched.headers.get("x-object-version") ?? undefined;
    }
    if (bytes.byteLength > profile.media.maxBytesPerItem) {
      modelError(response, 400, "MODEL_MEDIA_BYTES_EXCEEDED", "Image exceeds profile byte limit");
      return;
    }
    if (!profile.media.mimeTypes.includes(declaredMimeType)) {
      modelError(response, 400, "MODEL_MIME_UNSUPPORTED", "Declared image MIME type is unsupported");
      return;
    }
    let inspected;
    try {
      inspected = await inspectImage(bytes);
    } catch {
      modelError(response, 400, "MODEL_IMAGE_DECODE_FAILED", "Image did not fully decode");
      return;
    }
    if (inspected.mimeType !== declaredMimeType) {
      modelError(response, 400, "MODEL_MIME_MISMATCH", "Declared and decoded MIME types differ");
      return;
    }
    if (inspected.width > profile.media.maxWidth || inspected.height > profile.media.maxHeight) {
      modelError(response, 400, "MODEL_MEDIA_DIMENSIONS_EXCEEDED", "Image dimensions exceed profile");
      return;
    }
    const evidence = {
      digest: inspected.digest,
      byteLength: inspected.byteLength,
      mimeType: inspected.mimeType,
      width: inspected.width,
      height: inspected.height,
      ...(fetchStatus === undefined ? {} : { fetchStatus }),
      ...(objectVersion === undefined ? {} : { objectVersion }),
    };
    requestEvents.push({
      modelId: profile.modelId,
      requestBytes: raw.byteLength,
      status: 200,
      imageCount: 1,
      evidence,
    });
    respondJson(response, 200, {
      id: `mock-${inspected.digest.slice(0, 12)}`,
      choices: [{ message: { role: "assistant", content: canonicalJson(evidence) }, finish_reason: "stop" }],
    });
  });
  origin = service.origin;
  return { origin, requestEvents, close: service.close };
}

export async function postCanonicalJson(url, body) {
  const requestText = canonicalJson(body);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: requestText,
    redirect: "error",
  });
  const responseBody = await response.json();
  return {
    status: response.status,
    body: responseBody,
    requestBytes: Buffer.byteLength(requestText, "utf8"),
  };
}

export function decodeModelEvidence(responseBody) {
  const content = responseBody?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new ProbeError("MODEL_RESPONSE_INVALID", "Mock response content is absent");
  return JSON.parse(content);
}

function checkedLocalPath(root, path) {
  const canonicalRoot = realpathSync(root);
  const candidate = resolve(path);
  const rel = relative(canonicalRoot, candidate);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) {
    throw new ProbeError("TOOL_PATH_DENIED", "File path is outside the configured image root");
  }
  const status = lstatSync(candidate);
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new ProbeError("TOOL_FILE_NOT_REGULAR", "Image path must be a regular non-symbolic file");
  }
  return candidate;
}

export function createBoundedImageFileTool(root, maximumFileBytes = 8192) {
  return {
    async inspect(path) {
      const candidate = checkedLocalPath(root, path);
      const size = statSync(candidate).size;
      if (size <= 0 || size > maximumFileBytes) {
        throw new ProbeError("TOOL_FILE_LIMIT_EXCEEDED", "Image file exceeds the configured byte limit");
      }
      const bytes = readFileSync(candidate);
      const image = await inspectImage(bytes);
      return { path: candidate, ...image, maximumChunkBytes: MAX_TOOL_CHUNK_BYTES };
    },
    readChunk(token, offset, length) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0) {
        throw new ProbeError("TOOL_RANGE_INVALID", "Chunk range must use positive safe integers");
      }
      if (length > MAX_TOOL_CHUNK_BYTES) {
        throw new ProbeError("TOOL_CHUNK_LIMIT_EXCEEDED", "Requested chunk exceeds the configured maximum");
      }
      const candidate = checkedLocalPath(root, token.path);
      const bytes = readFileSync(candidate);
      if (bytes.byteLength !== token.byteLength || sha256(bytes) !== token.digest) {
        throw new ProbeError("TOOL_FILE_CHANGED", "Image changed after inspection; acquire a new inspection token");
      }
      if (offset >= bytes.byteLength) {
        throw new ProbeError("TOOL_RANGE_INVALID", "Chunk offset is outside the inspected file");
      }
      const end = Math.min(offset + length, bytes.byteLength);
      const chunk = bytes.subarray(offset, end);
      return {
        offset,
        end,
        totalBytes: bytes.byteLength,
        eof: end === bytes.byteLength,
        encoding: "base64",
        data: chunk.toString("base64"),
        fileDigest: token.digest,
      };
    },
  };
}

export function reconstructChunks(chunks, expectedBytes, expectedDigest) {
  let nextOffset = 0;
  const decoded = [];
  for (const chunk of chunks) {
    if (chunk.offset !== nextOffset || chunk.end < chunk.offset || chunk.totalBytes !== expectedBytes) {
      throw new ProbeError("TOOL_RECONSTRUCTION_INVALID", "Chunk offsets or total length are inconsistent");
    }
    const bytes = Buffer.from(chunk.data, "base64");
    if (bytes.toString("base64") !== chunk.data || bytes.byteLength !== chunk.end - chunk.offset) {
      throw new ProbeError("TOOL_RECONSTRUCTION_INVALID", "Chunk base64 is invalid");
    }
    decoded.push(bytes);
    nextOffset = chunk.end;
  }
  const result = Buffer.concat(decoded);
  if (result.byteLength !== expectedBytes || sha256(result) !== expectedDigest) {
    throw new ProbeError("TOOL_RECONSTRUCTION_TRUNCATED", "Reconstructed bytes do not match inspection evidence");
  }
  return result;
}
