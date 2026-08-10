/**
 * Immutable producer registrations for structured-data content items.
 *
 * A registration binds one schema name and validator to an installed
 * Extension publisher and Module role. It does not grant a process capability
 * and it never trusts a publisher to assert ownership of an unrelated name.
 * The complete set is built before Modules start and can then be handed to the
 * Block commit boundary.
 *
 * Package schema version 2 does not exist yet, so this component is not a
 * product registration path by itself. Its inputs must eventually come from
 * verified installations plus deployment-owned reserved-name grants; callers
 * must not treat arbitrary objects as package provenance.
 */

import type { ValidateFunction } from "ajv";
import {
  canonicalJsonByteLength,
  canonicalJsonDigest,
  cloneJson,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";
import {
  parseContentSchemaName,
  type BlockContentItem,
} from "./block-content.js";
import { compileJsonSchema } from "./json-schema.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REGISTRABLE_EXTENSION_ID_PATTERN =
  /^[a-z][a-z0-9]*(?:\.[a-z0-9-]+)*$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const RESERVED_PREFIX = "dolly.";

export type ContentSchemaRegistrationErrorCode =
  | "SCHEMA_REGISTRATION_INVALID"
  | "SCHEMA_NAME_INVALID"
  | "SCHEMA_NAME_NOT_OWNED"
  | "SCHEMA_NAME_RESERVED"
  | "SCHEMA_REGISTRATION_CONFLICT"
  | "SCHEMA_VALIDATOR_INVALID"
  | "SCHEMA_VALIDATOR_DRIFT"
  | "SCHEMA_VALUE_INVALID"
  | "SCHEMA_VALUE_LIMIT_EXCEEDED"
  | "BLOCK_RESERVED_SCHEMA_FORBIDDEN";

export class ContentSchemaRegistrationError extends Error {
  constructor(
    readonly code: ContentSchemaRegistrationErrorCode,
    message: string,
    readonly details: Readonly<Record<string, JsonValue>> = {},
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "ContentSchemaRegistrationError";
  }
}

/** The installed package and Module role that may publish one schema name. */
export interface ContentSchemaPublisher {
  readonly extensionId: string;
  readonly packageVersion: string;
  readonly moduleKind: string;
}

/** One configured Module whose installed publisher identity has been resolved. */
export interface ContentSchemaModule extends ContentSchemaPublisher {
  readonly moduleId: string;
}

interface ContentSchemaRegistrationCommon {
  readonly schema: string;
  readonly producer: ContentSchemaPublisher;
  readonly validator: JsonValue;
  readonly validatorDigest: string;
  readonly maxValueBytes: number;
  /** Version 1 rejects Core references because no reference extractor exists. */
  readonly containsCoreReferences: false;
}

export type ContentSchemaRegistrationInput =
  | (ContentSchemaRegistrationCommon & {
      /** The declaration came from an installed Extension package. */
      readonly source: "extension-package";
    })
  | (ContentSchemaRegistrationCommon & {
      /** The host supplied a reserved-name registration and producer grant. */
      readonly source: "deployment";
    });

export interface ContentSchemaRegistrationSetOptions {
  readonly modules: readonly ContentSchemaModule[];
  readonly registrations: readonly ContentSchemaRegistrationInput[];
  readonly maxRegisteredValueBytes: number;
}

interface Registration {
  readonly source: ContentSchemaRegistrationInput["source"];
  readonly schema: string;
  readonly producer: Readonly<ContentSchemaPublisher>;
  readonly validator: JsonValue;
  readonly validatorDigest: string;
  readonly maxValueBytes: number;
  readonly containsCoreReferences: false;
  readonly validate: ValidateFunction;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new ContentSchemaRegistrationError(
      "SCHEMA_REGISTRATION_INVALID",
      `${label} is not a valid identifier`,
    );
  }
  return value;
}

function closedObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContentSchemaRegistrationError(
      "SCHEMA_REGISTRATION_INVALID",
      `${label} must be a plain object`,
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ContentSchemaRegistrationError(
      "SCHEMA_REGISTRATION_INVALID",
      `${label} must be a plain object`,
    );
  }
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ContentSchemaRegistrationError(
      "SCHEMA_REGISTRATION_INVALID",
      `${label} contains an unknown field`,
    );
  }
}

function publisher(
  value: ContentSchemaPublisher,
  label: string,
): Readonly<ContentSchemaPublisher> {
  closedObject(value, ["extensionId", "packageVersion", "moduleKind"], label);
  return deepFreeze({
    extensionId: identifier(value.extensionId, `${label}.extensionId`),
    packageVersion: identifier(value.packageVersion, `${label}.packageVersion`),
    moduleKind: identifier(value.moduleKind, `${label}.moduleKind`),
  });
}

function publisherKey(value: ContentSchemaPublisher): string {
  return `${value.extensionId}\0${value.packageVersion}\0${value.moduleKind}`;
}

function samePublisher(
  left: ContentSchemaPublisher,
  right: ContentSchemaPublisher,
): boolean {
  return publisherKey(left) === publisherKey(right);
}

function publicRegistration(registration: Registration): JsonValue {
  return {
    source: registration.source,
    schema: registration.schema,
    producer: { ...registration.producer },
    validator: registration.validator,
    validatorDigest: registration.validatorDigest,
    maxValueBytes: registration.maxValueBytes,
    containsCoreReferences: registration.containsCoreReferences,
  };
}

function sameRegistration(left: Registration, right: Registration): boolean {
  return canonicalJsonDigest(publicRegistration(left)) ===
    canonicalJsonDigest(publicRegistration(right));
}

/**
 * The frozen registration set for one instance configuration revision.
 * Construction validates every conflict before the set can reach BlockStore.
 */
export class ContentSchemaRegistrationSet {
  readonly #modules: ReadonlyMap<string, Readonly<ContentSchemaPublisher>>;
  readonly #registrations: ReadonlyMap<string, Registration>;

  constructor(options: ContentSchemaRegistrationSetOptions) {
    closedObject(
      options,
      ["modules", "registrations", "maxRegisteredValueBytes"],
      "Content schema registration options",
    );
    if (!Array.isArray(options.modules) || options.modules.length > 256) {
      throw new ContentSchemaRegistrationError(
        "SCHEMA_REGISTRATION_INVALID",
        "modules must be an array with at most 256 entries",
      );
    }
    if (!Array.isArray(options.registrations) || options.registrations.length > 16_384) {
      throw new ContentSchemaRegistrationError(
        "SCHEMA_REGISTRATION_INVALID",
        "registrations must be an array with at most 16384 entries",
      );
    }
    if (
      !Number.isSafeInteger(options.maxRegisteredValueBytes) ||
      options.maxRegisteredValueBytes <= 0
    ) {
      throw new ContentSchemaRegistrationError(
        "SCHEMA_REGISTRATION_INVALID",
        "maxRegisteredValueBytes must be a positive safe integer",
      );
    }
    const modules = new Map<string, Readonly<ContentSchemaPublisher>>();
    const publishers = new Set<string>();
    for (const [index, module] of options.modules.entries()) {
      closedObject(
        module,
        ["moduleId", "extensionId", "packageVersion", "moduleKind"],
        `modules[${index}]`,
      );
      const moduleId = identifier(module.moduleId, `modules[${index}].moduleId`);
      if (modules.has(moduleId)) {
        throw new ContentSchemaRegistrationError(
          "SCHEMA_REGISTRATION_CONFLICT",
          `Module ${moduleId} appears more than once in the registration set`,
        );
      }
      const resolvedPublisher = publisher({
        extensionId: module.extensionId,
        packageVersion: module.packageVersion,
        moduleKind: module.moduleKind,
      }, `modules[${index}]`);
      modules.set(moduleId, resolvedPublisher);
      publishers.add(publisherKey(resolvedPublisher));
    }

    const registrations = new Map<string, Registration>();
    for (const [index, input] of options.registrations.entries()) {
      const label = `registrations[${index}]`;
      closedObject(
        input,
        [
          "source",
          "schema",
          "producer",
          "validator",
          "validatorDigest",
          "maxValueBytes",
          "containsCoreReferences",
        ],
        label,
      );
      if (input.source !== "extension-package" && input.source !== "deployment") {
        throw new ContentSchemaRegistrationError(
          "SCHEMA_REGISTRATION_INVALID",
          `${label}.source is not supported`,
        );
      }
      let schema: string;
      try {
        schema = parseContentSchemaName(input.schema, `${label}.schema`);
      } catch (error) {
        throw new ContentSchemaRegistrationError(
          "SCHEMA_NAME_INVALID",
          `${label}.schema is not a valid content schema name`,
          {},
          { cause: error },
        );
      }
      const resolvedPublisher = publisher(input.producer, `${label}.producer`);
      if (!publishers.has(publisherKey(resolvedPublisher))) {
        throw new ContentSchemaRegistrationError(
          "SCHEMA_REGISTRATION_INVALID",
          `Registration ${schema} has no configured Module with its publisher identity`,
          { schema },
        );
      }
      const reserved = schema.startsWith(RESERVED_PREFIX);
      if (input.source === "extension-package" && reserved) {
        throw new ContentSchemaRegistrationError(
          "SCHEMA_NAME_RESERVED",
          `Extension package cannot claim reserved schema ${schema}`,
          { schema },
        );
      }
      if (input.source === "deployment" && !reserved) {
        throw new ContentSchemaRegistrationError(
          "SCHEMA_REGISTRATION_INVALID",
          `Deployment producer grants are only for reserved schema names`,
          { schema },
        );
      }
      if (input.source === "extension-package") {
        if (!REGISTRABLE_EXTENSION_ID_PATTERN.test(resolvedPublisher.extensionId)) {
          throw new ContentSchemaRegistrationError(
            "SCHEMA_NAME_NOT_OWNED",
            `Extension ${resolvedPublisher.extensionId} cannot own a content schema prefix`,
            { schema, extensionId: resolvedPublisher.extensionId },
          );
        }
        const unversionedName = schema.slice(0, schema.lastIndexOf("/"));
        if (!unversionedName.startsWith(`${resolvedPublisher.extensionId}.`)) {
          throw new ContentSchemaRegistrationError(
            "SCHEMA_NAME_NOT_OWNED",
            `Schema ${schema} is outside Extension ${resolvedPublisher.extensionId}'s namespace`,
            { schema, extensionId: resolvedPublisher.extensionId },
          );
        }
      }
      if (
        !Number.isSafeInteger(input.maxValueBytes) ||
        input.maxValueBytes <= 0 ||
        input.maxValueBytes > options.maxRegisteredValueBytes
      ) {
        throw new ContentSchemaRegistrationError(
          "SCHEMA_REGISTRATION_INVALID",
          `Registration ${schema} has an invalid maxValueBytes`,
          { schema },
        );
      }
      if (input.containsCoreReferences !== false) {
        throw new ContentSchemaRegistrationError(
          "SCHEMA_REGISTRATION_INVALID",
          `Registration ${schema} cannot contain Core references before an extractor is defined`,
          { schema },
        );
      }
      const validator = cloneJson(input.validator);
      let validate: ValidateFunction;
      try {
        validate = compileJsonSchema(validator);
      } catch (error) {
        throw new ContentSchemaRegistrationError(
          "SCHEMA_VALIDATOR_INVALID",
          `Registration ${schema} has an invalid JSON Schema validator`,
          { schema },
          { cause: error },
        );
      }
      if (
        typeof input.validatorDigest !== "string" ||
        !DIGEST_PATTERN.test(input.validatorDigest) ||
        canonicalJsonDigest(validator) !== input.validatorDigest
      ) {
        throw new ContentSchemaRegistrationError(
          "SCHEMA_VALIDATOR_DRIFT",
          `Registration ${schema} validator digest does not match its document`,
          {
            schema,
            expectedDigest:
              typeof input.validatorDigest === "string"
                ? input.validatorDigest
                : "invalid",
            observedDigest: canonicalJsonDigest(validator),
          },
        );
      }
      const registration: Registration = {
        source: input.source,
        schema,
        producer: resolvedPublisher,
        validator: deepFreeze(validator),
        validatorDigest: input.validatorDigest,
        maxValueBytes: input.maxValueBytes,
        containsCoreReferences: false,
        validate,
      };
      const existing = registrations.get(schema);
      if (existing !== undefined) {
        if (sameRegistration(existing, registration)) continue;
        throw new ContentSchemaRegistrationError(
          "SCHEMA_REGISTRATION_CONFLICT",
          `Content schema ${schema} has conflicting producer registrations`,
          {
            schema,
            existingProducer: publisherKey(existing.producer),
            conflictingProducer: publisherKey(registration.producer),
          },
        );
      }
      registrations.set(schema, registration);
    }
    this.#modules = modules;
    this.#registrations = registrations;
  }

  /** Validate all registered or reserved data items before Block allocation. */
  validate(
    items: readonly BlockContentItem[],
    source: { readonly kind: string; readonly id: string },
  ): void {
    for (const [itemIndex, item] of items.entries()) {
      if (item.type !== "data") continue;
      const registration = this.#registrations.get(item.schema);
      if (registration === undefined) {
        if (item.schema.startsWith(RESERVED_PREFIX)) {
          throw new ContentSchemaRegistrationError(
            "BLOCK_RESERVED_SCHEMA_FORBIDDEN",
            `Reserved content schema ${item.schema} has no configured producer`,
            { schema: item.schema, itemIndex },
          );
        }
        continue;
      }
      const actualPublisher =
        source.kind === "module" ? this.#modules.get(source.id) : undefined;
      if (
        actualPublisher === undefined ||
        !samePublisher(actualPublisher, registration.producer)
      ) {
        throw new ContentSchemaRegistrationError(
          "BLOCK_RESERVED_SCHEMA_FORBIDDEN",
          `Content schema ${item.schema} may be emitted only by its registered publisher and Module role`,
          { schema: item.schema, itemIndex, sourceKind: source.kind, sourceId: source.id },
        );
      }
      const valueBytes = canonicalJsonByteLength(item.value);
      if (valueBytes > registration.maxValueBytes) {
        throw new ContentSchemaRegistrationError(
          "SCHEMA_VALUE_LIMIT_EXCEEDED",
          `Content schema ${item.schema} value exceeds its registered byte limit`,
          {
            schema: item.schema,
            itemIndex,
            valueBytes,
            maxValueBytes: registration.maxValueBytes,
          },
        );
      }
      if (!registration.validate(item.value)) {
        throw new ContentSchemaRegistrationError(
          "SCHEMA_VALUE_INVALID",
          `Content schema ${item.schema} value does not satisfy its pinned validator`,
          { schema: item.schema, itemIndex },
        );
      }
    }
  }

  /** Stable public metadata for status, audit, and deterministic tests. */
  snapshot(): readonly JsonValue[] {
    return [...this.#registrations.values()]
      .sort((left, right) => left.schema.localeCompare(right.schema))
      .map((registration) => deepFreeze(publicRegistration(registration)));
  }
}
