import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceConfigStore } from "../../../src/core/instance-config-store.js";
import { InstanceControllerLock } from "../../../src/core/instance-controller-lock.js";
import {
  defaultDollyRuntimeDirectories,
  openDollyRuntime,
} from "../../../src/core/runtime-bootstrap.js";
import {
  createDefaultDollyInstanceConfig,
  dollyInstanceConfigSchema,
  validateDollyInstanceConfig,
} from "../../../src/core/runtime-config.js";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const FIRST_CONTROLLER = "22222222-2222-4222-8222-222222222222";
const SECOND_CONTROLLER = "33333333-3333-4333-8333-333333333333";
const REPLACEMENT_INSTANCE_ID = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-07-24T13:00:00.000Z";

describe("production runtime bootstrap", () => {
  let root: string;
  let registryDirectory: string;
  let defaultStateRoot: string;
  let configPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dolly-runtime-bootstrap-"));
    registryDirectory = join(root, "registry");
    defaultStateRoot = join(root, "instances");
    const project = join(root, "project");
    mkdirSync(project);
    configPath = join(project, "dolly.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function configStore(): InstanceConfigStore<ReturnType<typeof createDefaultDollyInstanceConfig>> {
    return new InstanceConfigStore({
      schema: dollyInstanceConfigSchema,
      registryDirectory,
      defaultStateRoot,
      nextInstanceId: () => INSTANCE_ID,
      now: () => NOW,
    });
  }

  function initializeDefault() {
    return configStore().initialize(configPath, (instanceId) =>
      createDefaultDollyInstanceConfig(instanceId),
    );
  }

  it("uses stable absolute platform state roots and ignores relative environment overrides", () => {
    expect(defaultDollyRuntimeDirectories({
      platform: "linux",
      homeDirectory: "/home/dolly",
      environment: { XDG_STATE_HOME: "/srv/dolly-state" },
    })).toEqual({
      registryDirectory: "/srv/dolly-state/dolly/registry",
      defaultStateRoot: "/srv/dolly-state/dolly/instances",
    });
    expect(defaultDollyRuntimeDirectories({
      platform: "linux",
      homeDirectory: "/home/dolly",
      environment: { XDG_STATE_HOME: "relative-state" },
    })).toEqual({
      registryDirectory: "/home/dolly/.local/state/dolly/registry",
      defaultStateRoot: "/home/dolly/.local/state/dolly/instances",
    });
    expect(defaultDollyRuntimeDirectories({
      platform: "win32",
      homeDirectory: "C:\\Users\\Dolly",
      environment: { LOCALAPPDATA: "relative-state" },
    })).toEqual({
      registryDirectory: "C:\\Users\\Dolly\\AppData\\Local\\Dolly\\registry",
      defaultStateRoot: "C:\\Users\\Dolly\\AppData\\Local\\Dolly\\instances",
    });
  });

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

  it("claims identity, creates durable Core state, and reports recovery before ready", async () => {
    const initialized = initializeDefault();
    const runtime = await openDollyRuntime({
      configPath,
      registryDirectory,
      defaultStateRoot,
      controllerId: FIRST_CONTROLLER,
      processId: 101,
      now: () => NOW,
    });

    expect(runtime.state).toBe("ready");
    expect(runtime.core.deliveries.snapshot().pages).toMatchObject([{ id: "main" }]);
    expect(runtime.recovery).toMatchObject({
      recoveredCommits: [],
      deferredCommits: [],
      releasedClaims: [],
      unknownOutcomeClaims: [],
      stoppedProcessGenerationIds: [],
      collectedRecords: { processRecords: 0 },
    });
    expect(runtime.recovery.handoff.schemaVersion).toBe(
      "dolly.core-startup-recovery-handoff/1",
    );
    expect(runtime.status()).toMatchObject({
      schemaVersion: "dolly.runtime-status/3",
      state: "ready",
      instanceId: INSTANCE_ID,
      effectiveConfigRevision: initialized.configRevision,
      coreRevision: expect.any(Number),
      providerAccessMarkedUnknownCount: 0,
    });
    expect(existsSync(join(initialized.stateDirectory, "core-state.json"))).toBe(true);
    expect(existsSync(join(initialized.stateDirectory, "module-result-commits.json"))).toBe(true);

    await runtime.stop();
    await runtime.stop();
    expect(runtime.state).toBe("stopped");
  });

  it("rejects the legacy processing-commits.json file before creating a new journal", async () => {
    const initialized = initializeDefault();
    writeFileSync(join(initialized.stateDirectory, "processing-commits.json"), "{}\n", "utf8");

    await expect(openDollyRuntime({
      configPath,
      registryDirectory,
      defaultStateRoot,
      controllerId: FIRST_CONTROLLER,
      processId: 101,
      now: () => NOW,
    })).rejects.toMatchObject({
      code: "RUNTIME_MODULE_MIGRATION_REQUIRED",
    });
    expect(existsSync(join(initialized.stateDirectory, "module-result-commits.json"))).toBe(false);
  });


  it("uses the bounded Sharp inspector by default when Media is enabled", async () => {
    initializeLocalMedia();
    const runtime = await openDollyRuntime({
      configPath,
      registryDirectory,
      defaultStateRoot,
      controllerId: FIRST_CONTROLLER,
      processId: 101,
      now: () => NOW,
    });
    const media = runtime.core.media;
    expect(media).toBeDefined();
    if (!media) throw new Error("Persistent Media was not initialized");

    const registeredMedia = await media.registerMedia({
      registrationId: "registration-runtime-bootstrap",
      bytes: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
      declaredMimeType: "image/png",
      provenance: { sourceClass: "streamed-upload" },
    });
    expect(registeredMedia).toMatchObject({
      mimeType: "image/png",
      width: 1,
      height: 1,
      frameCount: 1,
      channels: 2,
    });

    await runtime.stop();
  });

  it("excludes a concurrent controller and permits restart after clean stop", async () => {
    initializeDefault();
    const first = await openDollyRuntime({
      configPath,
      registryDirectory,
      defaultStateRoot,
      controllerId: FIRST_CONTROLLER,
      processId: 101,
      now: () => NOW,
    });
    await expect(openDollyRuntime({
      configPath,
      registryDirectory,
      defaultStateRoot,
      controllerId: SECOND_CONTROLLER,
      processId: 202,
      now: () => NOW,
    })).rejects.toMatchObject({
      code: "CONTROLLER_LOCK_HELD",
    });

    await first.stop();
    const restarted = await openDollyRuntime({
      configPath,
      registryDirectory,
      defaultStateRoot,
      controllerId: SECOND_CONTROLLER,
      processId: 202,
      now: () => NOW,
    });
    expect(restarted.status().coreRevision).toBe(first.status().coreRevision);
    await restarted.stop();
  });

  it("does not claim a replacement configuration after acquiring the original instance controller lock", async () => {
    const initialized = initializeDefault();
    const controllerDirectory = join(registryDirectory, "controllers");
    const heldControllerLock = await InstanceControllerLock.acquire({
      directory: controllerDirectory,
      instanceId: INSTANCE_ID,
      controllerGenerationIdGenerator: () => FIRST_CONTROLLER,
      processId: 101,
      now: () => NOW,
    });
    const acquire = InstanceControllerLock.acquire.bind(InstanceControllerLock);
    let allowAcquire: () => void = () => undefined;
    let observeAcquire: () => void = () => undefined;
    const acquireAllowed = new Promise<void>((resolveAllowed) => {
      allowAcquire = resolveAllowed;
    });
    const acquireObserved = new Promise<void>((resolveObserved) => {
      observeAcquire = resolveObserved;
    });
    const acquireSpy = vi
      .spyOn(InstanceControllerLock, "acquire")
      .mockImplementationOnce(async (options) => {
        observeAcquire();
        await acquireAllowed;
        return acquire(options);
      });

    const startup = openDollyRuntime({
      configPath,
      registryDirectory,
      defaultStateRoot,
      controllerId: SECOND_CONTROLLER,
      processId: 202,
      now: () => NOW,
    });
    await acquireObserved;

    const replacement = createDefaultDollyInstanceConfig(
      REPLACEMENT_INSTANCE_ID,
      "replacement",
    );
    writeFileSync(configPath, `${JSON.stringify(replacement, null, 2)}\n`, "utf8");
    const originalRegistryPath = join(registryDirectory, "instances", `${INSTANCE_ID}.json`);
    const originalRegistry = readFileSync(originalRegistryPath, "utf8");

    await heldControllerLock.release();
    allowAcquire();
    await expect(startup).rejects.toMatchObject({
      code: "RUNTIME_CONFIG_CHANGED_DURING_START",
    });
    acquireSpy.mockRestore();

    expect(readFileSync(originalRegistryPath, "utf8")).toBe(originalRegistry);
    expect(existsSync(
      join(registryDirectory, "instances", `${REPLACEMENT_INSTANCE_ID}.json`),
    )).toBe(false);
    expect(existsSync(join(defaultStateRoot, REPLACEMENT_INSTANCE_ID))).toBe(false);
    expect(existsSync(initialized.stateDirectory)).toBe(true);
  });

  it("rejects configured Modules without falling back to the legacy Orchestrator", async () => {
    configStore().initialize(configPath, (instanceId) => validateDollyInstanceConfig({
      ...createDefaultDollyInstanceConfig(instanceId),
      pages: [{ pageId: "input" }],
      modules: [{
        moduleId: "worker",
        extensionId: "org.example.worker",
        packageVersion: "1.2.3",
        moduleKind: "transform",
        isolation: "process",
        configurationReference: {
          configId: "worker-default",
          revision: `sha256:${"1".repeat(64)}`,
          configVersion: 1,
        },
        permissionPolicyIds: [],
        inputPageIds: ["input"],
        outputPageIds: [],
        subscriptionStart: "from-now",
        activation: { kind: "reactive" },
        limits: {
          claim: { maxCount: 16, maxBytes: 1024 },
          maxInputBytes: 16_384,
          maxResultBytes: 16_384,
          maxFrameBytes: 32_768,
          maxRunsPerGeneration: 100,
          maxGenerations: 10,
        },
        timeouts: {
          initializationTimeoutMs: 10_000,
          executionTimeoutMs: 30_000,
          cancellationGraceMs: 1_000,
          terminationTimeoutMs: 2_000,
        },
      }],
    }));

    await expect(openDollyRuntime({
      configPath,
      registryDirectory,
      defaultStateRoot,
      controllerId: FIRST_CONTROLLER,
      processId: 101,
      now: () => NOW,
    })).rejects.toMatchObject({
      code: "RUNTIME_MODULE_MIGRATION_REQUIRED",
    });
    expect(existsSync(join(defaultStateRoot, INSTANCE_ID, "core-state.json"))).toBe(false);
    expect(existsSync(join(registryDirectory, "controllers", `${INSTANCE_ID}.lock`))).toBe(false);
  });

  it("fails closed on durable topology not represented by configuration and releases startup ownership", async () => {
    initializeDefault();
    const first = await openDollyRuntime({
      configPath,
      registryDirectory,
      defaultStateRoot,
      controllerId: FIRST_CONTROLLER,
      processId: 101,
      now: () => NOW,
    });
    first.core.deliveries.createPage("unconfigured");
    await first.stop();

    await expect(openDollyRuntime({
      configPath,
      registryDirectory,
      defaultStateRoot,
      controllerId: SECOND_CONTROLLER,
      processId: 202,
      now: () => NOW,
    })).rejects.toMatchObject({
      code: "RUNTIME_TOPOLOGY_MISMATCH",
    });
    expect(existsSync(join(registryDirectory, "controllers", `${INSTANCE_ID}.lock`))).toBe(false);
  });
});
