/**
 * This handshake uses a hash-based message authentication code (HMAC) to
 * prove that both processes received the same secret. A nonce (one-time
 * random value) prevents replay of an old handshake.
 *
 * `dolly.inherited-child-control/1` identifies version 1 of the JSON messages on
 * two anonymous pipes inherited by the child: fd 3 is parent-to-child and fd 4
 * is child-to-parent. A Dolly-specific identifier is necessary because no
 * standard protocol describes this process startup and readiness handshake.
 * Readiness means that durable initialization is complete and every listener
 * required by the selected network policy is accepting connections.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  canonicalizeJson,
  deepFreeze,
  type JsonValue,
} from "./canonical-json.js";
import {
  parseSupervisorBootstrapMessage,
  type ChildReadinessEnvelope,
  type SupervisorBootstrapMessage,
} from "./process-supervisor.js";

export const INHERITED_CONTROL_MAX_FRAME_BYTES = 256 * 1024;
export const INHERITED_CONTROL_SCHEMA_VERSION = "dolly.inherited-child-control/1";

const PROOF_SCHEMA_VERSION = "dolly.inherited-child-control-proof/1";
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

export type InheritedControlProtocolErrorCode =
  | "CONTROL_MESSAGE_INVALID"
  | "CONTROL_BINDING_MISMATCH"
  | "CONTROL_PROOF_INVALID";

export class InheritedControlProtocolError extends Error {
  constructor(
    readonly code: InheritedControlProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "InheritedControlProtocolError";
  }
}

export interface ChildControlHelloMessage {
  readonly schemaVersion: typeof INHERITED_CONTROL_SCHEMA_VERSION;
  readonly type: "child.hello";
  readonly childNonce: string;
}

export interface ParentControlBootstrapMessage {
  readonly schemaVersion: typeof INHERITED_CONTROL_SCHEMA_VERSION;
  readonly type: "parent.bootstrap";
  readonly childNonce: string;
  readonly parentNonce: string;
  readonly bootstrap: SupervisorBootstrapMessage;
  readonly proof: string;
}

export interface ChildControlAuthenticatedMessage {
  readonly schemaVersion: typeof INHERITED_CONTROL_SCHEMA_VERSION;
  readonly type: "child.authenticated";
  readonly childNonce: string;
  readonly parentNonce: string;
  readonly binding: ControlBinding;
  readonly proof: string;
}

export interface ChildControlReadinessMessage {
  readonly schemaVersion: typeof INHERITED_CONTROL_SCHEMA_VERSION;
  readonly type: "child.readiness";
  readonly readiness: ChildReadinessEnvelope;
}

interface ControlBinding {
  readonly bootstrapSchemaVersion: SupervisorBootstrapMessage["schemaVersion"];
  readonly instanceId: string;
  readonly processGenerationId: string;
  readonly processIdentityToken: string;
  readonly daemonProtocolVersion: string;
  readonly ipcProtocolVersion: string;
  readonly configRevision: string;
}

function assertClosedObject(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InheritedControlProtocolError(
      "CONTROL_MESSAGE_INVALID",
      `${label} must be an object`,
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InheritedControlProtocolError(
      "CONTROL_MESSAGE_INVALID",
      `${label} must be a plain object`,
    );
  }
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new InheritedControlProtocolError(
        "CONTROL_MESSAGE_INVALID",
        `${label} contains an unknown field`,
      );
    }
  }
}

function assertNonce(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !NONCE_PATTERN.test(value)) {
    throw new InheritedControlProtocolError(
      "CONTROL_MESSAGE_INVALID",
      `${label} is invalid`,
    );
  }
}

function bindingFromBootstrap(bootstrap: SupervisorBootstrapMessage): ControlBinding {
  return {
    bootstrapSchemaVersion: bootstrap.schemaVersion,
    instanceId: bootstrap.instanceId,
    processGenerationId: bootstrap.processGenerationId,
    processIdentityToken: bootstrap.processIdentityToken,
    daemonProtocolVersion: bootstrap.daemonProtocolVersion,
    ipcProtocolVersion: bootstrap.ipcProtocolVersion,
    configRevision: bootstrap.configRevision,
  };
}

function parseBinding(value: unknown): ControlBinding {
  assertClosedObject(
    value,
    [
      "bootstrapSchemaVersion",
      "instanceId",
      "processGenerationId",
      "processIdentityToken",
      "daemonProtocolVersion",
      "ipcProtocolVersion",
      "configRevision",
    ],
    "binding",
  );
  const bootstrap = parseSupervisorBootstrapMessage({
    schemaVersion: value.bootstrapSchemaVersion,
    instanceId: value.instanceId,
    processGenerationId: value.processGenerationId,
    processIdentityToken: value.processIdentityToken,
    daemonProtocolVersion: value.daemonProtocolVersion,
    ipcProtocolVersion: value.ipcProtocolVersion,
    configRevision: value.configRevision,
    readinessChallenge: "A".repeat(43),
    readinessSecret: "B".repeat(43),
  });
  return bindingFromBootstrap(bootstrap);
}

function proofPayload(
  role: "parent" | "child",
  binding: ControlBinding,
  childNonce: string,
  parentNonce: string,
): Record<string, JsonValue> {
  return {
    schemaVersion: PROOF_SCHEMA_VERSION,
    role,
    binding: { ...binding },
    childNonce,
    parentNonce,
  };
}

function createProof(
  secret: string,
  role: "parent" | "child",
  binding: ControlBinding,
  childNonce: string,
  parentNonce: string,
): string {
  return createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(canonicalizeJson(proofPayload(role, binding, childNonce, parentNonce)), "utf8")
    .digest("base64url");
}

function proofMatches(actual: string, expected: string): boolean {
  if (!NONCE_PATTERN.test(actual) || !NONCE_PATTERN.test(expected)) return false;
  const actualBytes = Buffer.from(actual, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function bindingMatches(actual: ControlBinding, expected: ControlBinding): boolean {
  return (
    actual.bootstrapSchemaVersion === expected.bootstrapSchemaVersion &&
    actual.instanceId === expected.instanceId &&
    actual.processGenerationId === expected.processGenerationId &&
    actual.processIdentityToken === expected.processIdentityToken &&
    actual.daemonProtocolVersion === expected.daemonProtocolVersion &&
    actual.ipcProtocolVersion === expected.ipcProtocolVersion &&
    actual.configRevision === expected.configRevision
  );
}

export function createControlNonce(): string {
  return randomBytes(32).toString("base64url");
}

export function createChildControlHello(childNonce: string): ChildControlHelloMessage {
  assertNonce(childNonce, "childNonce");
  return deepFreeze({
    schemaVersion: INHERITED_CONTROL_SCHEMA_VERSION,
    type: "child.hello",
    childNonce,
  });
}

export function parseChildControlHello(value: unknown): ChildControlHelloMessage {
  assertClosedObject(value, ["schemaVersion", "type", "childNonce"], "child hello");
  if (
    value.schemaVersion !== INHERITED_CONTROL_SCHEMA_VERSION ||
    value.type !== "child.hello"
  ) {
    throw new InheritedControlProtocolError(
      "CONTROL_MESSAGE_INVALID",
      "Child hello has an unsupported envelope",
    );
  }
  assertNonce(value.childNonce, "childNonce");
  return createChildControlHello(value.childNonce);
}

export function createParentControlBootstrap(
  bootstrapValue: SupervisorBootstrapMessage,
  childNonce: string,
): ParentControlBootstrapMessage {
  const bootstrap = parseSupervisorBootstrapMessage(bootstrapValue);
  assertNonce(childNonce, "childNonce");
  const parentNonce = bootstrap.readinessChallenge;
  const binding = bindingFromBootstrap(bootstrap);
  return deepFreeze({
    schemaVersion: INHERITED_CONTROL_SCHEMA_VERSION,
    type: "parent.bootstrap",
    childNonce,
    parentNonce,
    bootstrap,
    proof: createProof(
      bootstrap.readinessSecret,
      "parent",
      binding,
      childNonce,
      parentNonce,
    ),
  }) as ParentControlBootstrapMessage;
}

export function parseParentControlBootstrap(
  value: unknown,
  expectedChildNonce: string,
): ParentControlBootstrapMessage {
  assertClosedObject(
    value,
    ["schemaVersion", "type", "childNonce", "parentNonce", "bootstrap", "proof"],
    "parent bootstrap",
  );
  if (
    value.schemaVersion !== INHERITED_CONTROL_SCHEMA_VERSION ||
    value.type !== "parent.bootstrap"
  ) {
    throw new InheritedControlProtocolError(
      "CONTROL_MESSAGE_INVALID",
      "Parent bootstrap has an unsupported envelope",
    );
  }
  assertNonce(value.childNonce, "childNonce");
  assertNonce(value.parentNonce, "parentNonce");
  assertNonce(value.proof, "proof");
  if (value.childNonce !== expectedChildNonce) {
    throw new InheritedControlProtocolError(
      "CONTROL_BINDING_MISMATCH",
      "Parent bootstrap did not answer this child challenge",
    );
  }
  const bootstrap = parseSupervisorBootstrapMessage(value.bootstrap);
  if (value.parentNonce !== bootstrap.readinessChallenge) {
    throw new InheritedControlProtocolError(
      "CONTROL_BINDING_MISMATCH",
      "Parent challenge is not bound to readiness",
    );
  }
  const expectedProof = createProof(
    bootstrap.readinessSecret,
    "parent",
    bindingFromBootstrap(bootstrap),
    value.childNonce,
    value.parentNonce,
  );
  if (!proofMatches(value.proof, expectedProof)) {
    throw new InheritedControlProtocolError(
      "CONTROL_PROOF_INVALID",
      "Parent control proof is invalid",
    );
  }
  return deepFreeze({
    schemaVersion: INHERITED_CONTROL_SCHEMA_VERSION,
    type: "parent.bootstrap",
    childNonce: value.childNonce,
    parentNonce: value.parentNonce,
    bootstrap,
    proof: value.proof,
  }) as ParentControlBootstrapMessage;
}

export function createChildControlAuthenticated(
  parent: ParentControlBootstrapMessage,
): ChildControlAuthenticatedMessage {
  const parsed = parseParentControlBootstrap(parent, parent.childNonce);
  const binding = bindingFromBootstrap(parsed.bootstrap);
  return deepFreeze({
    schemaVersion: INHERITED_CONTROL_SCHEMA_VERSION,
    type: "child.authenticated",
    childNonce: parsed.childNonce,
    parentNonce: parsed.parentNonce,
    binding,
    proof: createProof(
      parsed.bootstrap.readinessSecret,
      "child",
      binding,
      parsed.childNonce,
      parsed.parentNonce,
    ),
  }) as ChildControlAuthenticatedMessage;
}

export function parseChildControlAuthenticated(
  value: unknown,
  parent: ParentControlBootstrapMessage,
): ChildControlAuthenticatedMessage {
  assertClosedObject(
    value,
    ["schemaVersion", "type", "childNonce", "parentNonce", "binding", "proof"],
    "child authentication",
  );
  if (
    value.schemaVersion !== INHERITED_CONTROL_SCHEMA_VERSION ||
    value.type !== "child.authenticated"
  ) {
    throw new InheritedControlProtocolError(
      "CONTROL_MESSAGE_INVALID",
      "Child authentication has an unsupported envelope",
    );
  }
  assertNonce(value.childNonce, "childNonce");
  assertNonce(value.parentNonce, "parentNonce");
  assertNonce(value.proof, "proof");
  if (
    value.childNonce !== parent.childNonce ||
    value.parentNonce !== parent.parentNonce
  ) {
    throw new InheritedControlProtocolError(
      "CONTROL_BINDING_MISMATCH",
      "Child authentication answered another challenge",
    );
  }
  const binding = parseBinding(value.binding);
  const expectedBinding = bindingFromBootstrap(parent.bootstrap);
  if (!bindingMatches(binding, expectedBinding)) {
    throw new InheritedControlProtocolError(
      "CONTROL_BINDING_MISMATCH",
      "Child authentication is bound to another generation or configuration",
    );
  }
  const expectedProof = createProof(
    parent.bootstrap.readinessSecret,
    "child",
    expectedBinding,
    parent.childNonce,
    parent.parentNonce,
  );
  if (!proofMatches(value.proof, expectedProof)) {
    throw new InheritedControlProtocolError(
      "CONTROL_PROOF_INVALID",
      "Child control proof is invalid",
    );
  }
  return deepFreeze({
    schemaVersion: INHERITED_CONTROL_SCHEMA_VERSION,
    type: "child.authenticated",
    childNonce: value.childNonce,
    parentNonce: value.parentNonce,
    binding,
    proof: value.proof,
  }) as ChildControlAuthenticatedMessage;
}

export function createChildControlReadiness(
  readiness: ChildReadinessEnvelope,
): ChildControlReadinessMessage {
  return deepFreeze({
    schemaVersion: INHERITED_CONTROL_SCHEMA_VERSION,
    type: "child.readiness",
    readiness,
  }) as ChildControlReadinessMessage;
}

export function parseChildControlReadiness(value: unknown): ChildReadinessEnvelope {
  assertClosedObject(value, ["schemaVersion", "type", "readiness"], "child readiness");
  if (
    value.schemaVersion !== INHERITED_CONTROL_SCHEMA_VERSION ||
    value.type !== "child.readiness"
  ) {
    throw new InheritedControlProtocolError(
      "CONTROL_MESSAGE_INVALID",
      "Child readiness has an unsupported envelope",
    );
  }
  if (value.readiness === null || typeof value.readiness !== "object" || Array.isArray(value.readiness)) {
    throw new InheritedControlProtocolError(
      "CONTROL_MESSAGE_INVALID",
      "Child readiness payload must be an object",
    );
  }
  return value.readiness as unknown as ChildReadinessEnvelope;
}

export function asControlJson(
  message:
    | ChildControlHelloMessage
    | ParentControlBootstrapMessage
    | ChildControlAuthenticatedMessage
    | ChildControlReadinessMessage,
): JsonValue {
  return message as unknown as JsonValue;
}
