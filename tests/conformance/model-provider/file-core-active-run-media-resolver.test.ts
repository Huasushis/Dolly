import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "../../../src/core/canonical-json.js";
import { FileCoreStateStore } from "../../../src/core/file-core-state-store.js";
import { FileMediaByteStore } from "../../../src/core/file-media-byte-store.js";
import { deriveModuleCgroupPath } from "../../../src/core/linux-module-cgroup.js";
import { createFileCoreActiveRunModelMediaResolver } from "../../../src/core/media-capability/index.js";
import type { ModelMediaResolutionRequest } from "../../../src/core/model-provider-broker.js";

const NOW = "2026-08-12T18:10:00.000Z";
const DEADLINE = "2026-08-12T18:11:00.000Z";
const INSTANCE_ID = "instance-active-media";
const MODULE_ID = "brain-active-media";
const MODULE_GENERATION_ID = "module-generation-active-media";
const PROCESS_GENERATION_ID = "process-generation-active-media";

describe("FileCore active-Run model Media resolver", () => {
  it("binds the delivered reference to the active Claim, submission, and running process", async () => {
    const scratchParent = resolve(process.cwd(), "..", ".tmp");
    mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(scratchParent, "file-core-model-media-"));
    let blockId = 0;
    let deliveryId = 0;
    try {
      const core = new FileCoreStateStore({
        path: join(scratch, "core-state.json"),
        maxFailedAttempts: 1,
        nextBlockId: () => `block-active-media-${++blockId}`,
        nextDeliveryId: (kind) => `${kind}-active-media-${++deliveryId}`,
        now: () => NOW,
        media: {
          durability: "persistent",
          bytes: new FileMediaByteStore({
            directory: join(scratch, "media"),
            maxMediaBytes: 1024,
          }),
          inspector: {
            inspect: async () => ({ mimeType: "image/png", width: 2, height: 1 }),
          },
          maxMediaBytes: 1024,
          idNamespace: "active-run-resolver",
        },
      });
      if (!core.media) throw new Error("Media was not enabled");
      core.deliveries.createPage("input");
      core.deliveries.registerConsumer("input", MODULE_ID, "from-now");
      const bytes = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4);
      const media = await core.media.registerMedia({
        registrationId: "registration-active-media",
        bytes,
        declaredMimeType: "image/png",
        provenance: { sourceClass: "streamed-upload" },
      });
      const block = core.blocks.commit({
        payload: {
          schema: "dolly.content/1",
          value: { items: [{ type: "media-reference", mediaId: media.mediaId }] },
        },
      }, { kind: "external", id: "test" });
      core.deliveries.append("input", block.id);
      const claim = core.deliveries.claim({
        consumerId: MODULE_ID,
        pageIds: ["input"],
        moduleGenerationId: MODULE_GENERATION_ID,
        maxCount: 1,
        maxBytes: 1024,
      });
      if (!claim) throw new Error("The test Claim was not created");
      core.appendModuleProcessRecord({
        schemaVersion: "dolly.module-process-record/1",
        instanceId: INSTANCE_ID,
        moduleId: MODULE_ID,
        moduleGenerationId: MODULE_GENERATION_ID,
        processGenerationId: PROCESS_GENERATION_ID,
        packageDigest: `sha256:${"a".repeat(64)}`,
        configurationReference: {
          configId: "config-active-media",
          revision: `sha256:${"b".repeat(64)}`,
          configVersion: 1,
        },
        declaredExternalEffects: "unrestricted",
        serviceInvocationId: "1".repeat(32),
        bootId: "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9",
        moduleCgroupPath: deriveModuleCgroupPath(
          "/sys/fs/cgroup/system.slice/dolly-core.service",
          {
            instanceId: INSTANCE_ID,
            moduleId: MODULE_ID,
            processGenerationId: PROCESS_GENERATION_ID,
          },
        ).filesystemPath,
        state: "starting",
        createdAt: NOW,
        updatedAt: NOW,
      });
      core.updateModuleProcessRecordState(PROCESS_GENERATION_ID, "running");
      core.appendModuleSubmissionRecord({
        schemaVersion: "dolly.module-submission-record/1",
        moduleJobId: claim.moduleJobId,
        claimToken: claim.claimToken,
        runId: claim.runId,
        attempt: claim.attempt,
        moduleGenerationId: claim.moduleGenerationId,
        processGenerationId: PROCESS_GENERATION_ID,
        inputDigest: canonicalJsonDigest(core.deliveries.inspectClaimInput(claim)),
        createdAt: NOW,
      });
      const resolver = createFileCoreActiveRunModelMediaResolver({
        core,
        extensionId: "org.example.active-media",
        instanceId: INSTANCE_ID,
        moduleId: MODULE_ID,
        sessionForProcess: (processGenerationId) =>
          processGenerationId === PROCESS_GENERATION_ID
            ? {
                extensionId: "org.example.active-media",
                instanceId: INSTANCE_ID,
                processGenerationId: PROCESS_GENERATION_ID,
                sessionId: "session-active-media",
                moduleId: MODULE_ID,
                moduleGenerationId: MODULE_GENERATION_ID,
              }
            : null,
        now: () => NOW,
      });
      const request: ModelMediaResolutionRequest = {
        schemaVersion: "dolly.model.media-resolution-request/1",
        modelRequestId: "model-request-active-media",
        mediaRequestId: "media-request-active-media",
        recipientId: "recipient-active-media",
        descriptor: {
          endpointId: "endpoint-active-media",
          operation: "chat-completion",
          modelId: "model-active-media",
          adapterId: "openai-compatible-chat",
          adapterVersion: "v1",
          descriptorVersion: "descriptor-active-media",
          descriptorDigest: `sha256:${"c".repeat(64)}`,
        },
        binding: {
          endpointId: "endpoint-active-media",
          bindingRevision: "binding-active-media",
        },
        context: {
          operationId: "operation-active-media",
          instanceId: INSTANCE_ID,
          ownerScope: "owner-active-media",
          moduleId: MODULE_ID,
          moduleGenerationId: MODULE_GENERATION_ID,
          moduleJobId: claim.moduleJobId,
          runId: claim.runId,
          attempt: claim.attempt,
          sessionId: "session-active-media",
          deadline: DEADLINE,
        },
        messageIndex: 0,
        partIndex: 0,
        mediaReference: { type: "media-reference", mediaId: media.mediaId },
        requirement: {
          requirementId: "inline-png-v1",
          modality: "image",
          mimeTypes: ["image/png"],
          deliveryModes: ["inline"],
          maxItems: 1,
          maxBytesPerItem: 1024,
          maxAggregateBytes: 1024,
          providerFetchesAfterAcceptance: false,
          lifetimeStrategyId: "media.inline-copy.v1",
          placementStrategyId: "openai.chat.media.inline-image-url.v1",
        },
        acceptedAccessModes: ["inline"],
        deadline: DEADLINE,
        limits: {
          maxItemsRemaining: 1,
          maxBytesForItem: 1024,
          maxResolvedBytesRemaining: 1024,
        },
      };

      await expect(resolver.resolve(request, {})).resolves.toMatchObject({
        mediaId: media.mediaId,
        digest: media.digest,
        byteLength: bytes.byteLength,
        width: 2,
        height: 1,
        accessMode: "inline",
        inline: { encoding: "base64", data: Buffer.from(bytes).toString("base64") },
      });
      expect(core.media.referenceGraph.leaseCountFor({ kind: "media", id: media.mediaId })).toBe(0);

      await expect(resolver.resolve({
        ...request,
        context: { ...request.context, runId: "run-foreign" },
      }, {})).rejects.toThrow("not authorized");
      await expect(resolver.resolve({
        ...request,
        context: { ...request.context, sessionId: "session-foreign" },
      }, {})).rejects.toThrow("not authorized");
      core.updateModuleProcessRecordState(PROCESS_GENERATION_ID, "stopping");
      await expect(resolver.resolve(request, {})).rejects.toThrow("not authorized");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("refuses construction without one Media-enabled FileCore store", () => {
    const scratchParent = resolve(process.cwd(), "..", ".tmp");
    mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(scratchParent, "file-core-model-media-disabled-"));
    try {
      const core = new FileCoreStateStore({
        path: join(scratch, "core-state.json"),
        maxFailedAttempts: 1,
        nextBlockId: () => "unused-block",
        nextDeliveryId: (kind) => `unused-${kind}`,
        now: () => NOW,
      });
      expect(() => createFileCoreActiveRunModelMediaResolver({
        core,
        extensionId: "org.example.active-media",
        instanceId: INSTANCE_ID,
        moduleId: MODULE_ID,
        sessionForProcess: () => null,
        now: () => NOW,
      })).toThrow("Media-enabled FileCore");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
