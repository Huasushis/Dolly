import { describe, expect, it } from "vitest";

import { MemoryError } from "../../../src/extensions/memory/errors.js";
import {
  assertNamespaceAuthorized,
  authenticateDelivery,
  authenticateNamespace,
  namespaceScopedKey,
} from "../../../src/extensions/memory/namespace.js";
import { parseMemoryQuery } from "../../../src/extensions/memory/retrieval.js";
import {
  delivered,
  grantAll,
  harness,
  identity,
  indexInputs,
  namespaceFor,
  textBlock,
} from "./fixtures.js";

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof MemoryError) return error.code;
    return `unexpected:${String(error)}`;
  }
  return "no-error";
}

/** §3 invariant 1, §4.1, §4.2, §4.3. */
describe("memory namespace isolation", () => {
  it("gives every distinct identity component a distinct namespace key", () => {
    const base = namespaceFor();
    const differing = [
      namespaceFor({ identity: identity({ instanceId: "instance-b" }) }),
      namespaceFor({ identity: identity({ ownerScopeId: "owner-b" }) }),
      namespaceFor({ identity: identity({ memoryModuleInstanceId: "memory-b" }) }),
      namespaceFor({ identity: identity({ sessionId: "session-2" }) }),
      namespaceFor({ inputPageId: "page-other" }),
      namespaceFor({
        retention: {
          kind: "owner-long-term",
          memorySpaceId: "space-1",
          grantedOwnerScopeId: "owner-a",
        },
      }),
    ];
    for (const namespace of differing) {
      expect(namespace.namespaceKey).not.toBe(base.namespaceKey);
    }
    expect(new Set(differing.map((entry) => entry.namespaceKey)).size).toBe(differing.length);
  });

  it("is stable for the same six-tuple", () => {
    expect(namespaceFor().namespaceKey).toBe(namespaceFor().namespaceKey);
  });

  it("fails closed on a missing owner or session instead of using a shared default", () => {
    expect(
      codeOf(() =>
        authenticateNamespace({
          identity: identity({ ownerScopeId: "" as string }),
          inputPageId: "page-main",
          retention: { kind: "session" },
        }),
      ),
    ).toBe("MEMORY_IDENTITY_MISSING");
    expect(
      codeOf(() =>
        authenticateNamespace({
          identity: { ...identity(), sessionId: undefined as unknown as string },
          inputPageId: "page-main",
          retention: { kind: "session" },
        }),
      ),
    ).toBe("MEMORY_IDENTITY_MISSING");
    // "default" is a legal identifier, so it is only reachable when a
    // deployment states it. It is never substituted.
    const explicit = authenticateNamespace({
      identity: identity({ ownerScopeId: "default" }),
      inputPageId: "page-main",
      retention: { kind: "session" },
    });
    expect(explicit.ownerScopeId).toBe("default");
    expect(explicit.namespaceKey).not.toBe(namespaceFor().namespaceKey);
  });

  it("refuses an owner-long-term space that belongs to another owner", () => {
    expect(
      codeOf(() =>
        authenticateNamespace({
          identity: identity(),
          inputPageId: "page-main",
          retention: {
            kind: "owner-long-term",
            memorySpaceId: "space-1",
            grantedOwnerScopeId: "owner-b",
          },
        }),
      ),
    ).toBe("MEMORY_SCOPE_DENIED");
  });

  it("rechecks authorization per operation, not only at namespace creation", () => {
    const namespace = namespaceFor();
    const readOnly = {
      grants: [{ namespaceKey: namespace.namespaceKey, operations: ["query" as const] }],
    };
    expect(() => assertNamespaceAuthorized(readOnly, namespace, "query")).not.toThrow();
    for (const operation of ["delete", "export", "reindex", "retention-change"] as const) {
      expect(codeOf(() => assertNamespaceAuthorized(readOnly, namespace, operation))).toBe(
        "MEMORY_SCOPE_DENIED",
      );
    }
  });

  it("keeps every scoped key inside its namespace", () => {
    const left = namespaceScopedKey(namespaceFor(), "records", "r1");
    const right = namespaceScopedKey(namespaceFor({ inputPageId: "page-other" }), "records", "r1");
    expect(left).not.toBe(right);
    expect(left.startsWith(namespaceFor().namespaceKey)).toBe(true);
  });

  it("takes the source Page from Delivery metadata and rejects a malformed one", () => {
    const context = authenticateDelivery({
      deliveryId: "d1",
      inputPageId: "page-main",
      pageSequence: 3,
      sourceBlockId: "b1",
      coreSequence: 9,
      sourceModuleInstanceId: "console-a",
    });
    expect(context.inputPageId).toBe("page-main");
    expect(
      codeOf(() =>
        authenticateDelivery({
          deliveryId: "d1",
          inputPageId: "page main",
          pageSequence: 3,
          sourceBlockId: "b1",
          coreSequence: 9,
          sourceModuleInstanceId: "console-a",
        }),
      ),
    ).toBe("MEMORY_IDENTITY_INVALID");
  });
});

/** §4.3: a model-generated query cannot broaden its own scope. */
describe("memory query scope", () => {
  it("rejects every namespace-shaped field a payload could carry", () => {
    for (const field of [
      "ownerScopeId",
      "instanceId",
      "memoryModuleInstanceId",
      "sessionId",
      "pageId",
      "inputPageId",
      "namespace",
      "namespaceKey",
      "retentionScopeKind",
      "retentionScopeId",
      "scope",
    ]) {
      expect(
        codeOf(() =>
          parseMemoryQuery({
            requestId: "q1",
            text: "hello",
            mode: "lexical",
            [field]: "owner-b",
          }),
        ),
      ).toBe("MEMORY_QUERY_INVALID");
    }
  });

  it("accepts only the closed baseline query fields", () => {
    const query = parseMemoryQuery({
      requestId: "q1",
      text: "hello",
      mode: "lexical",
      limit: 3,
      contextExpansion: 1,
      mediaItemIndices: [0],
    });
    expect(Object.keys(query).sort()).toEqual([
      "contextExpansion",
      "limit",
      "mediaItemIndices",
      "mode",
      "requestId",
      "text",
    ]);
  });
});

/** §4.2: two Pages, two subnamespaces, no cross-visibility. */
describe("memory page and owner isolation over committed data", () => {
  it("keeps records of two Pages in separate namespaces of one store", async () => {
    const pageA = harness();
    const pageB = harness({
      namespace: namespaceFor({ inputPageId: "page-other" }),
      journal: pageA.journal,
    });
    // Both harnesses share one journal, so this is one physical store.
    await indexInputs(pageA, [
      delivered({ deliveryId: "da", sourceBlockId: "ba", block: textBlock("alpha budget report") }),
    ]);
    await indexInputs(pageB, [
      delivered({
        deliveryId: "db",
        sourceBlockId: "bb",
        block: textBlock("beta budget report"),
        inputPageId: "page-other",
      }),
    ]);

    const sessionA = pageA.store.session(pageA.namespace, pageA.authorization, "query");
    const sessionB = pageB.store.session(pageB.namespace, pageB.authorization, "query");
    expect(sessionA.records().map((record) => record.sourceBlockId)).toEqual(["ba"]);
    expect(sessionB.records().map((record) => record.sourceBlockId)).toEqual(["bb"]);
    expect(sessionA.records().every((record) => record.inputPageId === "page-main")).toBe(true);
  });

  it("denies a session whose namespace runtime policy did not grant", () => {
    const mine = harness();
    const other = namespaceFor({ identity: identity({ ownerScopeId: "owner-b" }) });
    expect(
      codeOf(() => mine.store.session(other, grantAll(mine.namespace), "query")),
    ).toBe("MEMORY_SCOPE_DENIED");
  });
});
