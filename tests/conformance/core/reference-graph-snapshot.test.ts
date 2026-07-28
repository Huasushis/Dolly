import { describe, expect, it } from "vitest";
import {
  ReferenceGraph,
  ReferenceGraphError,
  type ReferenceGraphSnapshot,
} from "../../../src/core/reference-graph.js";

describe("Core reference graph restart snapshot", () => {
  it("rejects reference graph version 1 and its processingId lease field", () => {
    const previousVersion = {
      schemaVersion: "dolly.reference-graph/1",
      nodes: [],
      strongReferences: [],
      leases: [],
    } as unknown as ReferenceGraphSnapshot;
    expect(() => new ReferenceGraph({ snapshot: previousVersion })).toThrowError(
      expect.objectContaining<Partial<ReferenceGraphError>>({
        code: "REFERENCE_GRAPH_INPUT_INVALID",
      }),
    );

    const previousField = {
      schemaVersion: "dolly.reference-graph/2",
      nodes: [{ target: { kind: "block", id: "block-1" }, outgoing: [] }],
      strongReferences: [],
      leases: [{
        leaseId: "lease-1",
        ownerKind: "module-job",
        ownerId: "module-job-1",
        targetKind: "block",
        targetId: "block-1",
        kind: "active-claim",
        processingId: "module-job-1",
      }],
    } as unknown as ReferenceGraphSnapshot;
    expect(() => new ReferenceGraph({ snapshot: previousField })).toThrowError(
      expect.objectContaining<Partial<ReferenceGraphError>>({
        code: "REFERENCE_GRAPH_INPUT_INVALID",
      }),
    );
  });

  it("rejects the old lifetime-graph snapshot and its roots field", () => {
    const previous = {
      schemaVersion: "dolly.lifetime-graph/3",
      nodes: [],
      roots: [],
      leases: [],
    } as unknown as ReferenceGraphSnapshot;

    expect(() => new ReferenceGraph({ snapshot: previous })).toThrowError(
      expect.objectContaining<Partial<ReferenceGraphError>>({
        code: "REFERENCE_GRAPH_INPUT_INVALID",
      }),
    );
  });

  it("restores dependency reachability, strong references, and access leases exactly", () => {
    const original = new ReferenceGraph();
    original.registerNode({ kind: "media", id: "media-1" });
    original.registerNode(
      { kind: "block", id: "block-1" },
      [{ kind: "media", id: "media-1" }],
    );
    original.addStrongReference({
      ownerKind: "commit",
      ownerId: "owner-1",
      targetKind: "block",
      targetId: "block-1",
    });
    original.acquireLease({
      leaseId: "lease-1",
      ownerKind: "module",
      ownerId: "module-1",
      targetKind: "media",
      targetId: "media-1",
      kind: "active-claim",
      moduleGenerationId: "generation-1",
      moduleJobId: "module-job-1",
      runId: "run-1",
      expiresAt: "2026-07-24T00:00:00.000Z",
    });

    const snapshot = original.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.nodes.map((node) => `${node.target.kind}:${node.target.id}`)).toEqual([
      "block:block-1",
      "media:media-1",
    ]);
    const restored = new ReferenceGraph({ snapshot: structuredClone(snapshot) });
    expect(restored.snapshot()).toEqual(snapshot);
    expect(restored.isReachable({ kind: "media", id: "media-1" })).toBe(true);
    expect(restored.strongReferenceCountFor({ kind: "block", id: "block-1" })).toBe(1);
    expect(restored.leaseCountFor({ kind: "media", id: "media-1" })).toBe(1);

    restored.removeStrongReference({
      ownerKind: "commit",
      ownerId: "owner-1",
      targetKind: "block",
      targetId: "block-1",
    });
    expect(restored.isReachable({ kind: "media", id: "media-1" })).toBe(true);
    restored.releaseLease("lease-1");
    expect(restored.unreachable("block")).toEqual([{ kind: "block", id: "block-1" }]);
    expect(restored.unreachable("media")).toEqual([{ kind: "media", id: "media-1" }]);
  });

  it("rejects duplicate nodes, dangling dependencies, and invalid lease fences", () => {
    const duplicate: ReferenceGraphSnapshot = {
      schemaVersion: "dolly.reference-graph/4",
      nodes: [
        { target: { kind: "block", id: "block-1" }, outgoing: [] },
        { target: { kind: "block", id: "block-1" }, outgoing: [] },
      ],
      strongReferences: [],
      leases: [],
    };
    expect(() => new ReferenceGraph({ snapshot: duplicate })).toThrowError(
      expect.objectContaining<Partial<ReferenceGraphError>>({
        code: "REFERENCE_GRAPH_NODE_CONFLICT",
      }),
    );
    expect(() => new ReferenceGraph({
      snapshot: {
        schemaVersion: "dolly.reference-graph/4",
        nodes: [{
          target: { kind: "block", id: "block-1" },
          outgoing: [{ kind: "media", id: "missing" }],
        }],
        strongReferences: [],
        leases: [],
      },
    })).toThrowError(expect.objectContaining<Partial<ReferenceGraphError>>({
      code: "REFERENCE_GRAPH_TARGET_MISSING",
    }));

    const graph = new ReferenceGraph();
    graph.registerNode({ kind: "block", id: "block-1" });
    expect(() => graph.acquireLease({
      leaseId: "lease-1",
      ownerKind: "module",
      ownerId: "module-1",
      targetKind: "block",
      targetId: "block-1",
      kind: "active-claim",
      runId: "invalid run",
    })).toThrowError(expect.objectContaining<Partial<ReferenceGraphError>>({
      code: "REFERENCE_GRAPH_INPUT_INVALID",
    }));

    expect(() => graph.acquireLease({
      leaseId: "lease-2",
      ownerKind: "module",
      ownerId: "module-1",
      targetKind: "block",
      targetId: "block-1",
      kind: "run-scope",
      expiresAt: "2026-07-24T00:00:00+00:00",
    })).toThrowError(expect.objectContaining<Partial<ReferenceGraphError>>({
      code: "REFERENCE_GRAPH_INPUT_INVALID",
    }));

    expect(() => graph.registerNode(
      { kind: "block", id: "block-2" },
      [{ kind: "media", id: "missing" }],
    )).toThrowError(expect.objectContaining<Partial<ReferenceGraphError>>({
      code: "REFERENCE_GRAPH_TARGET_MISSING",
    }));
    expect(graph.hasNode({ kind: "block", id: "block-2" })).toBe(false);
    expect(graph.isReachable({ kind: "media", id: "missing" })).toBe(false);

    expect(() => graph.addStrongReference({
      ownerKind: "unknown-owner",
      ownerId: "owner-1",
      targetKind: "block",
      targetId: "block-1",
    })).toThrowError(expect.objectContaining<Partial<ReferenceGraphError>>({
      code: "REFERENCE_GRAPH_OWNER_KIND_UNKNOWN",
    }));

    expect(() => new ReferenceGraph({
      snapshot: {
        schemaVersion: "dolly.reference-graph/4",
        nodes: [{
          target: { kind: "block", id: "block-1" },
          outgoing: [null],
        }],
        strongReferences: [],
        leases: [],
      } as never,
    })).toThrowError(expect.objectContaining<Partial<ReferenceGraphError>>({
      code: "REFERENCE_GRAPH_INPUT_INVALID",
    }));
  });

  it("rejects the preceding reference graph schema version", () => {
    expect(() => new ReferenceGraph({
      snapshot: {
        schemaVersion: "dolly.reference-graph/3",
        nodes: [],
        strongReferences: [],
        leases: [],
      } as never,
    })).toThrowError(expect.objectContaining<Partial<ReferenceGraphError>>({
      code: "REFERENCE_GRAPH_INPUT_INVALID",
    }));
  });

  it("retains a target until every strong reference and access lease is released", () => {
    const graph = new ReferenceGraph();
    graph.registerNode({ kind: "media", id: "media-1" });
    graph.addStrongReference({
      ownerKind: "commit",
      ownerId: "owner-1",
      targetKind: "media",
      targetId: "media-1",
    });
    graph.addStrongReference({
      ownerKind: "delivery",
      ownerId: "owner-2",
      targetKind: "media",
      targetId: "media-1",
    });
    graph.acquireLease({
      leaseId: "lease-1",
      ownerKind: "module",
      ownerId: "module-1",
      targetKind: "media",
      targetId: "media-1",
      kind: "run-scope",
    });

    graph.removeStrongReference({
      ownerKind: "commit",
      ownerId: "owner-1",
      targetKind: "media",
      targetId: "media-1",
    });
    expect(graph.strongReferenceCountFor({ kind: "media", id: "media-1" })).toBe(1);
    expect(graph.isReachable({ kind: "media", id: "media-1" })).toBe(true);
    graph.removeStrongReference({
      ownerKind: "delivery",
      ownerId: "owner-2",
      targetKind: "media",
      targetId: "media-1",
    });
    expect(graph.strongReferenceCountFor({ kind: "media", id: "media-1" })).toBe(0);
    expect(graph.isReachable({ kind: "media", id: "media-1" })).toBe(true);

    graph.releaseLease("lease-1");
    expect(graph.isReachable({ kind: "media", id: "media-1" })).toBe(false);
  });

  it("prevents new reachability and preserves dependencies during removal", () => {
    const graph = new ReferenceGraph();
    graph.registerNode({ kind: "media", id: "media-1" });
    graph.registerNode(
      { kind: "block", id: "block-1" },
      [{ kind: "media", id: "media-1" }],
    );

    expect(() => graph.beginRemoval([{ kind: "media", id: "media-1" }])).toThrowError(
      expect.objectContaining<Partial<ReferenceGraphError>>({
        code: "REFERENCE_GRAPH_NODE_REFERENCED",
      }),
    );
    graph.unregisterUnreachable([{ kind: "block", id: "block-1" }]);
    graph.beginRemoval([{ kind: "media", id: "media-1" }]);
    expect(() => graph.addStrongReference({
      ownerKind: "commit",
      ownerId: "owner-1",
      targetKind: "media",
      targetId: "media-1",
    })).toThrowError(expect.objectContaining<Partial<ReferenceGraphError>>({
      code: "REFERENCE_GRAPH_REMOVAL_IN_PROGRESS",
    }));
    expect(() => graph.registerNode(
      { kind: "block", id: "block-2" },
      [{ kind: "media", id: "media-1" }],
    )).toThrowError(expect.objectContaining<Partial<ReferenceGraphError>>({
      code: "REFERENCE_GRAPH_REMOVAL_IN_PROGRESS",
    }));

    graph.cancelRemoval([{ kind: "media", id: "media-1" }]);
    expect(graph.addStrongReference({
      ownerKind: "commit",
      ownerId: "owner-1",
      targetKind: "media",
      targetId: "media-1",
    })).toBe("created");
  });
});
