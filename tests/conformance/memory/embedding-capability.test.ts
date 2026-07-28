import { describe, expect, it } from "vitest";

import {
  assertModalitiesComparable,
  assertModalitySupported,
  resolveMemoryEmbeddingCapability,
  validateEmbeddingOutcomes,
  type MemoryEmbeddingItem,
} from "../../../src/extensions/memory/embedding-capability.js";
import { MemoryError } from "../../../src/extensions/memory/errors.js";
import { createFeaturePlan } from "../../../src/extensions/memory/feature-plan.js";
import {
  assertFeatureRetainsNoMediaBytes,
  createFeatureRecord,
} from "../../../src/extensions/memory/records.js";
import { validateMemoryConfig } from "../../../src/extensions/memory/config.js";
import {
  delivered,
  harness,
  indexInputs,
  nativeImageSnapshot,
  separateSpaceImageSnapshot,
  textOnlyCapability,
  textOnlySnapshot,
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

const IMAGE_MODALITIES = { modalityOf: () => "image" };

/** §3 invariant 7, §9.1, §9.2. */
describe("embedding support comes from the descriptor", () => {
  it("treats a vision-sounding model as text-only when its descriptor says so", () => {
    const capability = textOnlyCapability({ modelId: "qwen-vl-plus-embedding" });
    expect(capability.modelId).toContain("vl");
    expect(capability.supportsText).toBe(true);
    expect(capability.supportedMediaModalities).toEqual([]);
    expect(() => assertModalitySupported(capability, "text")).not.toThrow();
    expect(codeOf(() => assertModalitySupported(capability, "image"))).toBe(
      "MEMORY_MODALITY_UNSUPPORTED",
    );
  });

  it("accepts image only when the descriptor declares an image requirement", () => {
    const capability = resolveMemoryEmbeddingCapability(nativeImageSnapshot());
    expect(capability.supportedMediaModalities).toEqual(["image"]);
    expect(() => assertModalitySupported(capability, "image")).not.toThrow();
    expect(codeOf(() => assertModalitySupported(capability, "audio"))).toBe(
      "MEMORY_MODALITY_UNSUPPORTED",
    );
  });

  it("requires a declared shared vector space for cross-modal comparison", () => {
    const shared = resolveMemoryEmbeddingCapability(nativeImageSnapshot());
    expect(() => assertModalitiesComparable(shared, ["text", "image"])).not.toThrow();

    const separate = resolveMemoryEmbeddingCapability(separateSpaceImageSnapshot());
    expect(separate.supportedMediaModalities).toEqual(["image"]);
    // Same endpoint, same dimension, same metric — and still not comparable,
    // because the descriptor declares no shared modality set.
    expect(separate.vectorSpace.dimension).toBe(shared.vectorSpace.dimension);
    expect(codeOf(() => assertModalitiesComparable(separate, ["text", "image"]))).toBe(
      "MEMORY_VECTOR_SPACE_INCOMPATIBLE",
    );
  });

  it("refuses to pin a multi-dimension descriptor without an explicit dimension", () => {
    const snapshot = textOnlySnapshot();
    const document = {
      ...snapshot.document,
      features: { ...snapshot.document.features, dimensions: { kind: "allowed", values: [8, 16] } },
    };
    const variable = { ...snapshot, document } as typeof snapshot;
    expect(codeOf(() => resolveMemoryEmbeddingCapability(variable))).toBe("MEMORY_CONFIG_INVALID");
    expect(
      resolveMemoryEmbeddingCapability(variable, { outputDimension: 8 }).vectorSpace.dimension,
    ).toBe(8);
    expect(codeOf(() => resolveMemoryEmbeddingCapability(variable, { outputDimension: 9 }))).toBe(
      "MEMORY_CONFIG_INVALID",
    );
  });

  it("refuses native image embedding against a text-only descriptor at plan time", () => {
    const capability = textOnlyCapability();
    expect(
      codeOf(() =>
        createFeaturePlan({
          extractor: harness().extractor.contract,
          embedding: capability,
          mediaPolicies: [{ modality: "image", policy: { kind: "native-embedding" } }],
        }),
      ),
    ).toBe("MEMORY_MODALITY_UNSUPPORTED");
  });

  it("refuses a configuration that selects native media embedding with no descriptor", () => {
    expect(
      codeOf(() =>
        validateMemoryConfig({
          schemaVersion: "dolly.memory-config/1",
          mediaPolicyByModality: { image: "native-embedding" },
        }),
      ),
    ).toBe("MEMORY_CONFIG_INVALID");
    expect(
      codeOf(() =>
        validateMemoryConfig({ schemaVersion: "dolly.memory-config/1", retrievalMode: "hybrid" }),
      ),
    ).toBe("MEMORY_CONFIG_INVALID");
    expect(
      validateMemoryConfig({
        schemaVersion: "dolly.memory-config/1",
        retrievalMode: "hybrid",
        degradedMode: "lexical",
      }).retrievalMode,
    ).toBe("hybrid");
  });
});

/** §3 invariant 7 and §8.3: unsupported modalities stay visibly unsupported. */
describe("media policy", () => {
  const mediaBlock = {
    payloadSchema: "dolly.content/1" as const,
    content: {
      items: [
        { type: "text" as const, text: "a photo of the whiteboard after the meeting" },
        { type: "media-reference" as const, mediaId: "m1" },
      ],
    },
  };

  it("records a visible skip rather than a silent one for policy skip", async () => {
    const h = harness({
      withEmbedding: true,
      mediaPolicies: [{ modality: "image", policy: { kind: "skip" } }],
    });
    await indexInputs(
      h,
      [delivered({ deliveryId: "d1", sourceBlockId: "b1", block: mediaBlock })],
      { mediaModalities: IMAGE_MODALITIES },
    );
    const records = h.store.session(h.namespace, h.authorization, "query").records();
    expect(records).toHaveLength(1);
    expect(records[0]!.skippedFeatures).toEqual([
      { kind: "native-embedding", modality: "image", reason: "MODALITY_SKIPPED" },
    ]);
  });

  it("fails the modality visibly when no policy is configured for it", async () => {
    const h = harness({ withEmbedding: true });
    await indexInputs(
      h,
      [delivered({ deliveryId: "d1", sourceBlockId: "b1", block: mediaBlock })],
      { mediaModalities: IMAGE_MODALITIES },
    );
    const records = h.store.session(h.namespace, h.authorization, "query").records();
    expect(records[0]!.skippedFeatures).toEqual([
      { kind: "native-embedding", modality: "image", reason: "MEMORY_MODALITY_UNSUPPORTED" },
    ]);
  });

  it("never labels a text vector as a media feature under a derived-text policy", async () => {
    const h = harness({
      withEmbedding: true,
      mediaPolicies: [
        {
          modality: "image",
          policy: {
            kind: "derived-text",
            transformationId: "fixture.ocr",
            transformationVersion: "1",
            transformationDescriptorDigest: `sha256:${"a".repeat(64)}`,
          },
        },
      ],
    });
    await indexInputs(
      h,
      [delivered({ deliveryId: "d1", sourceBlockId: "b1", block: mediaBlock })],
      { mediaModalities: IMAGE_MODALITIES },
    );
    const query = h.store.session(h.namespace, h.authorization, "query");
    expect(query.records()[0]!.skippedFeatures).toEqual([
      {
        kind: "derived-text-embedding",
        modality: "image",
        reason: "MEDIA_FEATURE_NOT_IMPLEMENTED",
      },
    ]);
    // Only the text segment produced features, and both name modality "text".
    expect(query.features().map((feature) => feature.sourceModality)).toEqual(["text", "text"]);
  });

  it("retains no media bytes, path, URL, or object key in a feature", async () => {
    const h = harness({
      withEmbedding: true,
      mediaPolicies: [{ modality: "image", policy: { kind: "skip" } }],
    });
    await indexInputs(
      h,
      [delivered({ deliveryId: "d1", sourceBlockId: "b1", block: mediaBlock })],
      { mediaModalities: IMAGE_MODALITIES },
    );
    const serialized = JSON.stringify(
      h.store.session(h.namespace, h.authorization, "query").features(),
    );
    for (const forbidden of ["http", "file:", "data:", "oss:", "s3:", "\\\\", "/var/"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("rejects a feature that carries a locator", () => {
    const feature = createFeatureRecord({
      recordId: "r1",
      namespaceKey: "n1",
      kind: "native-embedding",
      sourceModality: "image",
      pipelineId: "fixture",
      pipelineVersion: "1",
      generationId: "g1",
      featureJobId: "j1",
      status: "committed",
      sourceMediaId: "https://example.invalid/private/m1.png?signature=abc",
    });
    expect(codeOf(() => assertFeatureRetainsNoMediaBytes(feature))).toBe("MEMORY_RECORD_INVALID");
  });
});

/** §5.5 and §9.3: correlated batches and labelled provenance. */
describe("embedding responses", () => {
  const capability = textOnlyCapability();
  const items: readonly MemoryEmbeddingItem[] = [
    { itemId: "r1", kind: "text", text: "one" },
    { itemId: "r2", kind: "text", text: "two" },
  ];
  const good = (itemId: string) => ({
    itemId,
    status: "succeeded" as const,
    vector: new Array(capability.vectorSpace.dimension).fill(0.5),
  });

  it("rejects an item ID that was not requested and a repeated item ID", () => {
    expect(codeOf(() => validateEmbeddingOutcomes(capability, items, [good("r3")]))).toBe(
      "MEMORY_JOB_STATE_INVALID",
    );
    expect(
      codeOf(() => validateEmbeddingOutcomes(capability, items, [good("r1"), good("r1")])),
    ).toBe("MEMORY_JOB_STATE_INVALID");
  });

  it("rejects a vector whose dimension does not match the pinned capability", () => {
    expect(
      codeOf(() =>
        validateEmbeddingOutcomes(capability, items, [
          { itemId: "r1", status: "succeeded", vector: [0.1, 0.2] },
        ]),
      ),
    ).toBe("MEMORY_VECTOR_SPACE_INCOMPATIBLE");
  });

  it("rejects a non-finite component", () => {
    expect(
      codeOf(() =>
        validateEmbeddingOutcomes(capability, items, [
          {
            itemId: "r1",
            status: "succeeded",
            vector: new Array(capability.vectorSpace.dimension).fill(Number.NaN),
          },
        ]),
      ),
    ).toBe("MEMORY_VECTOR_SPACE_INCOMPATIBLE");
  });

  it("fails the job on a partial batch instead of committing part of it", async () => {
    const h = harness({ withEmbedding: true });
    const input = delivered({
      deliveryId: "d1",
      sourceBlockId: "b1",
      block: {
        payloadSchema: "dolly.content/1",
        content: {
          items: [
            { type: "text", text: "first sentence" },
            { type: "text", text: "second sentence" },
          ],
        },
      },
    });
    // Learn the record IDs a run would produce, then make the provider drop one.
    const probe = harness({ withEmbedding: true });
    await indexInputs(probe, [input]);
    const dropped = probe.store
      .session(probe.namespace, probe.authorization, "query")
      .records()[1]!.recordId;
    h.embedding!.dropItem(dropped);

    const { report } = await indexInputs(h, [input]);
    expect(report.permanentFailures).toHaveLength(1);
    const query = h.store.session(h.namespace, h.authorization, "query");
    expect(query.features().filter((feature) => feature.vector !== undefined)).toEqual([]);
    expect(query.coverage("page-main").completeThrough).toBe(0);
  });

  it("labels every stored vector with the exact descriptor that produced it", async () => {
    const h = harness({ withEmbedding: true });
    await indexInputs(h, [
      delivered({ deliveryId: "d1", sourceBlockId: "b1", block: { payloadSchema: "dolly.content/1", content: { items: [{ type: "text", text: "provenance check" }] } } }),
    ]);
    const vectorFeature = h.store
      .session(h.namespace, h.authorization, "query")
      .features()
      .find((feature) => feature.vector !== undefined)!;
    expect(vectorFeature.endpointId).toBe(h.embedding!.capability.endpointId);
    expect(vectorFeature.modelId).toBe(h.embedding!.capability.modelId);
    expect(vectorFeature.descriptorDigest).toBe(h.embedding!.capability.descriptorDigest);
    expect(vectorFeature.vectorSpace).toEqual(h.embedding!.capability.vectorSpace);
    // The fixture endpoint and model are fake, and the record says so exactly.
    expect(vectorFeature.endpointId).toContain("fixture");
  });
});
