import { describe, expect, it, vi } from "vitest";
import { EndpointBindingRegistry } from "../../../src/core/model-provider-binding.js";
import {
  EmbeddingDescriptorRegistry,
  ModelEmbeddingError,
  decodeOpenAiCompatibleEmbeddingResponse,
  embeddingModalitiesComparable,
  encodeOpenAiCompatibleTextEmbeddingRequest,
  prepareEmbeddingInput,
  type EmbeddingDescriptorSnapshot,
  type EmbeddingInput,
} from "../../../src/core/model-provider-embedding.js";
import { ModelDescriptorError } from "../../../src/core/model-provider-descriptor.js";
import {
  EMBEDDING_STRATEGIES,
  nativeVlEmbeddingDescriptor,
  textEmbeddingDescriptor,
} from "./fixtures.js";

const SCHEMA_DIGEST = `sha256:${"e".repeat(64)}`;

function registry(): EmbeddingDescriptorRegistry {
  return new EmbeddingDescriptorRegistry({
    schemaDigest: SCHEMA_DIGEST,
    allowedStrategyIds: EMBEDDING_STRATEGIES,
  });
}

function activeTextSnapshot(
  options: Parameters<typeof textEmbeddingDescriptor>[0] = {},
): EmbeddingDescriptorSnapshot {
  const descriptors = registry();
  const ref = descriptors.register(textEmbeddingDescriptor(options));
  descriptors.setStatus(ref, "active");
  return descriptors.snapshot(ref);
}

function activeVlSnapshot(
  options: Parameters<typeof nativeVlEmbeddingDescriptor>[0] = {},
): EmbeddingDescriptorSnapshot {
  const descriptors = registry();
  const ref = descriptors.register(nativeVlEmbeddingDescriptor(options));
  descriptors.setStatus(ref, "active");
  return descriptors.snapshot(ref);
}

function textInput(texts = ["alpha", "beta"], outputDimension = 3): EmbeddingInput {
  return {
    schemaVersion: "dolly.model.embedding-input/2",
    outputDimension,
    items: texts.map((text, index) => ({
      itemId: `item-${index + 1}`,
      input: { kind: "text", text },
    })),
  };
}

function providerResponse(
  model: string,
  entries: readonly { index: number; embedding: readonly number[] }[],
): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      object: "list",
      data: entries.map((entry) => ({ object: "embedding", ...entry })),
      model,
      usage: { prompt_tokens: 4, total_tokens: 4 },
    }),
  );
}

describe("embedding descriptor and exact-wire contract", () => {
  it("keeps embedding descriptors disabled until activation and freezes snapshots", () => {
    const descriptors = registry();
    const ref = descriptors.register(textEmbeddingDescriptor());
    expect(ref.operation).toBe("embedding");
    expect(() => descriptors.snapshot(ref)).toThrowError(
      expect.objectContaining<Partial<ModelDescriptorError>>({ code: "DESCRIPTOR_DISABLED" }),
    );

    descriptors.setStatus(ref, "active");
    descriptors.setAlias("primary-embedding", ref);
    const snapshot = descriptors.snapshot({ alias: "primary-embedding" });
    expect(snapshot.schemaDigest).toBe(SCHEMA_DIGEST);
    expect(Object.isFrozen(snapshot.document.features)).toBe(true);
    expect(Object.isFrozen(snapshot.document.features.dimensions)).toBe(true);
  });

  it.each(["dolly.model-descriptor/1", "dolly.model-descriptor/2"])(
    "rejects obsolete descriptor schema %s",
    (schemaVersion) => {
      expect(() =>
        registry().register({
          ...textEmbeddingDescriptor(),
          schemaVersion,
        }),
      ).toThrowError(
        expect.objectContaining<Partial<ModelDescriptorError>>({ code: "DESCRIPTOR_INVALID" }),
      );
    },
  );

  it("rejects the removed media view field", () => {
    const descriptor = nativeVlEmbeddingDescriptor();
    const mediaRequirement = {
      ...descriptor.input.media[0]!,
      viewStrategyId: "media.exact-view.v1",
    };

    expect(() =>
      registry().register({
        ...descriptor,
        input: { ...descriptor.input, media: [mediaRequirement] },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ModelDescriptorError>>({
        code: "DESCRIPTOR_INVALID",
        message: expect.stringContaining("viewStrategyId"),
      }),
    );
  });

  it("rejects embedding input version 1 and non-Block media references", () => {
    const textSnapshot = activeTextSnapshot();
    expect(() =>
      prepareEmbeddingInput(textSnapshot, {
        ...textInput(["legacy"]),
        schemaVersion: "dolly.model.embedding-input/1",
      } as unknown as EmbeddingInput),
    ).toThrowError(
      expect.objectContaining<Partial<ModelEmbeddingError>>({
        code: "EMBEDDING_INPUT_INVALID",
      }),
    );

    const mediaSnapshot = activeVlSnapshot();
    const invalidReference = {
      schemaVersion: "dolly.model.embedding-input/2",
      outputDimension: 4,
      items: [
        {
          itemId: "image-1",
          input: {
            kind: "media",
            modality: "image",
            mediaReference: { handle: "opaque-image" },
            requirementId: "native-image-input-v1",
          },
        },
      ],
    } as unknown as EmbeddingInput;
    expect(() => prepareEmbeddingInput(mediaSnapshot, invalidReference)).toThrowError(
      expect.objectContaining<Partial<ModelEmbeddingError>>({
        code: "EMBEDDING_INPUT_INVALID",
      }),
    );

    const legacyField = structuredClone(invalidReference) as unknown as {
      items: Array<{ input: Record<string, unknown> }>;
    };
    legacyField.items[0]!.input.mediaRef = {
      type: "media-reference",
      mediaId: "media-1",
    };
    delete legacyField.items[0]!.input.mediaReference;
    expect(() =>
      prepareEmbeddingInput(mediaSnapshot, legacyField as unknown as EmbeddingInput),
    ).toThrowError(
      expect.objectContaining<Partial<ModelEmbeddingError>>({
        code: "EMBEDDING_INPUT_INVALID",
      }),
    );
  });

  it("allows a generic endpoint binding to authorize an exact embedding descriptor", () => {
    const snapshot = activeTextSnapshot();
    const bindings = new EndpointBindingRegistry();
    const bindingRef = bindings.register({
      schemaVersion: "dolly.endpoint-binding/2",
      endpointId: snapshot.ref.endpointId,
      bindingRevision: "embedding-binding-v1",
      descriptorRefs: [snapshot.ref],
      exactUrl: "https://embedding.example.test/v1/embeddings",
      networkScope: "public",
      authentication: { kind: "none" },
      limits: {
        maxRequestBytes: 64 * 1024,
        maxResponseBytes: 64 * 1024,
        maxTimeoutMs: 30_000,
      },
    });
    bindings.setStatus(bindingRef, "active");
    expect(bindings.snapshot(snapshot.ref).document.descriptorRefs).toEqual([snapshot.ref]);
  });

  it("rejects media on a text-only descriptor before downstream resolution or I/O", () => {
    const snapshot = activeTextSnapshot({ modelId: "qwen-vl-looking-name" });
    const afterFeatureCheck = vi.fn();
    const candidate = {
      schemaVersion: "dolly.model.embedding-input/2",
      outputDimension: 3,
      items: [
        {
          itemId: "image-1",
          input: {
            kind: "media",
            modality: "image",
            mediaReference: { type: "media-reference", mediaId: "media-1" },
            requirementId: "native-image-input-v1",
          },
        },
      ],
    } as unknown as EmbeddingInput;

    const run = () => {
      const prepared = prepareEmbeddingInput(snapshot, candidate);
      afterFeatureCheck(prepared);
    };
    expect(run).toThrowError(
      expect.objectContaining<Partial<ModelEmbeddingError>>({
        code: "EMBEDDING_FEATURE_UNSUPPORTED",
      }),
    );
    expect(afterFeatureCheck).not.toHaveBeenCalled();
  });

  it("accepts native image and multimodal inputs only under exact declared requirements", () => {
    const snapshot = activeVlSnapshot({ modelId: "opaque-model-name" });
    const input: EmbeddingInput = {
      schemaVersion: "dolly.model.embedding-input/2",
      outputDimension: 4,
      items: [
        { itemId: "text-1", input: { kind: "text", text: "caption" } },
        {
          itemId: "image-1",
          input: {
            kind: "media",
            modality: "image",
            mediaReference: { type: "media-reference", mediaId: "media-1" },
            requirementId: "native-image-input-v1",
          },
        },
        {
          itemId: "pair-1",
          input: {
            kind: "multimodal",
            compositeStrategyId: "fixture.text-image.composite.v1",
            parts: [
              { kind: "text", text: "query" },
              {
                kind: "media",
                modality: "image",
                mediaReference: {
                  type: "media-reference",
                  mediaId: "media-2",
                },
                requirementId: "native-image-input-v1",
              },
            ],
          },
        },
      ],
    };
    const prepared = prepareEmbeddingInput(snapshot, input);
    expect(prepared.mediaRequests).toHaveLength(2);
    expect(prepared.mediaRequests[0]!.mediaReference).toEqual({
      type: "media-reference",
      mediaId: "media-1",
    });
    expect(prepared.mediaRequests[0]).not.toHaveProperty("mediaRef");
    expect(prepared.itemModalities).toEqual([
      { itemId: "text-1", modalities: ["text"] },
      { itemId: "image-1", modalities: ["image"] },
      { itemId: "pair-1", modalities: ["image", "text"] },
    ]);
    expect(JSON.stringify(prepared)).not.toMatch(/https?:|base64|object[_-]?key/i);

    const wrongRequirement = structuredClone(input);
    const media = wrongRequirement.items[1]!.input as Extract<
      typeof wrongRequirement.items[number]["input"],
      { kind: "media" }
    >;
    (media as { requirementId: string }).requirementId = "guessed-image-route";
    expect(() => prepareEmbeddingInput(snapshot, wrongRequirement)).toThrowError(
      expect.objectContaining<Partial<ModelEmbeddingError>>({
        code: "EMBEDDING_FEATURE_UNSUPPORTED",
      }),
    );

    const tooManyParts: EmbeddingInput = {
      schemaVersion: "dolly.model.embedding-input/2",
      outputDimension: 4,
      items: [
        {
          itemId: "oversized-pair",
          input: {
            kind: "multimodal",
            compositeStrategyId: "fixture.text-image.composite.v1",
            parts: [
              { kind: "text", text: "query" },
              ...Array.from({ length: 8 }, (_, index) => ({
                kind: "media" as const,
                modality: "image",
                mediaReference: {
                  type: "media-reference" as const,
                  mediaId: `media-${index}`,
                },
                requirementId: "native-image-input-v1",
              })),
            ],
          },
        },
      ],
    };
    expect(() => prepareEmbeddingInput(snapshot, tooManyParts)).toThrowError(
      expect.objectContaining<Partial<ModelEmbeddingError>>({
        code: "EMBEDDING_LIMIT_EXCEEDED",
      }),
    );
  });

  it("requires an explicit declared output dimension for every invocation", () => {
    const fixed = activeTextSnapshot();
    expect(() => prepareEmbeddingInput(fixed, textInput(["x"], 4))).toThrowError(
      expect.objectContaining<Partial<ModelEmbeddingError>>({
        code: "EMBEDDING_FEATURE_UNSUPPORTED",
      }),
    );
    expect(() =>
      prepareEmbeddingInput(
        fixed,
        { schemaVersion: "dolly.model.embedding-input/2", items: textInput(["x"]).items } as EmbeddingInput,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<ModelEmbeddingError>>({
        code: "EMBEDDING_INPUT_INVALID",
      }),
    );

    const variable = activeTextSnapshot({
      dimensions: { kind: "allowed", values: [6, 3] },
    });
    expect(variable.document.features.dimensions).toEqual({
      kind: "allowed",
      values: [3, 6],
    });
    expect(() => prepareEmbeddingInput(variable, textInput(["x"], 5))).toThrowError(
      ModelEmbeddingError,
    );
  });

  it("requires an explicit shared modality set even when dimensions are equal", () => {
    const declared = activeVlSnapshot();
    const undeclared = activeVlSnapshot({
      descriptorVersion: "without-cross-modal-comparability",
      comparableModalitySets: [],
    });
    expect(embeddingModalitiesComparable(declared, ["text", "image"])).toBe(true);
    expect(embeddingModalitiesComparable(undeclared, ["text", "image"])).toBe(false);
    expect(embeddingModalitiesComparable(undeclared, ["image"])).toBe(true);
    expect(declared.document.features.dimensions).toEqual(
      undeclared.document.features.dimensions,
    );
  });

  it("encodes only the exact installed text strategy and never infers provider fields", () => {
    const fixed = activeTextSnapshot({ modelId: "text-model" });
    const fixedPlan = encodeOpenAiCompatibleTextEmbeddingRequest(
      fixed,
      textInput(["alpha", "beta"]),
    );
    expect(fixedPlan.body).toEqual({
      model: "text-model",
      input: ["alpha", "beta"],
      encoding_format: "float",
    });
    expect(fixedPlan.body).not.toHaveProperty("dimensions");
    expect(JSON.stringify(fixedPlan.body)).not.toMatch(
      /base[_-]?url|api[_-]?key|mediaReference/i,
    );

    const variable = activeTextSnapshot({
      dimensions: { kind: "allowed", values: [3, 6] },
    });
    expect(
      encodeOpenAiCompatibleTextEmbeddingRequest(variable, textInput(["alpha"], 6)).body,
    ).toHaveProperty("dimensions", 6);
  });

  it("correlates a position response exactly and returns request order", () => {
    const snapshot = activeTextSnapshot();
    const input = textInput();
    const output = decodeOpenAiCompatibleEmbeddingResponse(
      snapshot,
      input,
      providerResponse(snapshot.document.modelId, [
        { index: 1, embedding: [0, 1, 0] },
        { index: 0, embedding: [1, 0, 0] },
      ]),
    );
    expect(output.items).toEqual([
      {
        itemId: "item-1",
        status: "succeeded",
        vector: [1, 0, 0],
        dimension: 3,
        vectorSpaceId: "fixture-text-vector-space-v1",
      },
      {
        itemId: "item-2",
        status: "succeeded",
        vector: [0, 1, 0],
        dimension: 3,
        vectorSpaceId: "fixture-text-vector-space-v1",
      },
    ]);
    const first = output.items[0];
    if (first === undefined || first.status !== "succeeded") {
      throw new Error("expected the first embedding result to succeed");
    }
    expect(Object.isFrozen(first.vector)).toBe(true);
  });

  it("rejects duplicate, foreign, and missing provider correlations without fabricating vectors", () => {
    const snapshot = activeTextSnapshot();
    const input = textInput();
    const duplicate = providerResponse(snapshot.document.modelId, [
      { index: 0, embedding: [1, 0, 0] },
      { index: 0, embedding: [0, 1, 0] },
    ]);
    const foreign = providerResponse(snapshot.document.modelId, [
      { index: 0, embedding: [1, 0, 0] },
      { index: 2, embedding: [0, 1, 0] },
    ]);
    const missing = providerResponse(snapshot.document.modelId, [
      { index: 0, embedding: [1, 0, 0] },
    ]);
    for (const response of [duplicate, foreign, missing]) {
      expect(() => decodeOpenAiCompatibleEmbeddingResponse(snapshot, input, response)).toThrowError(
        expect.objectContaining<Partial<ModelEmbeddingError>>({
          code: "EMBEDDING_CORRELATION_INVALID",
        }),
      );
    }
  });

  it("rejects wrong dimensions and normalization instead of padding, truncating, or normalizing", () => {
    const snapshot = activeTextSnapshot({
      normalization: { kind: "unit", tolerance: 0.0001 },
    });
    expect(() =>
      decodeOpenAiCompatibleEmbeddingResponse(
        snapshot,
        textInput(["x"]),
        providerResponse(snapshot.document.modelId, [{ index: 0, embedding: [1, 0] }]),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<ModelEmbeddingError>>({
        code: "EMBEDDING_VECTOR_INVALID",
      }),
    );
    expect(() =>
      decodeOpenAiCompatibleEmbeddingResponse(
        snapshot,
        textInput(["x"]),
        providerResponse(snapshot.document.modelId, [{ index: 0, embedding: [0.5, 0, 0] }]),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<ModelEmbeddingError>>({
        code: "EMBEDDING_VECTOR_INVALID",
      }),
    );
  });

  it("rejects ambiguous JSON, unknown fields, model mismatches, and non-finite JSON numbers", () => {
    const snapshot = activeTextSnapshot();
    const input = textInput(["x"]);
    const duplicateKey = Buffer.from(
      `{"object":"list","data":[{"object":"embedding","index":0,"index":0,"embedding":[1,0,0]}],"model":"${snapshot.document.modelId}"}`,
    );
    const unknown = JSON.parse(
      Buffer.from(
        providerResponse(snapshot.document.modelId, [{ index: 0, embedding: [1, 0, 0] }]),
      ).toString("utf8"),
    );
    unknown.private_debug = "must-not-pass";
    const nonFinite = Buffer.from(
      `{"object":"list","data":[{"object":"embedding","index":0,"embedding":[1e309,0,0]}],"model":"${snapshot.document.modelId}"}`,
    );
    for (const response of [
      duplicateKey,
      Buffer.from(JSON.stringify(unknown)),
      providerResponse("different-model", [{ index: 0, embedding: [1, 0, 0] }]),
      nonFinite,
    ]) {
      expect(() => decodeOpenAiCompatibleEmbeddingResponse(snapshot, input, response)).toThrowError(
        expect.objectContaining<Partial<ModelEmbeddingError>>({
          code: "EMBEDDING_PROVIDER_PROTOCOL_ERROR",
        }),
      );
    }
  });

  it("rejects inconsistent descriptor semantics and non-allowlisted strategies", () => {
    const missingComposite = nativeVlEmbeddingDescriptor();
    expect(() =>
      registry().register({
        ...missingComposite,
        features: { ...missingComposite.features, compositeStrategyIds: [] },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ModelDescriptorError>>({ code: "DESCRIPTOR_INVALID" }),
    );

    const restricted = new Set(EMBEDDING_STRATEGIES);
    restricted.delete("embedding.vector.json-number-array.v1");
    expect(() =>
      new EmbeddingDescriptorRegistry({
        schemaDigest: SCHEMA_DIGEST,
        allowedStrategyIds: restricted,
      }).register(textEmbeddingDescriptor()),
    ).toThrowError(
      expect.objectContaining<Partial<ModelDescriptorError>>({
        code: "DESCRIPTOR_STRATEGY_DENIED",
      }),
    );
  });
});
