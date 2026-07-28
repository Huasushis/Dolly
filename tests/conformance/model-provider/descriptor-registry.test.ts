import { describe, expect, it } from "vitest";
import {
  ModelDescriptorError,
  ModelDescriptorRegistry,
} from "../../../src/core/model-provider-descriptor.js";
import { CHAT_STRATEGIES, chatDescriptor, requestControlledReasoning } from "./fixtures.js";

const SCHEMA_DIGEST = `sha256:${"a".repeat(64)}`;

function registry(strategies = CHAT_STRATEGIES): ModelDescriptorRegistry {
  return new ModelDescriptorRegistry({
    schemaDigest: SCHEMA_DIGEST,
    allowedStrategyIds: strategies,
  });
}

describe("model descriptor registry", () => {
  it("keeps a validated descriptor disabled until explicit activation", () => {
    const descriptors = registry();
    const ref = descriptors.register(chatDescriptor());

    expect(() => descriptors.snapshot(ref)).toThrowError(
      expect.objectContaining<Partial<ModelDescriptorError>>({ code: "DESCRIPTOR_DISABLED" }),
    );
    descriptors.setStatus(ref, "active");
    descriptors.setAlias("primary-chat", ref);
    const snapshot = descriptors.snapshot({ alias: "primary-chat" });

    expect(snapshot.schemaDigest).toBe(SCHEMA_DIGEST);
    expect(snapshot.ref).toEqual(ref);
    expect(snapshot.document.features.reasoning).toMatchObject({
      support: "always-on",
      requestControl: { kind: "forbidden" },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.document.features.reasoning)).toBe(true);
  });

  it("is idempotent for canonical-equivalent bytes and conflicts on identity reuse", () => {
    const descriptors = registry();
    const original = chatDescriptor();
    const ref = descriptors.register(original);
    const reordered = {
      features: original.features,
      retry: original.retry,
      input: original.input,
      limits: original.limits,
      adapter: original.adapter,
      modelId: original.modelId,
      operation: original.operation,
      endpointId: original.endpointId,
      descriptorVersion: original.descriptorVersion,
      schemaVersion: original.schemaVersion,
    };
    expect(descriptors.register(reordered)).toEqual(ref);

    expect(() =>
      descriptors.register({
        ...chatDescriptor(),
        limits: { ...chatDescriptor().limits, maxResponseBytes: 63 * 1024 },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ModelDescriptorError>>({
        code: "DESCRIPTOR_IDENTITY_CONFLICT",
      }),
    );
  });

  it("rejects unknown fields, address-like endpoint IDs, and non-allowlisted strategies", () => {
    expect(() => registry().register({ ...chatDescriptor(), baseUrl: "https://private.test" }))
      .toThrowError(
        expect.objectContaining<Partial<ModelDescriptorError>>({ code: "DESCRIPTOR_INVALID" }),
      );
    expect(() =>
      registry().register(chatDescriptor({ endpointId: "https://private.test/v1" })),
    ).toThrowError(
      expect.objectContaining<Partial<ModelDescriptorError>>({ code: "DESCRIPTOR_INVALID" }),
    );

    const restricted = new Set(CHAT_STRATEGIES);
    restricted.delete("openai.reasoning-content.nonstream.v1");
    expect(() => registry(restricted).register(chatDescriptor())).toThrowError(
      expect.objectContaining<Partial<ModelDescriptorError>>({
        code: "DESCRIPTOR_STRATEGY_DENIED",
      }),
    );
  });

  it.each(["dolly.model-descriptor/1", "dolly.model-descriptor/2"])(
    "rejects obsolete descriptor schema %s",
    (schemaVersion) => {
      expect(() =>
        registry().register({
          ...chatDescriptor(),
          schemaVersion,
        }),
      ).toThrowError(
        expect.objectContaining<Partial<ModelDescriptorError>>({ code: "DESCRIPTOR_INVALID" }),
      );
    },
  );

  it("rejects the removed media view field", () => {
    const descriptor = chatDescriptor();
    const mediaRequirement = {
      requirementId: "legacy-image-input-v1",
      modality: "image",
      mimeTypes: ["image/png"],
      deliveryModes: ["inline"],
      maxItems: 1,
      maxBytesPerItem: 1024,
      maxAggregateBytes: 1024,
      providerFetchesAfterAcceptance: false,
      lifetimeStrategyId: "media.provider-access-lease.v1",
      placementStrategyId: "media.inline-or-private-signed.v1",
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

  it("rejects forged digests and invalid reasoning feature combinations", () => {
    const descriptors = registry();
    const ref = descriptors.register(chatDescriptor());
    descriptors.setStatus(ref, "active");
    const forged = { ...ref, descriptorDigest: `sha256:${"b".repeat(64)}` };
    expect(() => descriptors.snapshot(forged)).toThrowError(
      expect.objectContaining<Partial<ModelDescriptorError>>({
        code: "DESCRIPTOR_DIGEST_MISMATCH",
      }),
    );

    expect(() =>
      descriptors.register({
        ...chatDescriptor(),
        features: {
          ...chatDescriptor().features,
          reasoning: {
            ...requestControlledReasoning(),
            requestControl: { kind: "forbidden" },
          },
        },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ModelDescriptorError>>({ code: "DESCRIPTOR_INVALID" }),
    );
  });

  it("freezes existing snapshots while an alias moves to a new descriptor version", () => {
    const descriptors = registry();
    const firstRef = descriptors.register(chatDescriptor({ descriptorVersion: "v1" }));
    descriptors.setStatus(firstRef, "active");
    descriptors.setAlias("primary-chat", firstRef);
    const firstSnapshot = descriptors.snapshot({ alias: "primary-chat" });

    const secondRef = descriptors.register(
      chatDescriptor({ descriptorVersion: "v2", reasoning: requestControlledReasoning() }),
    );
    descriptors.setStatus(secondRef, "active");
    descriptors.setAlias("primary-chat", secondRef);
    const secondSnapshot = descriptors.snapshot({ alias: "primary-chat" });

    expect(firstSnapshot.ref.descriptorVersion).toBe("v1");
    expect(firstSnapshot.document.features.reasoning.support).toBe("always-on");
    expect(secondSnapshot.ref.descriptorVersion).toBe("v2");
    expect(secondSnapshot.document.features.reasoning.support).toBe("request-controlled");
  });

  it("prevents superseded descriptors from being silently reactivated", () => {
    const descriptors = registry();
    const ref = descriptors.register(chatDescriptor());
    descriptors.setStatus(ref, "active");
    descriptors.setStatus(ref, "superseded");
    expect(() => descriptors.setStatus(ref, "active")).toThrowError(
      expect.objectContaining<Partial<ModelDescriptorError>>({
        code: "DESCRIPTOR_STATUS_INVALID",
      }),
    );
  });
});
