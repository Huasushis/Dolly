import { describe, expect, it } from "vitest";
import type { JsonValue } from "../../../src/core/canonical-json.js";
import {
  createDefaultDollyInstanceConfig,
  dollyInstanceConfigSchema,
  RuntimeConfigError,
  validateDollyInstanceConfig,
} from "../../../src/core/runtime-config.js";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const CONFIGURATION_REVISION = `sha256:${"1".repeat(64)}`;

function configuredModule(): Record<string, JsonValue> {
  return {
    moduleId: "worker",
    extensionId: "org.example.worker",
    packageVersion: "1.2.3",
    moduleKind: "transform",
    isolation: "process",
    configurationReference: {
      configId: "worker-default",
      revision: CONFIGURATION_REVISION,
      configVersion: 1,
    },
    permissionPolicyIds: ["model.chat-primary"],
    inputPageIds: ["input"],
    outputPageIds: ["output"],
    subscriptionStart: "from-now",
    activation: { kind: "reactive" },
    limits: {
      claim: { maxCount: 32, maxBytes: 1024 * 1024 },
      maxInputBytes: 1024 * 1024,
      maxResultBytes: 1024 * 1024,
      maxFrameBytes: 2 * 1024 * 1024,
      maxRunsPerGeneration: 10_000,
      maxGenerations: 1_000,
    },
    timeouts: {
      initializationTimeoutMs: 10_000,
      executionTimeoutMs: 30_000,
      cancellationGraceMs: 1_000,
      terminationTimeoutMs: 2_000,
    },
  };
}

function smallEnabledMediaConfig(): Record<string, JsonValue> {
  return {
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
  };
}

function configurationWithMedia(media: JsonValue): JsonValue {
  const base = createDefaultDollyInstanceConfig(INSTANCE_ID);
  return {
    ...base,
    core: {
      ...base.core,
      media,
    },
  };
}

describe("Dolly runtime configuration schema", () => {
  it("creates a provider-neutral, secret-free local default", () => {
    const config = createDefaultDollyInstanceConfig(INSTANCE_ID);

    expect(config).toEqual({
      schemaVersion: "dolly.instance/9",
      instanceId: INSTANCE_ID,
      displayName: "Dolly",
      stateDirectory: null,
      core: {
        limits: {
          maxFailedAttempts: 3,
          maxStateBytes: 64 * 1024 * 1024,
          maxModuleResultCommitJournalBytes: 16 * 1024 * 1024,
        },
        media: { enabled: false },
        scheduler: {
          pollIntervalMs: 100,
          retryBaseMs: 250,
          retryMaxMs: 30_000,
        },
      },
      pages: [{ pageId: "main" }],
      modules: [],
      logging: { level: "info" },
    });
    expect(JSON.stringify(config)).not.toMatch(/aether|dashscope|oss|api[_-]?key/i);
  });

  it("validates topology with a non-secret Module configuration reference", () => {
    const value = {
      ...createDefaultDollyInstanceConfig(INSTANCE_ID),
      pages: [{ pageId: "input" }, { pageId: "output" }],
      modules: [configuredModule()],
    } as JsonValue;
    const config = validateDollyInstanceConfig(value);

    expect(config.modules[0]?.activation).toEqual({ kind: "reactive" });
    expect(config.modules[0]?.configurationReference).toEqual({
      configId: "worker-default",
      revision: CONFIGURATION_REVISION,
      configVersion: 1,
    });
    expect(dollyInstanceConfigSchema.redact(config)).toEqual(config);
    const module = config.modules[0]!;
    const frozenValues: readonly object[] = [
      config,
      config.core,
      config.core.limits,
      config.core.media,
      config.pages,
      config.pages[0]!,
      config.modules,
      module,
      module.configurationReference,
      module.permissionPolicyIds,
      module.inputPageIds,
      module.outputPageIds,
      module.activation,
      module.limits,
      module.limits.claim!,
      module.timeouts,
      config.logging,
    ];
    expect(frozenValues.every((value) => Object.isFrozen(value))).toBe(true);
  });

  it("rejects previous schema versions and open-ended documents instead of guessing", () => {
    for (const schemaVersion of [
      "dolly.instance/1",
      "dolly.instance/2",
      "dolly.instance/3",
      "dolly.instance/4",
      "dolly.instance/5",
      "dolly.instance/6",
      "dolly.instance/7",
      "dolly.instance/8",
    ]) {
      expect(() => validateDollyInstanceConfig({
        ...createDefaultDollyInstanceConfig(INSTANCE_ID),
        schemaVersion,
      })).toThrowError(
        expect.objectContaining<Partial<RuntimeConfigError>>({ code: "RUNTIME_CONFIG_INVALID" }),
      );
    }

    expect(() => validateDollyInstanceConfig({
      name: "legacy",
      dataDir: ".dolly",
      llm: {},
      pages: [],
      modules: [],
      logging: { level: "info" },
    })).toThrowError(
      expect.objectContaining<Partial<RuntimeConfigError>>({ code: "RUNTIME_CONFIG_INVALID" }),
    );

    expect(() => validateDollyInstanceConfig({
      ...createDefaultDollyInstanceConfig(INSTANCE_ID),
      surprise: true,
    })).toThrowError(/unknown fields/u);

    const current = createDefaultDollyInstanceConfig(INSTANCE_ID);
    expect(() => validateDollyInstanceConfig({
      ...current,
      core: { ...current.core, abandonedClaimPolicy: "retry" },
    })).toThrowError(/unknown fields/u);
  });

  it("rejects duplicate identities, unknown routes, and activation contradictions", () => {
    const base = createDefaultDollyInstanceConfig(INSTANCE_ID);
    expect(() => validateDollyInstanceConfig({
      ...base,
      pages: [{ pageId: "main" }, { pageId: "main" }],
    })).toThrowError(
      expect.objectContaining<Partial<RuntimeConfigError>>({
        code: "RUNTIME_CONFIG_TOPOLOGY_INVALID",
      }),
    );

    expect(() => validateDollyInstanceConfig({
      ...base,
      pages: [{ pageId: "input" }],
      modules: [{ ...configuredModule(), outputPageIds: ["missing"] }],
    })).toThrowError(/unknown Pages/u);

    expect(() => validateDollyInstanceConfig({
      ...base,
      pages: [{ pageId: "input" }],
      modules: [{
        ...configuredModule(),
        outputPageIds: [],
        activation: { kind: "source", trigger: "manual" },
        limits: {
          ...(configuredModule() as Record<string, JsonValue>).limits as Record<string, JsonValue>,
          claim: null,
        },
      }],
    })).toThrowError(/Source Module worker cannot have input Pages/u);
  });

  it("requires exact activation shapes and bounded numeric limits", () => {
    const base = createDefaultDollyInstanceConfig(INSTANCE_ID);
    expect(() => validateDollyInstanceConfig({
      ...base,
      pages: [{ pageId: "input" }],
      modules: [{
        ...configuredModule(),
        outputPageIds: [],
        activation: { kind: "reactive", periodMs: 1000 },
      }],
    })).toThrowError(/unknown fields/u);

    expect(() => validateDollyInstanceConfig({
      ...base,
      core: {
        ...base.core,
        limits: { ...base.core.limits, maxFailedAttempts: 0 },
      },
    })).toThrowError(/maxFailedAttempts/u);

    expect(() => validateDollyInstanceConfig({
      ...base,
      core: {
        ...base.core,
        limits: {
          maxAttempts: 3,
          maxStateBytes: base.core.limits.maxStateBytes,
          maxModuleResultCommitJournalBytes:
            base.core.limits.maxModuleResultCommitJournalBytes,
        },
      },
    })).toThrowError(/unknown fields: maxAttempts/u);

    expect(validateDollyInstanceConfig({
      ...base,
      pages: [{ pageId: "input" }],
      modules: [{
        ...configuredModule(),
        outputPageIds: [],
        activation: { kind: "periodic", periodMs: 2_147_483_648, allowEmptyInput: false },
      }],
    }).modules[0]?.activation).toEqual({
      kind: "periodic",
      periodMs: 2_147_483_648,
      allowEmptyInput: false,
    });

    expect(validateDollyInstanceConfig({
      ...base,
      pages: [{ pageId: "input" }],
      modules: [{
        ...configuredModule(),
        outputPageIds: [],
        limits: {
          ...(configuredModule() as Record<string, JsonValue>).limits as Record<string, JsonValue>,
          maxInputBytes: 512,
        },
      }],
    }).modules[0]?.limits.maxInputBytes).toBe(512);

    expect(() => validateDollyInstanceConfig({
      ...base,
      pages: [{ pageId: "input" }],
      modules: [{
        ...configuredModule(),
        outputPageIds: [],
        limits: {
          ...(configuredModule() as Record<string, JsonValue>).limits as Record<string, JsonValue>,
          maxFrameBytes: 1024 * 1024,
        },
      }],
    })).toThrowError(/protocol envelope/u);

    expect(() => validateDollyInstanceConfig({
      ...base,
      pages: [{ pageId: "input" }],
      modules: [{
        ...configuredModule(),
        outputPageIds: [],
        timeouts: {
          ...(configuredModule() as Record<string, JsonValue>).timeouts as Record<string, JsonValue>,
          executionTimeoutMs: 0,
        },
      }],
    })).toThrowError(/executionTimeoutMs/u);
  });

  it("normalizes the complete enabled Media configuration", () => {
    const expected = smallEnabledMediaConfig();
    const media = validateDollyInstanceConfig(configurationWithMedia(expected)).core.media;

    expect(media).toEqual(expected);
    expect(Object.isFrozen(media)).toBe(true);
    expect(media.enabled && Object.isFrozen(media.ingress)).toBe(true);
  });

  it("requires every enabled Media configuration field", () => {
    const requiredFields = [
      "enabled",
      "maxMediaBytes",
      "maxTotalMediaBytes",
      "maxRegistrationRecords",
      "maxStorageRecords",
      "maxProviderAccessRecords",
      "deletedRegistrationRetentionMs",
      "ingress",
    ] as const;
    for (const field of requiredFields) {
      const media = smallEnabledMediaConfig();
      delete media[field];
      expect(() => validateDollyInstanceConfig(configurationWithMedia(media)))
        .toThrowError(new RegExp(field, "u"));
    }

    const requiredIngressFields = [
      "maxActiveCapabilities",
      "maxConcurrentOperations",
      "maxCapabilityLifetimeMs",
    ] as const;
    for (const field of requiredIngressFields) {
      const media = smallEnabledMediaConfig();
      const ingress = media.ingress as Record<string, JsonValue>;
      delete ingress[field];
      expect(() => validateDollyInstanceConfig(configurationWithMedia(media)))
        .toThrowError(new RegExp(field, "u"));
    }
  });

  it("rejects invalid values for every enabled Media configuration field", () => {
    const invalidFields: readonly [string, JsonValue][] = [
      ["enabled", "yes"],
      ["maxMediaBytes", 0],
      ["maxTotalMediaBytes", 0],
      ["maxRegistrationRecords", 0],
      ["maxStorageRecords", 0],
      ["maxProviderAccessRecords", 0],
      ["deletedRegistrationRetentionMs", -1],
      ["ingress", null],
    ];
    for (const [field, invalidValue] of invalidFields) {
      const media = smallEnabledMediaConfig();
      media[field] = invalidValue;
      expect(() => validateDollyInstanceConfig(configurationWithMedia(media)))
        .toThrowError(new RegExp(field, "u"));
    }

    for (const field of [
      "maxActiveCapabilities",
      "maxConcurrentOperations",
      "maxCapabilityLifetimeMs",
    ] as const) {
      const media = smallEnabledMediaConfig();
      const ingress = media.ingress as Record<string, JsonValue>;
      ingress[field] = 0;
      expect(() => validateDollyInstanceConfig(configurationWithMedia(media)))
        .toThrowError(new RegExp(field, "u"));
    }

    for (const field of ["maxMediaBytes", "maxTotalMediaBytes"] as const) {
      const media = smallEnabledMediaConfig();
      media[field] = 1024 * 1024 * 1024 + 1;
      expect(() => validateDollyInstanceConfig(configurationWithMedia(media)))
        .toThrowError(new RegExp(field, "u"));
    }

    const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;
    for (const field of [
      "maxRegistrationRecords",
      "maxStorageRecords",
      "maxProviderAccessRecords",
      "deletedRegistrationRetentionMs",
    ] as const) {
      const media = smallEnabledMediaConfig();
      media[field] = unsafeInteger;
      expect(() => validateDollyInstanceConfig(configurationWithMedia(media)))
        .toThrowError(new RegExp(field, "u"));
    }
    for (const field of [
      "maxActiveCapabilities",
      "maxConcurrentOperations",
      "maxCapabilityLifetimeMs",
    ] as const) {
      const media = smallEnabledMediaConfig();
      const ingress = media.ingress as Record<string, JsonValue>;
      ingress[field] = unsafeInteger;
      expect(() => validateDollyInstanceConfig(configurationWithMedia(media)))
        .toThrowError(new RegExp(field, "u"));
    }
  });

  it("keeps both Media configuration variants closed", () => {
    expect(() => validateDollyInstanceConfig(configurationWithMedia({
      enabled: false,
      maxMediaBytes: 1024,
    }))).toThrowError(/unknown fields/u);

    const mediaWithUnknownField = smallEnabledMediaConfig();
    mediaWithUnknownField.unexpected = true;
    expect(() => validateDollyInstanceConfig(configurationWithMedia(mediaWithUnknownField)))
      .toThrowError(/unknown fields/u);

    const mediaWithUnknownIngressField = smallEnabledMediaConfig();
    (mediaWithUnknownIngressField.ingress as Record<string, JsonValue>).unexpected = true;
    expect(() => validateDollyInstanceConfig(configurationWithMedia(mediaWithUnknownIngressField)))
      .toThrowError(/unknown fields/u);
  });

  it("accepts immediate deleted-registration cleanup and rejects inconsistent byte limits", () => {
    const immediateCleanup = smallEnabledMediaConfig();
    immediateCleanup.deletedRegistrationRetentionMs = 0;
    const validated = validateDollyInstanceConfig(configurationWithMedia(immediateCleanup));
    expect(validated.core.media.enabled && validated.core.media.deletedRegistrationRetentionMs)
      .toBe(0);

    const inconsistentByteLimits = smallEnabledMediaConfig();
    inconsistentByteLimits.maxTotalMediaBytes = 512;
    expect(() => validateDollyInstanceConfig(configurationWithMedia(inconsistentByteLimits)))
      .toThrowError(/maxTotalMediaBytes/u);
  });

  it("requires finite scheduler polling and retry bounds", () => {
    const base = createDefaultDollyInstanceConfig(INSTANCE_ID);
    expect(() => validateDollyInstanceConfig({
      ...base,
      core: {
        ...base.core,
        scheduler: { ...base.core.scheduler, pollIntervalMs: 0 },
      },
    })).toThrowError(/pollIntervalMs/u);
    expect(() => validateDollyInstanceConfig({
      ...base,
      core: {
        ...base.core,
        scheduler: { ...base.core.scheduler, retryBaseMs: 1000, retryMaxMs: 999 },
      },
    })).toThrowError(/retryMaxMs/u);
  });

  it("rejects replaced Module field names instead of treating them as aliases", () => {
    const base = createDefaultDollyInstanceConfig(INSTANCE_ID);
    const current = configuredModule() as Record<string, JsonValue>;
    const replacements: readonly [string, string, JsonValue][] = [
      ["isolation", "executionProfile", "fault-isolated"],
      ["configurationReference", "configBinding", current.configurationReference!],
      ["permissionPolicyIds", "capabilityGrantIds", []],
    ];

    for (const [currentName, previousName, previousValue] of replacements) {
      const { [currentName]: _removed, ...withoutCurrentName } = current;
      expect(() => validateDollyInstanceConfig({
        ...base,
        pages: [{ pageId: "input" }],
        modules: [{
          ...withoutCurrentName,
          [previousName]: previousValue,
          outputPageIds: [],
        }],
      })).toThrowError(/unknown fields|missing fields/u);
    }
  });

  it("preserves the required opaque Extension package version", () => {
    const base = createDefaultDollyInstanceConfig(INSTANCE_ID);
    const module = configuredModule() as Record<string, JsonValue>;
    const { packageVersion: _packageVersion, ...withoutPackageVersion } = module;

    const opaquePackageVersion = "Release:2026_07";
    expect(validateDollyInstanceConfig({
      ...base,
      pages: [{ pageId: "input" }],
      modules: [{
        ...module,
        packageVersion: opaquePackageVersion,
        outputPageIds: [],
      }],
    }).modules[0]?.packageVersion).toBe(opaquePackageVersion);

    expect(() => validateDollyInstanceConfig({
      ...base,
      pages: [{ pageId: "input" }],
      modules: [{ ...withoutPackageVersion, outputPageIds: [] }],
    })).toThrowError(/packageVersion/u);
    expect(() => validateDollyInstanceConfig({
      ...base,
      pages: [{ pageId: "input" }],
      modules: [{ ...module, packageVersion: "contains whitespace", outputPageIds: [] }],
    })).toThrowError(/packageVersion/u);
  });

  it("rejects inline extension configuration so credentials cannot enter public runtime config", () => {
    const base = createDefaultDollyInstanceConfig(INSTANCE_ID);
    const module = configuredModule() as Record<string, JsonValue>;
    const {
      configurationReference: _configurationReference,
      ...withoutConfigurationReference
    } = module;

    expect(() => validateDollyInstanceConfig({
      ...base,
      pages: [{ pageId: "input" }],
      modules: [{
        ...withoutConfigurationReference,
        configVersion: 1,
        config: { apiKey: "must-not-live-here" },
        outputPageIds: [],
      }],
    })).toThrowError(/unknown fields|missing fields/u);

    expect(() => validateDollyInstanceConfig({
      ...base,
      pages: [{ pageId: "input" }],
      modules: [{
        ...module,
        configurationReference: {
          configId: "worker-default",
          revision: "revision-1",
          configVersion: 1,
          extensionId: "org.attacker.other",
        },
        outputPageIds: [],
      }],
    })).toThrowError(/unknown fields/u);

    expect(() => validateDollyInstanceConfig({
      ...base,
      pages: [{ pageId: "input" }],
      modules: [{
        ...module,
        configurationReference: {
          configId: "worker-default",
          revision: "revision-1",
          configVersion: 1,
        },
        outputPageIds: [],
      }],
    })).toThrowError(/SHA-256 digest/u);
  });

  it("requires claim limits only for Modules that consume Pages", () => {
    const base = createDefaultDollyInstanceConfig(INSTANCE_ID);
    const source = configuredModule() as Record<string, JsonValue>;
    const limits = source.limits as Record<string, JsonValue>;

    const validated = validateDollyInstanceConfig({
      ...base,
      pages: [{ pageId: "output" }],
      modules: [{
        ...source,
        inputPageIds: [],
        outputPageIds: ["output"],
        activation: { kind: "source", trigger: "manual" },
        limits: { ...limits, claim: null },
      }],
    });
    expect(validated.modules[0]?.limits.claim).toBeNull();

    expect(() => validateDollyInstanceConfig({
      ...base,
      pages: [{ pageId: "input" }],
      modules: [{
        ...configuredModule(),
        outputPageIds: [],
        limits: { ...limits, claim: null },
      }],
    })).toThrowError(/limits.claim/u);
  });
});
