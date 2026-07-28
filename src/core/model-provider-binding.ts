import {
  canonicalJsonDigest,
  cloneJson,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";
import {
  type DescriptorRef,
  validateDescriptorRef,
} from "./model-provider-descriptor.js";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u;

export interface EndpointBindingDocument {
  readonly schemaVersion: "dolly.endpoint-binding/2";
  readonly endpointId: string;
  readonly bindingRevision: string;
  readonly descriptorRefs: readonly DescriptorRef[];
  readonly exactUrl: string;
  readonly networkScope: "public" | "loopback";
  readonly authentication:
    | { readonly kind: "none" }
    | {
        readonly kind: "bearer-secret";
        readonly secretRef: string;
        readonly secretRevision: string;
      };
  readonly limits: {
    readonly maxRequestBytes: number;
    readonly maxResponseBytes: number;
    readonly maxTimeoutMs: number;
  };
}

export interface EndpointBindingRef {
  readonly endpointId: string;
  readonly bindingRevision: string;
}

export interface EndpointBindingSnapshot {
  readonly ref: EndpointBindingRef;
  readonly document: EndpointBindingDocument;
}

export type EndpointBindingStatus = "active" | "disabled" | "superseded";

export type EndpointBindingErrorCode =
  | "BINDING_INVALID"
  | "BINDING_IDENTITY_CONFLICT"
  | "BINDING_NOT_FOUND"
  | "BINDING_DISABLED"
  | "BINDING_DESCRIPTOR_DENIED"
  | "BINDING_STATUS_INVALID";

export class EndpointBindingError extends Error {
  constructor(readonly code: EndpointBindingErrorCode, message: string) {
    super(message);
    this.name = "EndpointBindingError";
  }
}

interface BindingEntry {
  readonly ref: EndpointBindingRef;
  readonly digest: string;
  readonly document: EndpointBindingDocument;
  status: EndpointBindingStatus;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function closed(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new EndpointBindingError("BINDING_INVALID", `${label} must be an object`);
  }
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new EndpointBindingError("BINDING_INVALID", `${label} contains unknown fields`);
  }
}

function name(value: unknown, label: string): string {
  if (typeof value !== "string" || !NAME_PATTERN.test(value)) {
    throw new EndpointBindingError("BINDING_INVALID", `${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new EndpointBindingError(
      "BINDING_INVALID",
      `${label} must be a positive safe integer`,
    );
  }
  return value as number;
}

function normalizeExactUrl(value: unknown, networkScope: EndpointBindingDocument["networkScope"]): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 4096) {
    throw new EndpointBindingError("BINDING_INVALID", "exactUrl is invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EndpointBindingError("BINDING_INVALID", "exactUrl is invalid");
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname === "/" ||
    url.pathname.endsWith("/")
  ) {
    throw new EndpointBindingError(
      "BINDING_INVALID",
      "exactUrl must be a credential-free exact operation route",
    );
  }
  if (networkScope === "public") {
    if (url.protocol !== "https:") {
      throw new EndpointBindingError("BINDING_INVALID", "Public provider bindings require HTTPS");
    }
  } else {
    const hostname = url.hostname.replace(/^\[|\]$/gu, "");
    if (
      url.protocol !== "http:" ||
      (hostname !== "127.0.0.1" && hostname !== "::1") ||
      url.port === ""
    ) {
      throw new EndpointBindingError(
        "BINDING_INVALID",
        "The loopback network scope requires an explicit numeric loopback HTTP endpoint",
      );
    }
  }
  return url.href;
}

function refKey(ref: DescriptorRef): string {
  return [
    ref.endpointId,
    ref.operation,
    ref.modelId,
    ref.adapterId,
    ref.adapterVersion,
    ref.descriptorVersion,
    ref.descriptorDigest,
  ].join("\u0000");
}

export function validateEndpointBinding(value: unknown): EndpointBindingDocument {
  closed(
    value,
    [
      "schemaVersion",
      "endpointId",
      "bindingRevision",
      "descriptorRefs",
      "exactUrl",
      "networkScope",
      "authentication",
      "limits",
    ],
    "binding",
  );
  if (value.schemaVersion !== "dolly.endpoint-binding/2") {
    throw new EndpointBindingError("BINDING_INVALID", "Binding schema is unsupported");
  }
  const endpointId = name(value.endpointId, "endpointId");
  if (endpointId.includes("://") || endpointId.startsWith("/")) {
    throw new EndpointBindingError("BINDING_INVALID", "endpointId must be logical");
  }
  const bindingRevision = name(value.bindingRevision, "bindingRevision");
  if (!Array.isArray(value.descriptorRefs) || value.descriptorRefs.length === 0) {
    throw new EndpointBindingError("BINDING_INVALID", "descriptorRefs must be non-empty");
  }
  const descriptorRefs = value.descriptorRefs.map((candidate) => {
    if (!isPlainObject(candidate)) {
      throw new EndpointBindingError("BINDING_INVALID", "Descriptor reference is invalid");
    }
    const ref = candidate as unknown as DescriptorRef;
    try {
      validateDescriptorRef(ref);
    } catch {
      throw new EndpointBindingError("BINDING_INVALID", "Descriptor reference is invalid");
    }
    if (ref.endpointId !== endpointId) {
      throw new EndpointBindingError(
        "BINDING_INVALID",
        "Every descriptor reference must use the binding endpointId",
      );
    }
    return deepFreeze({ ...ref });
  });
  if (new Set(descriptorRefs.map(refKey)).size !== descriptorRefs.length) {
    throw new EndpointBindingError("BINDING_INVALID", "descriptorRefs contains duplicates");
  }
  const networkScope =
    value.networkScope === "public" || value.networkScope === "loopback"
      ? value.networkScope
      : (() => {
          throw new EndpointBindingError("BINDING_INVALID", "networkScope is invalid");
        })();
  const exactUrl = normalizeExactUrl(value.exactUrl, networkScope);

  if (!isPlainObject(value.authentication) || typeof value.authentication.kind !== "string") {
    throw new EndpointBindingError("BINDING_INVALID", "authentication is invalid");
  }
  let authentication: EndpointBindingDocument["authentication"];
  if (value.authentication.kind === "none") {
    closed(value.authentication, ["kind"], "authentication");
    authentication = { kind: "none" };
  } else if (value.authentication.kind === "bearer-secret") {
    closed(
      value.authentication,
      ["kind", "secretRef", "secretRevision"],
      "authentication",
    );
    authentication = {
      kind: "bearer-secret",
      secretRef: name(value.authentication.secretRef, "authentication.secretRef"),
      secretRevision: name(
        value.authentication.secretRevision,
        "authentication.secretRevision",
      ),
    };
  } else {
    throw new EndpointBindingError("BINDING_INVALID", "authentication kind is unsupported");
  }

  closed(value.limits, ["maxRequestBytes", "maxResponseBytes", "maxTimeoutMs"], "limits");
  return deepFreeze({
    schemaVersion: "dolly.endpoint-binding/2",
    endpointId,
    bindingRevision,
    descriptorRefs,
    exactUrl,
    networkScope,
    authentication,
    limits: {
      maxRequestBytes: positiveInteger(value.limits.maxRequestBytes, "limits.maxRequestBytes"),
      maxResponseBytes: positiveInteger(value.limits.maxResponseBytes, "limits.maxResponseBytes"),
      maxTimeoutMs: positiveInteger(value.limits.maxTimeoutMs, "limits.maxTimeoutMs"),
    },
  });
}

export class EndpointBindingRegistry {
  readonly #entries = new Map<string, BindingEntry>();
  readonly #activeByEndpoint = new Map<string, EndpointBindingRef>();

  register(input: unknown): EndpointBindingRef {
    const document = validateEndpointBinding(input);
    const ref = deepFreeze({
      endpointId: document.endpointId,
      bindingRevision: document.bindingRevision,
    });
    const key = this.#entryKey(ref);
    const digest = canonicalJsonDigest(document);
    const existing = this.#entries.get(key);
    if (existing) {
      if (existing.digest !== digest) {
        throw new EndpointBindingError(
          "BINDING_IDENTITY_CONFLICT",
          "Binding revision already has different canonical bytes",
        );
      }
      return existing.ref;
    }
    const stored = deepFreeze(
      cloneJson(document as unknown as JsonValue),
    ) as unknown as EndpointBindingDocument;
    this.#entries.set(key, { ref, digest, document: stored, status: "disabled" });
    return ref;
  }

  setStatus(ref: EndpointBindingRef, status: EndpointBindingStatus): void {
    const entry = this.#requireEntry(ref);
    if (status !== "active" && status !== "disabled" && status !== "superseded") {
      throw new EndpointBindingError("BINDING_STATUS_INVALID", "Binding status is unsupported");
    }
    if (entry.status === "superseded" && status === "active") {
      throw new EndpointBindingError(
        "BINDING_STATUS_INVALID",
        "A superseded binding cannot be reactivated",
      );
    }
    if (status === "active") {
      const current = this.#activeByEndpoint.get(ref.endpointId);
      if (current && current.bindingRevision !== ref.bindingRevision) {
        const previous = this.#requireEntry(current);
        if (previous.status === "active") previous.status = "disabled";
      }
      this.#activeByEndpoint.set(ref.endpointId, entry.ref);
    } else if (
      this.#activeByEndpoint.get(ref.endpointId)?.bindingRevision === ref.bindingRevision
    ) {
      this.#activeByEndpoint.delete(ref.endpointId);
    }
    entry.status = status;
  }

  snapshot(descriptorRef: DescriptorRef): EndpointBindingSnapshot {
    validateDescriptorRef(descriptorRef);
    const active = this.#activeByEndpoint.get(descriptorRef.endpointId);
    if (!active) {
      throw new EndpointBindingError("BINDING_NOT_FOUND", "Endpoint has no active binding");
    }
    const entry = this.#requireEntry(active);
    if (entry.status !== "active") {
      throw new EndpointBindingError("BINDING_DISABLED", "Endpoint binding is not active");
    }
    if (!entry.document.descriptorRefs.some((candidate) => refKey(candidate) === refKey(descriptorRef))) {
      throw new EndpointBindingError(
        "BINDING_DESCRIPTOR_DENIED",
        "Endpoint binding does not authorize this exact descriptor",
      );
    }
    return deepFreeze({ ref: entry.ref, document: entry.document });
  }

  #entryKey(ref: EndpointBindingRef): string {
    return `${ref.endpointId}\u0000${ref.bindingRevision}`;
  }

  #requireEntry(ref: EndpointBindingRef): BindingEntry {
    if (
      typeof ref?.endpointId !== "string" ||
      typeof ref.bindingRevision !== "string" ||
      !NAME_PATTERN.test(ref.endpointId) ||
      !NAME_PATTERN.test(ref.bindingRevision)
    ) {
      throw new EndpointBindingError("BINDING_INVALID", "Binding reference is invalid");
    }
    const entry = this.#entries.get(this.#entryKey(ref));
    if (!entry) throw new EndpointBindingError("BINDING_NOT_FOUND", "Binding is not registered");
    return entry;
  }
}
