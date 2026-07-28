import { createHash } from "node:crypto";
import { deepFreeze } from "../../core/canonical-json.js";
import { memoryError } from "./errors.js";

/**
 * Namespace and authorization model from `docs/spec/memory-extension.md` §4.
 *
 * The whole point of this file is that the six namespace components have
 * exactly one source: the runtime. Nothing here reads a Block payload, a model
 * output, an extension configuration string, or an endpoint response. The
 * constructor takes an already authenticated identity object and Delivery
 * metadata; there is no overload that takes untrusted text.
 */

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const NAMESPACE_DOMAIN = "dolly.memory-namespace/1";

export type RetentionScopeKind = "session" | "owner-long-term";

/**
 * The identity the runtime authenticates before a Memory Module action starts.
 *
 * `sessionId` is always present even when the configured retention scope is
 * `owner-long-term`, because §4.1 requires every record to store its
 * originating session regardless of which scope owns it.
 */
export interface RuntimeMemoryIdentity {
  readonly instanceId: string;
  readonly ownerScopeId: string;
  readonly memoryModuleInstanceId: string;
  readonly sessionId: string;
}

/**
 * The Delivery facts the core supplies with an input batch. The source Page and
 * the producing Module instance both come from here, never from the payload
 * (§4.2, §7).
 */
export interface RuntimeDeliveryContext {
  readonly deliveryId: string;
  readonly inputPageId: string;
  readonly pageSequence: number;
  readonly sourceBlockId: string;
  readonly coreSequence: number;
  readonly sourceModuleInstanceId: string;
}

/**
 * An explicitly configured, separately authorized long-term memory space. §4.1
 * requires it to be owned by the same owner scope; a query cannot opt into it.
 */
export interface OwnerLongTermGrant {
  readonly kind: "owner-long-term";
  readonly memorySpaceId: string;
  /** The owner the deployment configured this space for. */
  readonly grantedOwnerScopeId: string;
}

export type RetentionScopeSelection = { readonly kind: "session" } | OwnerLongTermGrant;

export interface MemoryNamespace {
  readonly instanceId: string;
  readonly ownerScopeId: string;
  readonly memoryModuleInstanceId: string;
  readonly inputPageId: string;
  readonly retentionScopeKind: RetentionScopeKind;
  readonly retentionScopeId: string;
  /**
   * Opaque digest of the exact six-tuple. Every storage key, index key, cache
   * key, and metric bucket in this package is derived from it, so a key that
   * omits a component is not representable.
   */
  readonly namespaceKey: string;
}

function requireIdentifier(value: unknown, label: string): string {
  if (value === undefined || value === null || value === "") {
    throw memoryError(
      "MEMORY_IDENTITY_MISSING",
      `Memory namespace component ${label} is missing; there is no shared default`,
      { component: label },
    );
  }
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw memoryError(
      "MEMORY_IDENTITY_INVALID",
      `Memory namespace component ${label} is not a runtime identifier`,
      { component: label },
    );
  }
  return value;
}

/**
 * Validates a runtime identity. A missing owner or session is a configuration
 * or migration error (§4.1): this never substitutes `default`, `""`, a
 * process-global store, or the first namespace it can find.
 */
export function authenticateIdentity(
  identity: Partial<RuntimeMemoryIdentity> | undefined,
): RuntimeMemoryIdentity {
  if (identity === undefined) {
    throw memoryError(
      "MEMORY_IDENTITY_MISSING",
      "Memory requires a runtime-authenticated identity",
      { component: "identity" },
    );
  }
  return deepFreeze({
    instanceId: requireIdentifier(identity.instanceId, "instanceId"),
    ownerScopeId: requireIdentifier(identity.ownerScopeId, "ownerScopeId"),
    memoryModuleInstanceId: requireIdentifier(
      identity.memoryModuleInstanceId,
      "memoryModuleInstanceId",
    ),
    sessionId: requireIdentifier(identity.sessionId, "sessionId"),
  });
}

export function authenticateDelivery(
  delivery: Partial<RuntimeDeliveryContext> | undefined,
): RuntimeDeliveryContext {
  if (delivery === undefined) {
    throw memoryError(
      "MEMORY_IDENTITY_MISSING",
      "Memory requires runtime Delivery metadata",
      { component: "delivery" },
    );
  }
  const pageSequence = delivery.pageSequence;
  const coreSequence = delivery.coreSequence;
  for (const [label, value] of [
    ["pageSequence", pageSequence],
    ["coreSequence", coreSequence],
  ] as const) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw memoryError(
        "MEMORY_IDENTITY_INVALID",
        `Delivery ${label} must be a non-negative safe integer`,
        { component: label },
      );
    }
  }
  return deepFreeze({
    deliveryId: requireIdentifier(delivery.deliveryId, "deliveryId"),
    inputPageId: requireIdentifier(delivery.inputPageId, "inputPageId"),
    pageSequence: pageSequence as number,
    sourceBlockId: requireIdentifier(delivery.sourceBlockId, "sourceBlockId"),
    coreSequence: coreSequence as number,
    sourceModuleInstanceId: requireIdentifier(
      delivery.sourceModuleInstanceId,
      "sourceModuleInstanceId",
    ),
  });
}

function namespaceKeyOf(components: readonly string[]): string {
  const digest = createHash("sha256").update(NAMESPACE_DOMAIN, "utf8");
  for (const component of components) {
    // Length prefixing keeps `a|bc` and `ab|c` distinct without escaping.
    digest.update(String(component.length), "utf8");
    digest.update(":", "utf8");
    digest.update(component, "utf8");
  }
  return digest.digest("hex");
}

/**
 * Builds the authenticated namespace for one input Page.
 *
 * `inputPageId` comes from Delivery metadata. A Memory Module that consumes two
 * Pages calls this twice and receives two different `namespaceKey` values, which
 * is how §4.2's per-Page subnamespace requirement is enforced: concatenating two
 * Pages into one index would require forging a key this function never emits.
 */
export function authenticateNamespace(options: {
  readonly identity: RuntimeMemoryIdentity;
  readonly inputPageId: string;
  readonly retention: RetentionScopeSelection;
}): MemoryNamespace {
  const identity = authenticateIdentity(options.identity);
  const inputPageId = requireIdentifier(options.inputPageId, "inputPageId");
  const retention = options.retention;
  if (retention === undefined || typeof retention !== "object") {
    throw memoryError(
      "MEMORY_RETENTION_SCOPE_INVALID",
      "Memory requires an explicit retention scope selection",
    );
  }

  let retentionScopeKind: RetentionScopeKind;
  let retentionScopeId: string;
  if (retention.kind === "session") {
    retentionScopeKind = "session";
    retentionScopeId = identity.sessionId;
  } else if (retention.kind === "owner-long-term") {
    const memorySpaceId = requireIdentifier(retention.memorySpaceId, "memorySpaceId");
    const grantedOwnerScopeId = requireIdentifier(
      retention.grantedOwnerScopeId,
      "grantedOwnerScopeId",
    );
    if (grantedOwnerScopeId !== identity.ownerScopeId) {
      throw memoryError(
        "MEMORY_SCOPE_DENIED",
        "An owner-long-term memory space belongs to a different owner scope",
        { grantedOwnerScopeId, ownerScopeId: identity.ownerScopeId },
      );
    }
    retentionScopeKind = "owner-long-term";
    retentionScopeId = memorySpaceId;
  } else {
    throw memoryError(
      "MEMORY_RETENTION_SCOPE_INVALID",
      "Memory retention scope kind is unsupported",
      { kind: String((retention as { kind?: unknown }).kind) },
    );
  }

  return deepFreeze({
    instanceId: identity.instanceId,
    ownerScopeId: identity.ownerScopeId,
    memoryModuleInstanceId: identity.memoryModuleInstanceId,
    inputPageId,
    retentionScopeKind,
    retentionScopeId,
    namespaceKey: namespaceKeyOf([
      identity.instanceId,
      identity.ownerScopeId,
      identity.memoryModuleInstanceId,
      inputPageId,
      retentionScopeKind,
      retentionScopeId,
    ]),
  });
}

export type MemoryOperation =
  | "query"
  | "index"
  | "delete"
  | "export"
  | "reindex"
  | "retention-change";

/**
 * Runtime policy for one Module generation. §4.3 requires the check on every
 * query, delete, export, reindex, and retention change, not only at creation.
 */
export interface MemoryAuthorization {
  readonly grants: readonly {
    readonly namespaceKey: string;
    readonly operations: readonly MemoryOperation[];
  }[];
}

export function assertNamespaceAuthorized(
  authorization: MemoryAuthorization,
  namespace: MemoryNamespace,
  operation: MemoryOperation,
): void {
  const grant = authorization.grants.find(
    (candidate) => candidate.namespaceKey === namespace.namespaceKey,
  );
  if (!grant) {
    throw memoryError(
      "MEMORY_SCOPE_DENIED",
      "Runtime policy does not grant this Memory namespace",
      { operation },
    );
  }
  if (!grant.operations.includes(operation)) {
    throw memoryError(
      "MEMORY_SCOPE_DENIED",
      "Runtime policy does not grant this Memory operation",
      { operation },
    );
  }
}

export function assertSameNamespace(
  expected: MemoryNamespace,
  actualNamespaceKey: string,
  subject: string,
): void {
  if (expected.namespaceKey !== actualNamespaceKey) {
    throw memoryError(
      "MEMORY_NAMESPACE_MISMATCH",
      `${subject} belongs to a different Memory namespace`,
      { subject },
    );
  }
}

/**
 * Derives a storage, index, or cache key inside one namespace.
 *
 * There is deliberately no variant that omits the namespace. §4.3 declares a
 * key without every namespace component invalid, and the only way to obtain one
 * here is to hold a `MemoryNamespace` the runtime authenticated.
 */
export function namespaceScopedKey(
  namespace: MemoryNamespace,
  ...parts: readonly string[]
): string {
  return [namespace.namespaceKey, ...parts].join("/");
}
