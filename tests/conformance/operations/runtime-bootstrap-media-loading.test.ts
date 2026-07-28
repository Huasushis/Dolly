import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sharp", () => {
  throw new Error("SHARP_MUST_NOT_LOAD");
});

import { InstanceConfigStore } from "../../../src/core/instance-config-store.js";
import { FileCoreStateStore } from "../../../src/core/file-core-state-store.js";
import { FileMediaByteStore } from "../../../src/core/file-media-byte-store.js";
import type {
  MediaByteStore,
  MediaInspector,
} from "../../../src/core/media-store.js";
import { openDollyRuntime } from "../../../src/core/runtime-bootstrap.js";
import {
  createDefaultDollyInstanceConfig,
  dollyInstanceConfigSchema,
  validateDollyInstanceConfig,
} from "../../../src/core/runtime-config.js";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const CONTROLLER_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-07-24T13:00:00.000Z";

class DeleteThenFailByteStore implements MediaByteStore {
  readonly durability = "persistent" as const;
  #failDelete = true;

  constructor(private readonly inner: FileMediaByteStore) {}

  put(mediaId: string, bytes: Uint8Array): Promise<void> {
    return this.inner.put(mediaId, bytes);
  }

  get(mediaId: string): Promise<Uint8Array> {
    return this.inner.get(mediaId);
  }

  async delete(mediaId: string): Promise<void> {
    await this.inner.delete(mediaId);
    if (!this.#failDelete) return;
    this.#failDelete = false;
    throw new Error("simulated lost byte deletion response");
  }

  has(mediaId: string): Promise<boolean> {
    return this.inner.has(mediaId);
  }
}

describe("runtime Media dependency loading", () => {
  let root: string;
  let registryDirectory: string;
  let defaultStateRoot: string;
  let configPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-runtime-media-loading-"));
    registryDirectory = join(root, "registry");
    defaultStateRoot = join(root, "instances");
    const project = join(root, "project");
    mkdirSync(project);
    configPath = join(project, "dolly.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function configStore() {
    return new InstanceConfigStore({
      schema: dollyInstanceConfigSchema,
      registryDirectory,
      defaultStateRoot,
      nextInstanceId: () => INSTANCE_ID,
      now: () => NOW,
    });
  }

  async function open(mediaInspector?: MediaInspector) {
    return openDollyRuntime({
      configPath,
      registryDirectory,
      defaultStateRoot,
      controllerId: CONTROLLER_ID,
      processId: 101,
      now: () => NOW,
      ...(mediaInspector === undefined ? {} : { mediaInspector }),
    });
  }

  function initializeLocalMedia() {
    return configStore().initialize(configPath, (instanceId) => {
      const defaults = createDefaultDollyInstanceConfig(instanceId);
      return validateDollyInstanceConfig({
        ...defaults,
        core: {
          ...defaults.core,
          media: {
            enabled: true,
            maxMediaBytes: 1024,
            maxTotalMediaBytes: 4096,
            maxRegistrationRecords: 100,
            maxStorageRecords: 100,
            maxProviderAccessRecords: 100,
            deletedRegistrationRetentionMs: 1000,
            ingress: {
              maxActiveCapabilities: 10,
              maxConcurrentOperations: 2,
              maxCapabilityLifetimeMs: 60_000,
            },
          },
        },
      });
    });
  }

  it("does not load or require Sharp when Media is disabled", async () => {
    configStore().initialize(configPath, (instanceId) =>
      createDefaultDollyInstanceConfig(instanceId),
    );

    const runtime = await open();
    expect(runtime.core.media).toBeUndefined();
    await runtime.stop();
  });

  it("uses an injected inspector for enabled Media without loading Sharp", async () => {
    initializeLocalMedia();
    const inspect = vi.fn<MediaInspector["inspect"]>().mockResolvedValue({
      mimeType: "image/png",
      width: 1,
      height: 1,
      frameCount: 1,
      channels: 4,
    });

    const runtime = await open({ inspect });
    const media = runtime.core.media;
    expect(media).toBeDefined();
    if (!media) throw new Error("Persistent Media was not initialized");
    await media.registerMedia({
      registrationId: "registration-injected-inspector",
      bytes: Buffer.from("test-double-input"),
      declaredMimeType: "image/png",
      provenance: { sourceClass: "streamed-upload" },
    });
    expect(inspect).toHaveBeenCalledOnce();

    await runtime.stop();
  });

  it("recovers deletion before checking persistent Media bytes", async () => {
    const initialized = initializeLocalMedia();
    const inspect: MediaInspector["inspect"] = async () => ({
      mimeType: "image/png",
      width: 1,
      height: 1,
    });
    const fileBytes = new FileMediaByteStore({
      directory: join(initialized.stateDirectory, "media", "objects"),
      maxMediaBytes: 1024,
    });
    let blockId = 0;
    let deliveryId = 0;
    const prepared = new FileCoreStateStore({
      path: join(initialized.stateDirectory, "core-state.json"),
      maxFailedAttempts: 3,
      nextBlockId: () => `prepared-block-${++blockId}`,
      nextDeliveryId: (kind) => `prepared-${kind}-${++deliveryId}`,
      now: () => NOW,
      media: {
        durability: "persistent",
        bytes: new DeleteThenFailByteStore(fileBytes),
        inspector: { inspect },
        maxMediaBytes: 1024,
        idNamespace: INSTANCE_ID,
      },
    });
    prepared.deliveries.createPage("main");
    const media = await prepared.media!.registerMedia({
      registrationId: "registration-runtime-delete-recovery",
      bytes: Uint8Array.of(1, 2, 3),
      provenance: { sourceClass: "streamed-upload" },
    });
    prepared.blocks.commitOnce("commit-runtime-delete-recovery", {
      payload: {
        schema: "dolly.content/1",
        value: { items: [{ type: "media-reference", mediaId: media.mediaId }] },
      },
    }, { kind: "module", id: "runtime-delete-recovery" });
    expect(prepared.media!.releaseRegistration(
      "registration-runtime-delete-recovery",
    )).toBe("released");
    expect(prepared.blocks.releaseCommitEffect(
      "commit-runtime-delete-recovery",
    )).toBe("released");
    expect(prepared.blocks.collectUnreachable()).toHaveLength(1);
    await expect(prepared.media!.collectUnreachable()).rejects.toThrow(
      "simulated lost byte deletion response",
    );
    await expect(fileBytes.has(media.mediaId)).resolves.toBe(false);

    const runtime = await open({ inspect });
    expect(runtime.state).toBe("ready");
    expect(runtime.core.media!.listRegistrations()).toEqual([
      expect.objectContaining({ state: "deleted", holdsRegistrationReference: false }),
    ]);
    expect(runtime.core.media!.getMedia(media.mediaId)).toBeNull();
    await runtime.stop();
  });

  it("reports a stable error when enabled Media cannot load Sharp", async () => {
    initializeLocalMedia();

    await expect(open()).rejects.toMatchObject({
      code: "RUNTIME_MEDIA_INSPECTOR_UNAVAILABLE",
      message: "Enabled persistent Media requires the optional Sharp image inspector",
    });
  });
});
