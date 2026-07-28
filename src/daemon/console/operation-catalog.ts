/**
 * The declared, versioned set of management-console operations.
 *
 * `instance-topology.md` Section 5.4 makes capability parity a testable
 * statement rather than a design aspiration: the operations exposed to the
 * graphical editor MUST be exactly the operations exposed to the command-line
 * interface (CLI), including operation names, required arguments, confirmation
 * requirements, and error codes. This module is the single declaration both
 * exposures are compared against. The Hypertext Transfer Protocol (HTTP) router
 * and the CLI each build their own list from their own routing tables; a
 * conformance test compares those two lists with each other and with this
 * catalog, so adding an operation to one exposure only fails the test.
 *
 * Error codes are reused rather than duplicated, as Section 12 requires:
 * `RUNTIME_CONFIG_INVALID`, `RUNTIME_CONFIG_TOPOLOGY_INVALID`, and
 * `CONFIG_REVISION_CONFLICT` keep the names their owning modules already use.
 *
 * **What belongs in this catalog.** The criterion is what an operator can *do*:
 * anything that reads private state or changes daemon, instance, or
 * configuration state is an operation and MUST have both an HTTP route and a
 * CLI command, because a headless server has no graphical editor to fall back
 * on. A route is exempt only when it reports liveness, carries the browser's
 * own session lifecycle, or returns a static listing whose entries are each
 * independently reachable. `GET /v1/admin/operations` is exempt under the last
 * clause: it returns this constant and dispatches nothing, and every operation
 * it lists has its own route and its own CLI command, so excluding it hides no
 * capability from a command-line operator. `AdminHttpServer.surfaceRoutes()`
 * exposes the exempt set and a conformance test pins it, so a route that does
 * real work cannot join it silently.
 */

import { deepFreeze } from "../../core/canonical-json.js";

export type ConsoleOperationErrorCode =
  // Reused from the modules that already own these conditions.
  | "RUNTIME_CONFIG_INVALID"
  | "RUNTIME_CONFIG_TOPOLOGY_INVALID"
  | "CONFIG_REVISION_CONFLICT"
  // Topology editing, `instance-topology.md` Section 12.
  | "TOPOLOGY_PLAN_STALE"
  | "TOPOLOGY_CONFIRMATION_REQUIRED"
  | "TOPOLOGY_PAGE_HAS_OBLIGATIONS"
  | "TOPOLOGY_MODULE_BUSY"
  | "TOPOLOGY_UNKNOWN_OUTCOME_PRESENT"
  | "TOPOLOGY_START_POSITION_REQUIRED"
  | "TOPOLOGY_CHECKPOINT_UNAVAILABLE"
  | "TOPOLOGY_OWNED_BY_ANOTHER_CONTRACT"
  | "TOPOLOGY_CAPABILITY_DISABLED"
  // Additions this implementation needs; Section 12 states its list is a
  // proposed minimum. Each names a condition that no listed code covers.
  | "TOPOLOGY_START_POSITION_UNSUPPORTED"
  | "TOPOLOGY_START_POSITION_CONFLICT"
  | "TOPOLOGY_DISPOSITION_REQUIRED"
  | "TOPOLOGY_STORAGE_DECISION_REQUIRED"
  | "TOPOLOGY_PLAN_REJECTED"
  // Unknown Module outcomes, `security-operations.md` Section 13.1.
  | "UNKNOWN_OUTCOME_CLAIM_NOT_FOUND"
  | "UNKNOWN_OUTCOME_WARNING_REQUIRED"
  | "UNKNOWN_OUTCOME_EVIDENCE_STALE"
  | "UNKNOWN_OUTCOME_DISPOSITION_INVALID"
  // Request shape and instance binding.
  | "ADMIN_REQUEST_INVALID"
  | "ADMIN_INSTANCE_NOT_FOUND"
  | "ADMIN_INSTANCE_MISMATCH"
  | "ADMIN_OPERATION_FAILED";

export class ConsoleOperationError extends Error {
  constructor(
    readonly code: ConsoleOperationErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ConsoleOperationError";
  }
}

/** HTTP status for one operation error, used only by the HTTP exposure. */
export function consoleErrorStatus(code: ConsoleOperationErrorCode): number {
  switch (code) {
    case "CONFIG_REVISION_CONFLICT":
    case "TOPOLOGY_PLAN_STALE":
      return 409;
    case "ADMIN_INSTANCE_NOT_FOUND":
    case "UNKNOWN_OUTCOME_CLAIM_NOT_FOUND":
      return 404;
    case "ADMIN_OPERATION_FAILED":
      return 500;
    default:
      return 400;
  }
}

export interface ConsoleOperationDeclaration {
  readonly name: string;
  /** True when the operation changes daemon, process, or configuration state. */
  readonly mutating: boolean;
  readonly requiredArguments: readonly string[];
  readonly optionalArguments: readonly string[];
  /**
   * The confirmation the caller must supply before a consequence is applied,
   * or `null` when the operation never needs one.
   */
  readonly confirmation: string | null;
  readonly errorCodes: readonly ConsoleOperationErrorCode[];
}

const CATALOG: readonly ConsoleOperationDeclaration[] = [
  {
    name: "instance.list",
    mutating: false,
    requiredArguments: [],
    optionalArguments: [],
    confirmation: null,
    errorCodes: ["ADMIN_OPERATION_FAILED"],
  },
  {
    name: "instance.describe",
    mutating: false,
    requiredArguments: ["instanceId"],
    optionalArguments: [],
    confirmation: null,
    errorCodes: ["ADMIN_INSTANCE_NOT_FOUND", "ADMIN_OPERATION_FAILED"],
  },
  {
    name: "instance.start",
    mutating: true,
    requiredArguments: ["instanceId", "operationId"],
    optionalArguments: [],
    confirmation: null,
    errorCodes: ["ADMIN_INSTANCE_NOT_FOUND", "ADMIN_REQUEST_INVALID", "ADMIN_OPERATION_FAILED"],
  },
  {
    name: "instance.stop",
    mutating: true,
    requiredArguments: ["instanceId", "operationId"],
    optionalArguments: [],
    confirmation: null,
    errorCodes: ["ADMIN_INSTANCE_NOT_FOUND", "ADMIN_REQUEST_INVALID", "ADMIN_OPERATION_FAILED"],
  },
  {
    name: "config.read",
    mutating: false,
    requiredArguments: ["instanceId"],
    optionalArguments: [],
    confirmation: null,
    errorCodes: ["ADMIN_INSTANCE_NOT_FOUND", "RUNTIME_CONFIG_INVALID", "ADMIN_OPERATION_FAILED"],
  },
  {
    name: "topology.plan",
    mutating: false,
    requiredArguments: ["instanceId", "expectedRevision", "proposal"],
    optionalArguments: ["startPositions", "dispositions", "modulePrivateStorage"],
    confirmation: null,
    errorCodes: [
      "ADMIN_INSTANCE_NOT_FOUND",
      "ADMIN_INSTANCE_MISMATCH",
      "RUNTIME_CONFIG_INVALID",
      "RUNTIME_CONFIG_TOPOLOGY_INVALID",
      "TOPOLOGY_START_POSITION_REQUIRED",
      "TOPOLOGY_START_POSITION_CONFLICT",
      "TOPOLOGY_START_POSITION_UNSUPPORTED",
      "TOPOLOGY_CHECKPOINT_UNAVAILABLE",
      "TOPOLOGY_OWNED_BY_ANOTHER_CONTRACT",
    ],
  },
  {
    name: "topology.commit",
    mutating: true,
    requiredArguments: ["instanceId", "expectedRevision", "proposal", "operationId"],
    optionalArguments: [
      "startPositions",
      "dispositions",
      "modulePrivateStorage",
      "confirmedPlanDigest",
    ],
    confirmation: "confirmedPlanDigest",
    errorCodes: [
      "ADMIN_INSTANCE_NOT_FOUND",
      "ADMIN_INSTANCE_MISMATCH",
      "RUNTIME_CONFIG_INVALID",
      "RUNTIME_CONFIG_TOPOLOGY_INVALID",
      "CONFIG_REVISION_CONFLICT",
      "TOPOLOGY_PLAN_STALE",
      "TOPOLOGY_CONFIRMATION_REQUIRED",
      "TOPOLOGY_PAGE_HAS_OBLIGATIONS",
      "TOPOLOGY_MODULE_BUSY",
      "TOPOLOGY_UNKNOWN_OUTCOME_PRESENT",
      "TOPOLOGY_START_POSITION_REQUIRED",
      "TOPOLOGY_START_POSITION_CONFLICT",
      "TOPOLOGY_START_POSITION_UNSUPPORTED",
      "TOPOLOGY_CHECKPOINT_UNAVAILABLE",
      "TOPOLOGY_OWNED_BY_ANOTHER_CONTRACT",
      "TOPOLOGY_CAPABILITY_DISABLED",
      "TOPOLOGY_DISPOSITION_REQUIRED",
      "TOPOLOGY_STORAGE_DECISION_REQUIRED",
      "TOPOLOGY_PLAN_REJECTED",
    ],
  },
  {
    name: "claim.listUnknownOutcomes",
    mutating: false,
    requiredArguments: ["instanceId"],
    optionalArguments: [],
    confirmation: null,
    errorCodes: ["ADMIN_INSTANCE_NOT_FOUND", "ADMIN_OPERATION_FAILED"],
  },
  {
    name: "claim.disposeUnknownOutcome",
    mutating: true,
    requiredArguments: ["instanceId", "claimToken", "disposition", "operationId"],
    optionalArguments: ["acknowledgedWarningDigest"],
    confirmation: "acknowledgedWarningDigest",
    errorCodes: [
      "ADMIN_INSTANCE_NOT_FOUND",
      "ADMIN_REQUEST_INVALID",
      "UNKNOWN_OUTCOME_CLAIM_NOT_FOUND",
      "UNKNOWN_OUTCOME_DISPOSITION_INVALID",
      "UNKNOWN_OUTCOME_WARNING_REQUIRED",
      "UNKNOWN_OUTCOME_EVIDENCE_STALE",
      "ADMIN_OPERATION_FAILED",
    ],
  },
];

export const CONSOLE_OPERATION_CATALOG_VERSION = "dolly.console-operations/1";

/** The declared operation set, sorted by name so comparisons are order-free. */
export const CONSOLE_OPERATION_CATALOG: readonly ConsoleOperationDeclaration[] = deepFreeze(
  [...CATALOG]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((entry) => ({
      ...entry,
      requiredArguments: [...entry.requiredArguments].sort(),
      optionalArguments: [...entry.optionalArguments].sort(),
      errorCodes: [...new Set(entry.errorCodes)].sort() as readonly ConsoleOperationErrorCode[],
    })),
) as readonly ConsoleOperationDeclaration[];

export const CONSOLE_OPERATION_NAMES: readonly string[] = deepFreeze(
  CONSOLE_OPERATION_CATALOG.map((entry) => entry.name),
) as readonly string[];

export function consoleOperationDeclaration(name: string): ConsoleOperationDeclaration {
  const found = CONSOLE_OPERATION_CATALOG.find((entry) => entry.name === name);
  if (!found) throw new Error(`No console operation named ${name} is declared`);
  return found;
}

/**
 * Projects an exposure's own operation list onto the catalog shape so two
 * exposures can be compared for equality. An exposure that names an operation
 * the catalog does not declare fails here rather than silently widening one
 * interface.
 */
export function describeExposure(
  operationNames: readonly string[],
): readonly ConsoleOperationDeclaration[] {
  const unique = [...new Set(operationNames)].sort();
  if (unique.length !== operationNames.length) {
    throw new Error("An exposure declared the same operation twice");
  }
  return deepFreeze(
    unique.map((name) => consoleOperationDeclaration(name)),
  ) as readonly ConsoleOperationDeclaration[];
}
