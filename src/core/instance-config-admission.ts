import {
  InstanceConfigError,
  InstanceConfigStore,
  type LoadedInstanceConfig,
} from "./instance-config-store.js";
import {
  dollyInstanceConfigSchema,
  type DollyInstanceConfig,
} from "./runtime-config.js";
import {
  dollyInstanceConfigV10Schema,
  type DollyInstanceConfigV10Draft,
} from "./runtime-config-v10.js";

/**
 * The two frozen configuration dialects the product read path can admit: the
 * version-9 product dialect and the reserved version-10 draft. Both documents
 * are complete; the read path consumes only the fields they share.
 */
export type DollyInstanceConfigDialect =
  | DollyInstanceConfig
  | DollyInstanceConfigV10Draft;

export interface DollyInstanceConfigAdmissionOptions {
  readonly registryDirectory: string;
  readonly defaultStateRoot: string;
  readonly maxConfigBytes?: number;
  readonly nextInstanceId?: () => string;
  readonly now?: () => string;
}

type DialectInspection = LoadedInstanceConfig<DollyInstanceConfigDialect>;

/**
 * Configuration admission: checks a document against the version-9 dialect
 * first and falls back to the version-10 draft only when the version-9 store
 * rejects the document as not satisfying its closed schema. A document
 * invalid under both dialects reports the identical version-9 error, so the
 * observable failure is deterministic and unchanged. Admission itself writes
 * nothing; the per-dialect stores perform their usual I/O through this layer.
 */
export class DollyInstanceConfigAdmission {
  readonly #version9: InstanceConfigStore<DollyInstanceConfig>;
  readonly #version10: InstanceConfigStore<DollyInstanceConfigV10Draft>;

  constructor(options: DollyInstanceConfigAdmissionOptions) {
    const shared = {
      registryDirectory: options.registryDirectory,
      defaultStateRoot: options.defaultStateRoot,
      ...(options.maxConfigBytes === undefined
        ? {}
        : { maxConfigBytes: options.maxConfigBytes }),
      ...(options.nextInstanceId === undefined
        ? {}
        : { nextInstanceId: options.nextInstanceId }),
      ...(options.now === undefined ? {} : { now: options.now }),
    };
    this.#version9 = new InstanceConfigStore({
      schema: dollyInstanceConfigSchema,
      ...shared,
    });
    this.#version10 = new InstanceConfigStore({
      schema: dollyInstanceConfigV10Schema,
      ...shared,
    });
  }

  inspect(configPath: string): DialectInspection {
    return admit(
      () => this.#version9.inspect(configPath),
      () => this.#version10.inspect(configPath),
    );
  }

  claim(
    configPath: string,
    expected: Pick<DialectInspection, "instanceId" | "configRevision">,
  ): DialectInspection {
    return admit(
      () => this.#version9.claim(configPath, expected),
      () => this.#version10.claim(configPath, expected),
    );
  }
}

function admit(
  version9: () => DialectInspection,
  version10: () => DialectInspection,
): DialectInspection {
  try {
    return version9();
  } catch (error) {
    if (
      !(error instanceof InstanceConfigError) ||
      error.code !== "CONFIG_DOCUMENT_INVALID"
    ) {
      throw error;
    }
    try {
      return version10();
    } catch {
      throw error;
    }
  }
}