import { deepFreeze } from "./canonical-json.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OWNER_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

export type ResourceKind = "block" | "media";

export interface ResourceTarget {
  readonly kind: ResourceKind;
  readonly id: string;
}

/**
 * A persistent owner-to-target strong reference. It keeps the target and all
 * of the target's transitive dependencies reachable until the owner removes
 * the reference. "Strong reference" is the standard garbage-collection and
 * ownership term for this behavior.
 */
export interface StrongReference {
  readonly ownerKind: string;
  readonly ownerId: string;
  readonly targetKind: ResourceKind;
  readonly targetId: string;
}

/**
 * A temporary strong reference with its own identity, scope, and optional
 * expiry time. Access leases keep asynchronous work safe without creating a
 * persistent owner-to-target reference.
 */
export interface AccessLease {
  readonly leaseId: string;
  readonly ownerKind: string;
  readonly ownerId: string;
  readonly targetKind: ResourceKind;
  readonly targetId: string;
  /**
   * `active-claim` protects Delivery input while a Module owns its claim;
   * `run-scope` protects data used by one Module run; `provider-access`
   * protects Media while a provider may fetch its URL; `media-read` protects
   * Media while Core copies immutable bytes; and `storage-operation` protects
   * Media while an original object is written or deleted.
   */
  readonly kind:
    | "active-claim"
    | "run-scope"
    | "provider-access"
    | "media-read"
    | "storage-operation";
  readonly moduleGenerationId?: string;
  readonly moduleJobId?: string;
  readonly runId?: string;
  /**
   * Canonical ISO 8601 UTC metadata for the owner or cleanup process.
   * ReferenceGraph does not read a clock and never releases a lease automatically.
   */
  readonly expiresAt?: string;
}

export interface ReferenceNodeSnapshot {
  readonly target: ResourceTarget;
  readonly outgoing: readonly ResourceTarget[];
}

export interface ReferenceGraphSnapshot {
  readonly schemaVersion: "dolly.reference-graph/4";
  readonly nodes: readonly ReferenceNodeSnapshot[];
  readonly strongReferences: readonly StrongReference[];
  readonly leases: readonly AccessLease[];
}

export type ReferenceGraphErrorCode =
  | "REFERENCE_GRAPH_INPUT_INVALID"
  | "REFERENCE_GRAPH_OWNER_KIND_UNKNOWN"
  | "REFERENCE_GRAPH_TARGET_MISSING"
  | "REFERENCE_GRAPH_NODE_CONFLICT"
  | "REFERENCE_GRAPH_NODE_REFERENCED"
  | "REFERENCE_GRAPH_REMOVAL_IN_PROGRESS"
  | "REFERENCE_GRAPH_LEASE_CONFLICT"
  | "REFERENCE_GRAPH_NODE_REACHABLE";

export class ReferenceGraphError extends Error {
  constructor(readonly code: ReferenceGraphErrorCode, message: string) {
    super(message);
    this.name = "ReferenceGraphError";
  }
}

export interface ReferenceGraphOptions {
  readonly snapshot?: ReferenceGraphSnapshot;
}

const BUILT_IN_STRONG_REFERENCE_OWNER_KINDS = [
  "delivery",
  "dead-letter",
  "commit",
  "media-registration",
] as const;

function assertId(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new ReferenceGraphError(
      "REFERENCE_GRAPH_INPUT_INVALID",
      `${label} is not a valid opaque identifier`,
    );
  }
}

function assertResourceKind(value: ResourceKind, label: string): void {
  if (value !== "block" && value !== "media") {
    throw new ReferenceGraphError(
      "REFERENCE_GRAPH_INPUT_INVALID",
      `${label} is not a valid resource kind`,
    );
  }
}

function assertOwnerKind(value: string): void {
  if (!OWNER_PATTERN.test(value)) {
    throw new ReferenceGraphError(
      "REFERENCE_GRAPH_INPUT_INVALID",
      "ownerKind is not valid",
    );
  }
}

function assertClosedObject(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ReferenceGraphError(
      "REFERENCE_GRAPH_INPUT_INVALID",
      `${label} must be an object`,
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ReferenceGraphError(
      "REFERENCE_GRAPH_INPUT_INVALID",
      `${label} must be a plain object`,
    );
  }
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ReferenceGraphError(
      "REFERENCE_GRAPH_INPUT_INVALID",
      `${label} contains unknown fields`,
    );
  }
}

function targetKey(target: ResourceTarget): string {
  return `${target.kind}:${target.id}`;
}

function targetFromKey(key: string): ResourceTarget {
  const separator = key.indexOf(":");
  const kind = key.slice(0, separator) as ResourceKind;
  const id = key.slice(separator + 1);
  assertResourceKind(kind, "target.kind");
  assertId(id, "target.id");
  return { kind, id };
}

function strongReferenceKey(reference: StrongReference): string {
  return JSON.stringify([
    reference.ownerKind,
    reference.ownerId,
    reference.targetKind,
    reference.targetId,
  ]);
}

export class ReferenceGraph {
  readonly #nodes = new Map<string, ReadonlySet<string>>();
  readonly #strongReferences = new Map<string, Readonly<StrongReference>>();
  readonly #leases = new Map<string, Readonly<AccessLease>>();
  readonly #removals = new Set<string>();
  readonly #strongReferenceOwnerKinds: ReadonlySet<string>;

  constructor(options: ReferenceGraphOptions = {}) {
    this.#strongReferenceOwnerKinds = new Set(BUILT_IN_STRONG_REFERENCE_OWNER_KINDS);
    if (options.snapshot) this.#restore(options.snapshot);
  }

  registerNode(target: ResourceTarget, outgoing: readonly ResourceTarget[] = []): void {
    assertResourceKind(target.kind, "target.kind");
    assertId(target.id, "target.id");
    const key = targetKey(target);
    const edges = new Set<string>();
    for (const dependency of outgoing) {
      assertResourceKind(dependency.kind, "dependency.kind");
      assertId(dependency.id, "dependency.id");
      edges.add(targetKey(dependency));
    }
    for (const dependency of edges) {
      if (!this.#nodes.has(dependency)) {
        throw new ReferenceGraphError(
          "REFERENCE_GRAPH_TARGET_MISSING",
          `Resource ${key} dependency ${dependency} is not registered`,
        );
      }
    }
    if (
      this.#removals.has(key) ||
      [...edges].some((dependency) => this.#dependsOnRemoval(dependency))
    ) {
      throw new ReferenceGraphError(
        "REFERENCE_GRAPH_REMOVAL_IN_PROGRESS",
        `Resource ${key} cannot add a dependency while removal is in progress`,
      );
    }

    const existing = this.#nodes.get(key);
    if (existing) {
      if (
        existing.size !== edges.size ||
        [...existing].some((dependency) => !edges.has(dependency))
      ) {
        throw new ReferenceGraphError(
          "REFERENCE_GRAPH_NODE_CONFLICT",
          `Resource ${key} was registered with different dependencies`,
        );
      }
      return;
    }
    this.#nodes.set(key, edges);
  }

  hasNode(target: ResourceTarget): boolean {
    return this.#nodes.has(targetKey(target));
  }

  addStrongReference(referenceInput: StrongReference): "created" | "already-present" {
    assertOwnerKind(referenceInput.ownerKind);
    if (!this.#strongReferenceOwnerKinds.has(referenceInput.ownerKind)) {
      throw new ReferenceGraphError(
        "REFERENCE_GRAPH_OWNER_KIND_UNKNOWN",
        `Strong-reference owner kind ${referenceInput.ownerKind} is not registered`,
      );
    }
    assertId(referenceInput.ownerId, "strongReference.ownerId");
    assertResourceKind(referenceInput.targetKind, "strongReference.targetKind");
    assertId(referenceInput.targetId, "strongReference.targetId");
    if (!this.hasNode({ kind: referenceInput.targetKind, id: referenceInput.targetId })) {
      throw new ReferenceGraphError(
        "REFERENCE_GRAPH_TARGET_MISSING",
        `Strong-reference target ${referenceInput.targetKind}:${referenceInput.targetId} is not registered`,
      );
    }
    if (this.#dependsOnRemoval(targetKey({
      kind: referenceInput.targetKind,
      id: referenceInput.targetId,
    }))) {
      throw new ReferenceGraphError(
        "REFERENCE_GRAPH_REMOVAL_IN_PROGRESS",
        "A strong reference cannot make a resource reachable while its dependency is being removed",
      );
    }

    const key = strongReferenceKey(referenceInput);
    if (this.#strongReferences.has(key)) return "already-present";
    this.#strongReferences.set(key, deepFreeze({ ...referenceInput }));
    return "created";
  }

  removeStrongReference(reference: StrongReference): "removed" | "absent" {
    return this.#strongReferences.delete(strongReferenceKey(reference))
      ? "removed"
      : "absent";
  }

  hasStrongReference(reference: StrongReference): boolean {
    return this.#strongReferences.has(strongReferenceKey(reference));
  }

  acquireLease(leaseInput: AccessLease): Readonly<AccessLease> {
    assertId(leaseInput.leaseId, "lease.leaseId");
    assertOwnerKind(leaseInput.ownerKind);
    assertId(leaseInput.ownerId, "lease.ownerId");
    assertResourceKind(leaseInput.targetKind, "lease.targetKind");
    assertId(leaseInput.targetId, "lease.targetId");
    if (
      leaseInput.kind !== "active-claim" &&
      leaseInput.kind !== "run-scope" &&
      leaseInput.kind !== "provider-access" &&
      leaseInput.kind !== "media-read" &&
      leaseInput.kind !== "storage-operation"
    ) {
      throw new ReferenceGraphError(
        "REFERENCE_GRAPH_INPUT_INVALID",
        "lease.kind is not valid",
      );
    }
    for (const [label, value] of [
      ["lease.moduleGenerationId", leaseInput.moduleGenerationId],
      ["lease.moduleJobId", leaseInput.moduleJobId],
      ["lease.runId", leaseInput.runId],
    ] as const) {
      if (value !== undefined) assertId(value, label);
    }
    if (this.#leases.has(leaseInput.leaseId)) {
      throw new ReferenceGraphError(
        "REFERENCE_GRAPH_LEASE_CONFLICT",
        `AccessLease ${leaseInput.leaseId} already exists`,
      );
    }
    if (!this.hasNode({ kind: leaseInput.targetKind, id: leaseInput.targetId })) {
      throw new ReferenceGraphError(
        "REFERENCE_GRAPH_TARGET_MISSING",
        `Lease target ${leaseInput.targetKind}:${leaseInput.targetId} is not registered`,
      );
    }
    if (this.#dependsOnRemoval(targetKey({
      kind: leaseInput.targetKind,
      id: leaseInput.targetId,
    }))) {
      throw new ReferenceGraphError(
        "REFERENCE_GRAPH_REMOVAL_IN_PROGRESS",
        "A lease cannot make a resource reachable while its dependency is being removed",
      );
    }
    if (leaseInput.expiresAt !== undefined) {
      const timestamp = Date.parse(leaseInput.expiresAt);
      if (
        !Number.isFinite(timestamp) ||
        new Date(timestamp).toISOString() !== leaseInput.expiresAt
      ) {
        throw new ReferenceGraphError(
          "REFERENCE_GRAPH_INPUT_INVALID",
          "lease.expiresAt must be a canonical ISO 8601 UTC timestamp",
        );
      }
    }

    const lease = deepFreeze({ ...leaseInput });
    this.#leases.set(lease.leaseId, lease);
    return lease;
  }

  releaseLease(leaseId: string): "released" | "absent" {
    return this.#leases.delete(leaseId) ? "released" : "absent";
  }

  hasLease(leaseId: string): boolean {
    return this.#leases.has(leaseId);
  }

  getLease(leaseId: string): Readonly<AccessLease> | null {
    return this.#leases.get(leaseId) ?? null;
  }

  isReachable(target: ResourceTarget): boolean {
    return this.reachableKeys().has(targetKey(target));
  }

  /**
   * Returns whether a persistent strong reference reaches the target. Access
   * leases are deliberately excluded because they cannot take over durable
   * ownership from another record.
   */
  isReachableFromStrongReference(target: ResourceTarget): boolean {
    return this.reachableKeys(false).has(targetKey(target));
  }

  unreachable(kind: ResourceKind): readonly ResourceTarget[] {
    const reachable = this.reachableKeys();
    const result: ResourceTarget[] = [];
    for (const key of this.#nodes.keys()) {
      if (!reachable.has(key) && key.startsWith(`${kind}:`)) {
        result.push({ kind, id: key.slice(kind.length + 1) });
      }
    }
    return result;
  }

  /**
   * Marks unreachable resources for asynchronous deletion. While marked, no
   * strong reference, lease, or new dependency can make them reachable.
   */
  beginRemoval(targets: readonly ResourceTarget[]): void {
    const keys = this.#removalKeys(targets, "begin");
    const reachable = this.reachableKeys();
    for (const key of keys) {
      if (reachable.has(key)) {
        throw new ReferenceGraphError(
          "REFERENCE_GRAPH_NODE_REACHABLE",
          `Resource ${key} is still reachable`,
        );
      }
    }
    this.#assertNoDependents(keys);
    for (const key of keys) this.#removals.add(key);
  }

  completeRemoval(targets: readonly ResourceTarget[]): void {
    const keys = this.#removalKeys(targets, "complete");
    const reachable = this.reachableKeys();
    for (const key of keys) {
      if (reachable.has(key)) {
        throw new ReferenceGraphError(
          "REFERENCE_GRAPH_NODE_REACHABLE",
          `Resource ${key} became reachable during removal`,
        );
      }
    }
    this.#assertNoDependents(keys);
    for (const key of keys) {
      this.#nodes.delete(key);
      this.#removals.delete(key);
    }
  }

  cancelRemoval(targets: readonly ResourceTarget[]): void {
    for (const target of targets) {
      assertResourceKind(target.kind, "target.kind");
      assertId(target.id, "target.id");
      this.#removals.delete(targetKey(target));
    }
  }

  unregisterUnreachable(targets: readonly ResourceTarget[]): void {
    this.beginRemoval(targets);
    try {
      this.completeRemoval(targets);
    } catch (error) {
      this.cancelRemoval(targets);
      throw error;
    }
  }

  #removalKeys(targets: readonly ResourceTarget[], phase: "begin" | "complete"): Set<string> {
    const keys = new Set<string>();
    for (const target of targets) {
      assertResourceKind(target.kind, "target.kind");
      assertId(target.id, "target.id");
      const key = targetKey(target);
      if (!this.#nodes.has(key)) {
        throw new ReferenceGraphError(
          "REFERENCE_GRAPH_TARGET_MISSING",
          `Removal target ${key} is not registered`,
        );
      }
      if (phase === "begin" && this.#removals.has(key)) {
        throw new ReferenceGraphError(
          "REFERENCE_GRAPH_REMOVAL_IN_PROGRESS",
          `Removal of resource ${key} is already in progress`,
        );
      }
      if (phase === "complete" && !this.#removals.has(key)) {
        throw new ReferenceGraphError(
          "REFERENCE_GRAPH_REMOVAL_IN_PROGRESS",
          `Removal of resource ${key} was not started`,
        );
      }
      keys.add(key);
    }
    return keys;
  }

  #assertNoDependents(keys: ReadonlySet<string>): void {
    for (const [key, dependencies] of this.#nodes) {
      if (!keys.has(key) && [...dependencies].some((dependency) => keys.has(dependency))) {
        throw new ReferenceGraphError(
          "REFERENCE_GRAPH_NODE_REFERENCED",
          `Resource ${key} still references a removal target`,
        );
      }
    }
  }

  #dependsOnRemoval(startKey: string): boolean {
    const visited = new Set<string>();
    const queue = [startKey];
    while (queue.length > 0) {
      const key = queue.shift()!;
      if (visited.has(key)) continue;
      visited.add(key);
      if (this.#removals.has(key)) return true;
      for (const dependency of this.#nodes.get(key) ?? []) queue.push(dependency);
    }
    return false;
  }

  strongReferenceCountFor(target: ResourceTarget): number {
    let count = 0;
    for (const reference of this.#strongReferences.values()) {
      if (reference.targetKind === target.kind && reference.targetId === target.id) count += 1;
    }
    return count;
  }

  leaseCountFor(target: ResourceTarget): number {
    let count = 0;
    for (const lease of this.#leases.values()) {
      if (lease.targetKind === target.kind && lease.targetId === target.id) count += 1;
    }
    return count;
  }

  snapshot(): ReferenceGraphSnapshot {
    const nodes = [...this.#nodes.entries()]
      .map(([key, outgoing]) => ({
        target: targetFromKey(key),
        outgoing: [...outgoing].map(targetFromKey).sort((left, right) => {
          const leftKey = targetKey(left);
          const rightKey = targetKey(right);
          return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
        }),
      }))
      .sort((left, right) => {
        const leftKey = targetKey(left.target);
        const rightKey = targetKey(right.target);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      });
    const strongReferences = [...this.#strongReferences.values()].sort((left, right) => {
      const leftKey = strongReferenceKey(left);
      const rightKey = strongReferenceKey(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    const leases = [...this.#leases.values()].sort((left, right) =>
      left.leaseId < right.leaseId ? -1 : left.leaseId > right.leaseId ? 1 : 0,
    );
    return deepFreeze({
      schemaVersion: "dolly.reference-graph/4" as const,
      nodes,
      strongReferences,
      leases,
    });
  }

  #restore(snapshot: ReferenceGraphSnapshot): void {
    assertClosedObject(
      snapshot,
      ["schemaVersion", "nodes", "strongReferences", "leases"],
      "snapshot",
    );
    if (
      snapshot.schemaVersion !== "dolly.reference-graph/4" ||
      !Array.isArray(snapshot.nodes) ||
      !Array.isArray(snapshot.strongReferences) ||
      !Array.isArray(snapshot.leases)
    ) {
      throw new ReferenceGraphError(
        "REFERENCE_GRAPH_INPUT_INVALID",
        "Reference graph snapshot schema is invalid",
      );
    }
    const nodeKeys = new Set<string>();
    const restoredNodes: Array<{
      readonly target: ResourceTarget;
      readonly outgoing: readonly ResourceTarget[];
    }> = [];
    for (const node of snapshot.nodes) {
      assertClosedObject(node, ["target", "outgoing"], "snapshot node");
      assertClosedObject(node.target, ["kind", "id"], "snapshot node target");
      if (!Array.isArray(node.outgoing)) {
        throw new ReferenceGraphError(
          "REFERENCE_GRAPH_INPUT_INVALID",
          "Reference graph node snapshot is invalid",
        );
      }
      assertResourceKind(node.target.kind, "snapshot node target.kind");
      assertId(node.target.id, "snapshot node target.id");
      const key = targetKey(node.target);
      if (nodeKeys.has(key)) {
        throw new ReferenceGraphError(
          "REFERENCE_GRAPH_NODE_CONFLICT",
          `Reference graph node ${key} is duplicated`,
        );
      }
      const outgoingKeys = new Set<string>();
      for (const dependency of node.outgoing) {
        assertClosedObject(
          dependency,
          ["kind", "id"],
          "snapshot node dependency",
        );
        assertResourceKind(dependency.kind, "snapshot node dependency.kind");
        assertId(dependency.id, "snapshot node dependency.id");
        const dependencyKey = targetKey(dependency);
        if (outgoingKeys.has(dependencyKey)) {
          throw new ReferenceGraphError(
            "REFERENCE_GRAPH_NODE_CONFLICT",
            `Reference graph node ${key} contains a duplicate dependency`,
          );
        }
        outgoingKeys.add(dependencyKey);
      }
      nodeKeys.add(key);
      restoredNodes.push({ target: node.target, outgoing: node.outgoing });
    }

    // Snapshot order is not dependency order. Register every node first, then
    // attach only dependencies that resolve within that complete node set.
    for (const node of restoredNodes) this.registerNode(node.target);
    for (const node of restoredNodes) {
      const dependencies = new Set(node.outgoing.map(targetKey));
      for (const dependency of dependencies) {
        if (!this.#nodes.has(dependency)) {
          throw new ReferenceGraphError(
            "REFERENCE_GRAPH_TARGET_MISSING",
            `Reference graph snapshot dependency ${dependency} is missing`,
          );
        }
      }
      this.#nodes.set(targetKey(node.target), dependencies);
    }
    const strongReferenceKeys = new Set<string>();
    for (const reference of snapshot.strongReferences) {
      assertClosedObject(
        reference,
        ["ownerKind", "ownerId", "targetKind", "targetId"],
        "snapshot strong reference",
      );
      const key = strongReferenceKey(reference);
      if (strongReferenceKeys.has(key)) {
        throw new ReferenceGraphError(
          "REFERENCE_GRAPH_NODE_CONFLICT",
          "Strong reference is duplicated",
        );
      }
      strongReferenceKeys.add(key);
      this.addStrongReference(reference);
    }
    const leaseIds = new Set<string>();
    for (const lease of snapshot.leases) {
      assertClosedObject(
        lease,
        [
          "leaseId",
          "ownerKind",
          "ownerId",
          "targetKind",
          "targetId",
          "kind",
          "moduleGenerationId",
          "moduleJobId",
          "runId",
          "expiresAt",
        ],
        "snapshot lease",
      );
      if (leaseIds.has(lease.leaseId)) {
        throw new ReferenceGraphError(
          "REFERENCE_GRAPH_LEASE_CONFLICT",
          `AccessLease ${lease.leaseId} is duplicated`,
        );
      }
      leaseIds.add(lease.leaseId);
      this.acquireLease(lease);
    }
  }

  private reachableKeys(includeLeases = true): Set<string> {
    const reachable = new Set<string>();
    const queue = [
      ...[...this.#strongReferences.values()].map((reference) =>
        targetKey({ kind: reference.targetKind, id: reference.targetId }),
      ),
      ...(includeLeases
        ? [...this.#leases.values()].map((lease) =>
            targetKey({ kind: lease.targetKind, id: lease.targetId }),
          )
        : []),
    ];

    while (queue.length > 0) {
      const key = queue.shift()!;
      if (reachable.has(key)) continue;
      reachable.add(key);
      for (const dependency of this.#nodes.get(key) ?? []) {
        if (!reachable.has(dependency)) queue.push(dependency);
      }
    }
    return reachable;
  }
}
