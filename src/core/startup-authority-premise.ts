/**
 * H2 startup-authority boundary.
 *
 * This module consumes only the committed Runtime authority snapshot, the
 * currently held instance controller, and current installed-component origins.
 * It resolves the exact persistent premise into one fresh, object-identity
 * branded permission for this controller generation. It does not inspect or
 * start a service, prepare a cgroup, create a capability, launch a process, or
 * wire public Module activation.
 *
 * Authority direction is deliberately one way:
 * producer -> committed versioned premise -> this consumer. A missing premise,
 * downstream observation, copied object, stale generation, or caller assertion
 * cannot create the permission.
 */

import {
  RuntimeAuthorityDatabase,
  RuntimeAuthorityDatabaseError,
  type CurrentAuthoritySnapshot,
  type LinuxServiceCandidate,
  type ModuleActivationPremises,
  type PermissionPolicyBackendBinding,
  type PermissionPolicyDefinition,
  type ResolvedConfiguration,
} from "../adapters/storage/runtime-authority-database.js";
import {
  canonicalBytes,
  type JsonValue,
} from "../schema-bundle/index.js";
import {
  InstalledComponentOriginRegistry,
  type VerifiedInstalledComponentOrigin,
} from "./installed-component-origin.js";
import { InstanceControllerLock } from "./instance-controller-lock.js";
import { cloneJson, deepFreeze, canonicalizeJson } from "./canonical-json.js";

export interface StartupAuthorityPremiseResolverOptions {
  readonly database: RuntimeAuthorityDatabase;
  readonly controller: InstanceControllerLock;
  readonly origins: InstalledComponentOriginRegistry;
  readonly installedComponentOrigins: readonly VerifiedInstalledComponentOrigin[];
}
export interface StartupAuthorityPermissionContext {
  readonly database: RuntimeAuthorityDatabase;
  readonly controller: InstanceControllerLock;
  readonly origins: InstalledComponentOriginRegistry;
}


export interface StartupAuthorityPolicyBinding
  extends Omit<PermissionPolicyBackendBinding, "origin"> {
  readonly definition: PermissionPolicyDefinition;
  readonly origin: VerifiedInstalledComponentOrigin;
}

export type StartupAuthorityServiceCandidate = Omit<
  LinuxServiceCandidate,
  "origin"
> & {
  readonly origin: VerifiedInstalledComponentOrigin;
};

/**
 * A fresh Host-owned permission for the exact current persistent premise and
 * controller generation. This is a pre-composition authority token, not a
 * capability grant or proof that a Linux service has passed live inspection.
 */
export interface StartupAuthorityPermission {
  readonly permitted: true;
  readonly controllerGenerationId: string;
  readonly configRevision: number;
  readonly configDigest: string;
  readonly premisesDigest: string;
  readonly policyBindings: readonly StartupAuthorityPolicyBinding[];
  readonly serviceCandidate: StartupAuthorityServiceCandidate;
}

interface PermissionState {
  readonly database: RuntimeAuthorityDatabase;
  readonly controller: InstanceControllerLock;
  readonly origins: InstalledComponentOriginRegistry;
  readonly installedComponentOrigins: readonly VerifiedInstalledComponentOrigin[];
  readonly configRevision: number;
  readonly configDigest: string;
  readonly premisesDigest: string;
  readonly controllerGenerationId: string;
}

const PERMISSION_STATES = new WeakMap<object, PermissionState>();

function invalid(message: string, cause?: unknown): RuntimeAuthorityDatabaseError {
  return new RuntimeAuthorityDatabaseError(
    "MODULE_ACTIVATION_PREMISES_INVALID",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function unavailable(message: string, cause?: unknown): RuntimeAuthorityDatabaseError {
  return new RuntimeAuthorityDatabaseError(
    "MODULE_ACTIVATION_POLICY_BINDING_UNAVAILABLE",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertResolverOptions(
  value: unknown,
): asserts value is StartupAuthorityPremiseResolverOptions {
  if (!isPlainObject(value)) {
    throw new TypeError("startup authority premise resolver options must be a plain object");
  }
  const expected = ["controller", "database", "installedComponentOrigins", "origins"];
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected.slice().sort()[index])) {
    throw new TypeError("startup authority premise resolver options contain unknown fields");
  }
  if (!(value.database instanceof RuntimeAuthorityDatabase)) {
    throw new TypeError("startup authority premise resolver requires the Runtime authority database");
  }
  if (!(value.controller instanceof InstanceControllerLock)) {
    throw new TypeError("startup authority premise resolver requires the current instance controller");
  }
  if (!(value.origins instanceof InstalledComponentOriginRegistry)) {
    throw new TypeError("startup authority premise resolver requires the installed origin registry");
  }
  if (!Array.isArray(value.installedComponentOrigins)) {
    throw new TypeError("installed component origins must be an array");
  }
}

function originKey(origin: {
  readonly component_id: string;
  readonly component_revision: number;
  readonly component_digest: string;
}): string {
  return [origin.component_id, String(origin.component_revision), origin.component_digest].join("\u0000");
}

function selectionKey(selection: {
  readonly policy_id: string;
  readonly policy_revision: number;
  readonly policy_definition_digest: string;
  readonly binding_id: string;
  readonly binding_revision: number;
  readonly binding_digest: string;
}): string {
  return [
    selection.policy_id,
    String(selection.policy_revision),
    selection.policy_definition_digest,
    selection.binding_id,
    String(selection.binding_revision),
    selection.binding_digest,
  ].join("\u0000");
}

function definitionKey(definition: PermissionPolicyDefinition): string {
  return [definition.policy_id, String(definition.policy_revision), definition.definition_digest].join("\u0000");
}

function bindingKey(binding: PermissionPolicyBackendBinding): string {
  return [
    binding.policy_id,
    String(binding.policy_revision),
    binding.policy_definition_digest,
    binding.binding_id,
    String(binding.binding_revision),
    binding.binding_digest,
  ].join("\u0000");
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSortedUnique(keys: readonly string[], label: string): void {
  for (let index = 1; index < keys.length; index += 1) {
    if (compareKeys(keys[index - 1]!, keys[index]!) >= 0) {
      throw invalid(`${label} is not uniquely sorted by its canonical identity`);
    }
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalizeJson(left as JsonValue) === canonicalizeJson(right as JsonValue);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function assertCurrentIdentity(
  database: RuntimeAuthorityDatabase,
  controller: InstanceControllerLock,
): void {
  controller.assertHeld();
  if (controller.info.instanceId !== database.identity.instanceId) {
    throw invalid("controller ownership does not match the Runtime authority instance");
  }
}

function assertPremiseCurrentSnapshot(
  snapshot: CurrentAuthoritySnapshot | null,
  database: RuntimeAuthorityDatabase,
): asserts snapshot is CurrentAuthoritySnapshot {
  if (snapshot === null) {
    throw new RuntimeAuthorityDatabaseError(
      "AUTHORITY_DATABASE_UNINITIALIZED",
      "Runtime authority database has no committed current configuration",
    );
  }
  const premise = snapshot.premise;
  if (premise === null) {
    throw invalid("the current configuration has no installed-Linux Module premise");
  }
  const identity = database.identity;
  if (
    premise.daemon_installation_id !== identity.daemonInstallationId ||
    premise.instance_id !== identity.instanceId ||
    premise.config_revision !== snapshot.config_revision ||
    premise.config_digest !== snapshot.config_digest
  ) {
    throw invalid("the current premise does not bind the exact Runtime authority identity and revision");
  }
}

function assertPremiseCardinality(
  snapshot: CurrentAuthoritySnapshot,
): {
  readonly premise: ModuleActivationPremises;
  readonly configuration: ResolvedConfiguration;
} {
  const premise = snapshot.premise;
  if (premise === null) throw invalid("the current configuration has no installed-Linux Module premise");
  const configuration = snapshot.canonicalConfig as unknown as ResolvedConfiguration;
  if (configuration.service_candidate === null) {
    throw invalid("the current configuration does not select an installed-Linux service candidate");
  }
  if (!sameJson(configuration.service_candidate, premise.service_candidate)) {
    throw invalid("the premise service candidate differs from the exact current configuration");
  }

  const selections = configuration.permission_policy_selections;
  const selectionKeys = selections.map(selectionKey);
  assertSortedUnique(selectionKeys, "current permission-policy selections");
  const definitionKeys = premise.permission_policy_definitions.map(definitionKey);
  const bindingKeys = premise.permission_policy_backend_bindings.map(bindingKey);
  assertSortedUnique(definitionKeys, "premise permission-policy definitions");
  assertSortedUnique(bindingKeys, "premise permission-policy backend bindings");
  if (premise.permission_policy_definitions.length !== selections.length) {
    throw invalid("premise definition cardinality does not equal current policy selection cardinality");
  }
  if (premise.permission_policy_backend_bindings.length !== selections.length) {
    throw invalid("premise backend-binding cardinality does not equal current policy selection cardinality");
  }

  const definitions = new Map(definitionKeys.map((key, index) => [key, premise.permission_policy_definitions[index]!]));
  const bindings = new Map(bindingKeys.map((key, index) => [key, premise.permission_policy_backend_bindings[index]!]));
  for (const selection of selections) {
    const definition = definitions.get([
      selection.policy_id,
      String(selection.policy_revision),
      selection.policy_definition_digest,
    ].join("\u0000"));
    if (definition === undefined) {
      throw invalid("current policy selection has no exact persistent definition");
    }
    const binding = bindings.get(selectionKey(selection));
    if (binding === undefined) {
      throw invalid("current policy selection has no exact persistent backend binding");
    }
    if (
      binding.policy_id !== definition.policy_id ||
      binding.policy_revision !== definition.policy_revision ||
      binding.policy_definition_digest !== definition.definition_digest
    ) {
      throw invalid("persistent backend binding does not name the selected definition");
    }
  }
  return { premise, configuration };
}

function resolveOrigins(
  premise: ModuleActivationPremises,
  origins: InstalledComponentOriginRegistry,
  supplied: readonly VerifiedInstalledComponentOrigin[],
): Map<string, VerifiedInstalledComponentOrigin> {
  const current = new Map<string, VerifiedInstalledComponentOrigin>();
  for (const origin of supplied) {
    origins.assertCurrent(origin);
    const key = originKey(origin);
    if (current.has(key)) {
      throw invalid("installed component origin evidence contains duplicate identity");
    }
    current.set(key, origin);
  }
  const referenced = new Set<string>();
  const addReference = (origin: InstalledComponentOriginLike): void => {
    referenced.add(originKey(origin));
  };
  addReference(premise.service_candidate.origin);
  for (const binding of premise.permission_policy_backend_bindings) addReference(binding.origin);
  if (referenced.size !== current.size) {
    throw unavailable("installed component origin evidence has missing or extra records");
  }
  for (const key of referenced) {
    if (!current.has(key)) throw unavailable("persistent premise names an unavailable installed component origin");
  }
  return current;
}

type InstalledComponentOriginLike = {
  readonly component_id: string;
  readonly component_revision: number;
  readonly component_digest: string;
};

function buildPermission(
  snapshot: CurrentAuthoritySnapshot,
  controller: InstanceControllerLock,
  originMap: Map<string, VerifiedInstalledComponentOrigin>,
): StartupAuthorityPermission {
  const { premise } = assertPremiseCardinality(snapshot);
  const policyBindings = premise.permission_policy_backend_bindings.map((binding) => {
    const origin = originMap.get(originKey(binding.origin));
    if (origin === undefined) throw unavailable("backend binding names an unavailable installed component origin");
    const definition = premise.permission_policy_definitions.find(
      (candidate) =>
        candidate.policy_id === binding.policy_id &&
        candidate.policy_revision === binding.policy_revision &&
        candidate.definition_digest === binding.policy_definition_digest,
    );
    if (definition === undefined) throw invalid("backend binding has no exact persistent definition");
    return Object.freeze({
      ...binding,
      definition: deepFreeze({
        ...definition,
        definition: cloneJson(definition.definition),
        origin: { ...definition.origin },
      }) as PermissionPolicyDefinition,
      origin,
    }) as StartupAuthorityPolicyBinding;
  });
  const serviceOrigin = originMap.get(originKey(premise.service_candidate.origin));
  if (serviceOrigin === undefined) throw unavailable("service candidate names an unavailable installed component origin");
  const serviceCandidate = deepFreeze({
    ...premise.service_candidate,
    origin: serviceOrigin,
  }) as StartupAuthorityServiceCandidate;
  return Object.freeze({
    permitted: true as const,
    controllerGenerationId: controller.info.controllerGenerationId,
    configRevision: snapshot.config_revision,
    configDigest: snapshot.config_digest,
    premisesDigest: premise.premises_digest,
    policyBindings: Object.freeze(policyBindings),
    serviceCandidate,
  });
}

function assertPermissionCurrent(state: PermissionState, permission: StartupAuthorityPermission): void {
  assertCurrentIdentity(state.database, state.controller);
  if (state.controller.info.controllerGenerationId !== state.controllerGenerationId) {
    throw invalid("startup authority permission belongs to a stale controller generation");
  }
  const snapshot = state.database.readCurrentConfig();
  assertPremiseCurrentSnapshot(snapshot, state.database);
  if (
    snapshot.config_revision !== state.configRevision ||
    snapshot.config_digest !== state.configDigest ||
    snapshot.premise!.premises_digest !== state.premisesDigest
  ) {
    throw invalid("startup authority permission is stale for the current Runtime authority revision");
  }
  if (!sameBytes(snapshot.canonicalConfigBytes, canonicalBytesForConfig(snapshot.canonicalConfig))) {
    throw invalid("current configuration bytes are not the exact canonical authority bytes");
  }
  resolveOrigins(snapshot.premise!, state.origins, state.installedComponentOrigins);
  if (permission.configRevision !== state.configRevision || permission.configDigest !== state.configDigest) {
    throw invalid("startup authority permission identity was altered");
  }
}

function canonicalBytesForConfig(value: JsonValue): Uint8Array {
  return canonicalBytes(value);
}

/**
 * Resolves the one exact current premise and mints a fresh generation-bound
 * permission. Every read is performed from the Runtime authority database;
 * callers cannot supply a snapshot or downstream evidence.
 */
export function resolveStartupAuthorityPremise(
  options: StartupAuthorityPremiseResolverOptions,
): StartupAuthorityPermission {
  assertResolverOptions(options);
  assertCurrentIdentity(options.database, options.controller);
  const beforeGeneration = options.controller.info.controllerGenerationId;
  const snapshot = options.database.readCurrentConfig();
  assertPremiseCurrentSnapshot(snapshot, options.database);
  assertPremiseCardinality(snapshot);
  const originMap = resolveOrigins(
    snapshot.premise!,
    options.origins,
    options.installedComponentOrigins,
  );
  const permission = buildPermission(snapshot, options.controller, originMap);
  const state: PermissionState = {
    database: options.database,
    controller: options.controller,
    origins: options.origins,
    installedComponentOrigins: Object.freeze([...options.installedComponentOrigins]),
    configRevision: snapshot.config_revision,
    configDigest: snapshot.config_digest,
    premisesDigest: snapshot.premise!.premises_digest,
    controllerGenerationId: beforeGeneration,
  };
  PERMISSION_STATES.set(permission, state);
  options.controller.assertHeld();
  if (options.controller.info.controllerGenerationId !== beforeGeneration) {
    throw invalid("controller generation changed while resolving the startup premise");
  }
  assertPermissionCurrent(state, permission);
  return permission;
}

/**
 * Rechecks a permission against its original database, controller generation,
 * and installed-origin registry. Structural copies and stale permissions fail.
 */
export function assertStartupAuthorityPermission(
  value: unknown,
): asserts value is StartupAuthorityPermission {
  if (value === null || typeof value !== "object") {
    throw invalid("startup authority permission was not minted by the Host resolver");
  }
  const state = PERMISSION_STATES.get(value);
  if (state === undefined) {
    throw invalid("startup authority permission was not minted by the Host resolver");
  }
  assertPermissionCurrent(state, value as StartupAuthorityPermission);
}

/**
 * Requires the caller to hold the exact database, controller, and origin
 * registry that minted this permission before it may read the current config.
 * A structurally equivalent context from another Host is not authority.
 */
export function assertStartupAuthorityPermissionContext(
  value: unknown,
  context: StartupAuthorityPermissionContext,
): asserts value is StartupAuthorityPermission {
  if (
    !(context.database instanceof RuntimeAuthorityDatabase) ||
    !(context.controller instanceof InstanceControllerLock) ||
    !(context.origins instanceof InstalledComponentOriginRegistry)
  ) {
    throw invalid("startup authority permission context is not a live Host context");
  }
  assertStartupAuthorityPermission(value);
  const state = PERMISSION_STATES.get(value as object)!;
  if (
    state.database !== context.database ||
    state.controller !== context.controller ||
    state.origins !== context.origins
  ) {
    throw invalid(
      "startup authority permission context belongs to a different Runtime authority",
    );
  }
}
