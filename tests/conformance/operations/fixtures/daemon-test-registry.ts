/**
 * Builds a real instance registry for daemon tests.
 *
 * The daemon reads the records `InstanceConfigStore` writes under
 * `instances/`, so tests create them through that store rather than by hand.
 * A hand-written fixture could drift from the format the daemon must read.
 */

import { join } from "node:path";
import type { JsonValue } from "../../../../src/core/canonical-json.js";
import {
  InstanceConfigStore,
  type InstanceConfigSchema,
  type LoadedInstanceConfig,
} from "../../../../src/core/instance-config-store.js";

export type TestInstanceConfig = {
  readonly schemaVersion: "dolly.test-instance/1";
  readonly instanceId: string;
  readonly displayName: string;
};

const INSTANCE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const testInstanceSchema: InstanceConfigSchema<TestInstanceConfig> = {
  schemaVersion: "dolly.test-instance/1",
  validate(value: JsonValue): TestInstanceConfig {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("test instance configuration must be an object");
    }
    const document = value as Record<string, JsonValue>;
    if (
      document.schemaVersion !== "dolly.test-instance/1" ||
      typeof document.instanceId !== "string" ||
      !INSTANCE_ID_PATTERN.test(document.instanceId) ||
      typeof document.displayName !== "string"
    ) {
      throw new TypeError("test instance configuration is invalid");
    }
    return {
      schemaVersion: "dolly.test-instance/1",
      instanceId: document.instanceId,
      displayName: document.displayName,
    };
  },
  instanceId(document) {
    return document.instanceId;
  },
  stateDirectory() {
    return undefined;
  },
  withInstanceId(document, instanceId) {
    return { ...document, instanceId };
  },
  redact(document) {
    return { ...document };
  },
};

export interface TestInstanceRegistry {
  readonly registryDirectory: string;
  readonly stateRoot: string;
  readonly configDirectory: string;
  register(displayName: string): LoadedInstanceConfig<TestInstanceConfig>;
}

export function createTestInstanceRegistry(root: string): TestInstanceRegistry {
  const registryDirectory = join(root, "registry");
  const stateRoot = join(root, "state");
  const configDirectory = root;
  const store = new InstanceConfigStore<TestInstanceConfig>({
    schema: testInstanceSchema,
    registryDirectory,
    defaultStateRoot: stateRoot,
  });
  return {
    registryDirectory,
    stateRoot,
    configDirectory,
    register(displayName: string) {
      const configPath = join(configDirectory, `${displayName}.json`);
      return store.initialize(configPath, (instanceId) => ({
        schemaVersion: "dolly.test-instance/1",
        instanceId,
        displayName,
      }));
    },
  };
}
