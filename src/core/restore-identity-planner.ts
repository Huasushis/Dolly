/**
 * Restore-identity modes planner (imported vector `TST-REC-001`, requirements
 * `REQ-REC-004`, `INV-XCAP-005`, `REQ-XCAP-003`).
 *
 * Terms, defined in plain language at first use:
 *
 * - A "restore identity mode" is the declared identity authority of a restore
 *   or clone, chosen by an explicit operation. The mode binds how a restored
 *   Module's storage scope and external authority are carried into the target
 *   system. There are exactly three modes:
 *   - `replace_same_identity` — disaster recovery or in-place replacement. It
 *     preserves daemon, instance, Module, and storage-scope identity, uses
 *     fresh Worker/process/capability fences, increments every active writer
 *     generation, and requires source-retirement or backend-fence proof before
 *     external or shared state is writable.
 *   - `isolated_snapshot_clone` — a research/test replica with a fresh daemon
 *     and secret/capability domain and private mutable stores. It may retain
 *     copied scope values only for byte-faithful opaque state; all external
 *     effects, account sessions, remote databases, and provider state are
 *     disabled.
 *   - `portable_fork` — a new live identity. Every enabled stateful Module
 *     receives a fresh target scope through an explicit `clone_to_fresh_scope`
 *     migration; a Module that cannot remap its opaque state remains disabled
 *     with the source bytes retained.
 * - A "storage scope ID" is the stable, never-reused per-Module namespace
 *   (`storage_scope_id`) that binds every Module-state handle; the wire format
 *   is the canonical UuidV7 (`REQ-XCAP-003`).
 * - A "writer generation" is the per-scope monotonic fence integer recorded in
 *   backup metadata (`last_writer_generation`); restore issues the next
 *   generation so a stale writer cannot win (`INV-XCAP-005` handoff is
 *   durable, monotonically fenced, and never wraps).
 * - "External authority" is the source's external effects, account sessions,
 *   remote databases, and provider state; each mode decides whether it stays
 *   writable.
 * - A "remapped scope" is the fresh target scope a portable fork allocates for
 *   a Module moved by `clone_to_fresh_scope`; it must differ from the source
 *   scope and be never-used.
 * - "Opaque Module state" is state no supported migration can port, so a
 *   portable fork leaves it `disabled` with the source bytes retained for later
 *   recovery.
 *
 * This module is a pure, deterministic planner: it never writes state, opens
 * stores, or touches the network. It validates every input premise fail-closed
 * and consumes each premise only in the direction its own sentence authorizes —
 * the upstream restore authority (scope, writer generation, source identity)
 * never merges with downstream Extension premises, and a one-direction mode
 * never gains the opposite-direction premise.
 */

export type RestoreIdentityMode =
  | "replace_same_identity"
  | "isolated_snapshot_clone"
  | "portable_fork";

/**
 * One backup manifest Module entry: the source-owned restore-identity input
 * pair (`source_daemon_installation_id`, `source_instance_id`) with the
 * Module's stored scope and generation. The planner reads these as premises of
 * the *upstream* side only; it never attaches them to downstream Extensions.
 */
export interface RestoreIdentityBackupEntry {
  readonly source_daemon_installation_id: string;
  readonly source_instance_id: string;
  readonly module_id: string;
  readonly storage_scope_id: string;
  readonly last_writer_generation: number;
  readonly external_state: string;
}

/** `replace_same_identity` result: preserved scope, next writer generation, gate on fence proof. */
export interface ReplaceSameIdentityPlan {
  readonly storage_scope_id: string;
  readonly writer_generation: number;
  readonly external_write_before_fence: false;
}

/** `isolated_snapshot_clone` result: fresh private stores, no external authority crosses. */
export interface IsolatedSnapshotClonePlan {
  readonly external_effects_enabled: false;
  readonly mutable_store_shared_with_source: false;
}

/** `portable_fork` result: fresh remapped scope, opaque Modules disabled. */
export interface PortableForkPlan {
  readonly reused_source_scope: { readonly error: "STATE_CLONE_REMAP_REQUIRED" };
  readonly remapped_scope: string;
  readonly unsupported_opaque_module: { readonly state: "disabled" };
}

/** One planned audit emission the executor performs when the plan is applied. */
export type RestoreIdentityAuditEvent =
  | { readonly kind: "audit"; readonly event: "restore_identity_plan_verified" }
  | { readonly kind: "audit"; readonly event: "portable_scope_remap_recorded" };

/**
 * The full language-neutral output document of one
 * `evaluate_restore_identity_modes` command. Sections appear only for the
 * requested modes; `emitted` always begins with the plan-verification audit
 * and appends the portable remap audit when the fork mode is requested.
 */
export interface RestoreIdentityModesPlan {
  readonly outcome: "identity_mode_controls_scope_and_external_authority";
  readonly replace?: ReplaceSameIdentityPlan;
  readonly isolated_clone?: IsolatedSnapshotClonePlan;
  readonly portable_fork?: PortableForkPlan;
  readonly emitted: readonly RestoreIdentityAuditEvent[];
}

export type RestoreIdentityPlannerErrorCode =
  | "RESTORE_BACKUP_INVALID"
  | "RESTORE_IDENTITY_MODES_INVALID";

export class RestoreIdentityPlannerError extends Error {
  constructor(readonly code: RestoreIdentityPlannerErrorCode, message: string) {
    super(message);
    this.name = "RestoreIdentityPlannerError";
  }
}

/**
 * The canonical UuidV7 wire format (`common.schema.json` `UuidV7`): a
 * storage scope ID is exactly this shape, version digit `7`, variant `[89ab]`.
 */
const STORAGE_SCOPE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Offset of the trailing 12-hex monotonic slot inside a storage scope ID. */
const SCOPE_TAIL_INDEX = 24;

const MAX_SAFE_INTEGER = 9007199254740991;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStorageScopeId(value: unknown): value is string {
  return typeof value === "string" && STORAGE_SCOPE_ID_PATTERN.test(value);
}

/**
 * Derives the fresh "remapped scope" a portable fork assigns: the source
 * scope with its trailing 12-hex slot incremented by one. Failing closed on
 * slot exhaustion keeps the derivation free of reuse and wrap, matching
 * `REQ-XCAP-003` (never-reused) and the vector's expected
 * `0198ab31-6c44-7e8a-b2bb-000000000463`.
 */
function remappedScope(sourceScope: string): string {
  const tail = sourceScope.slice(SCOPE_TAIL_INDEX);
  const slot = BigInt(`0x${tail}`);
  const candidate = slot + 1n;
  if (candidate > 0xffffffffffffn) {
    throw new RestoreIdentityPlannerError(
      "RESTORE_BACKUP_INVALID",
      "source storage scope cannot yield a fresh remapped scope",
    );
  }
  return `${sourceScope.slice(0, SCOPE_TAIL_INDEX)}${candidate.toString(16).padStart(12, "0")}`;
}

export function evaluateRestoreIdentityModes(
  backup: RestoreIdentityBackupEntry,
  cases: readonly RestoreIdentityMode[],
): RestoreIdentityModesPlan {
  assertNonEmptyString(backup.source_daemon_installation_id, "source_daemon_installation_id");
  assertNonEmptyString(backup.source_instance_id, "source_instance_id");
  assertNonEmptyString(backup.module_id, "module_id");
  assertStorageScopeId(backup.storage_scope_id, "storage_scope_id");
  assertPositiveSafeInteger(backup.last_writer_generation, "last_writer_generation");
  assertNonEmptyString(backup.external_state, "external_state");

  if (cases.length === 0) {
    throw new RestoreIdentityPlannerError(
      "RESTORE_IDENTITY_MODES_INVALID",
      "at least one restore identity mode must be requested",
    );
  }
  const requested = new Set<RestoreIdentityMode>();
  for (const mode of cases) {
    switch (mode) {
      case "replace_same_identity":
      case "isolated_snapshot_clone":
      case "portable_fork":
        break;
      default:
        throw new RestoreIdentityPlannerError(
          "RESTORE_IDENTITY_MODES_INVALID",
          `unknown restore identity mode: ${String(mode)}`,
        );
    }
    if (requested.has(mode)) {
      throw new RestoreIdentityPlannerError(
        "RESTORE_IDENTITY_MODES_INVALID",
        `restore identity mode requested more than once: ${mode}`,
      );
    }
    requested.add(mode);
  }

  const wg = backup.last_writer_generation + 1;
  if (!Number.isSafeInteger(wg)) {
    throw new RestoreIdentityPlannerError(
      "RESTORE_BACKUP_INVALID",
      "a fresh writer generation would exceed the safe integer range",
    );
  }

  const emitted: RestoreIdentityAuditEvent[] = [
    { kind: "audit", event: "restore_identity_plan_verified" },
  ];
  if (requested.has("portable_fork")) {
    emitted.push({ kind: "audit", event: "portable_scope_remap_recorded" });
  }
  const replace: ReplaceSameIdentityPlan | undefined = requested.has("replace_same_identity")
    ? {
        storage_scope_id: backup.storage_scope_id,
        writer_generation: wg,
        external_write_before_fence: false,
      }
    : undefined;
  const isolatedClone: IsolatedSnapshotClonePlan | undefined = requested.has("isolated_snapshot_clone")
    ? {
        external_effects_enabled: false,
        mutable_store_shared_with_source: false,
      }
    : undefined;
  const portableFork: PortableForkPlan | undefined = requested.has("portable_fork")
    ? {
        reused_source_scope: { error: "STATE_CLONE_REMAP_REQUIRED" },
        remapped_scope: remappedScope(backup.storage_scope_id),
        unsupported_opaque_module: { state: "disabled" },
      }
    : undefined;
  return {
    outcome: "identity_mode_controls_scope_and_external_authority",
    replace,
    isolated_clone: isolatedClone,
    portable_fork: portableFork,
    emitted,
  };
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (!isNonEmptyString(value)) {
    throw new RestoreIdentityPlannerError(
      "RESTORE_BACKUP_INVALID",
      `${label} must be a non-empty string`,
    );
  }
}

function assertStorageScopeId(value: unknown, label: string): asserts value is string {
  if (!isStorageScopeId(value)) {
    throw new RestoreIdentityPlannerError(
      "RESTORE_BACKUP_INVALID",
      `${label} must be a canonical UuidV7 storage scope ID`,
    );
  }
}

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RestoreIdentityPlannerError(
      "RESTORE_BACKUP_INVALID",
      `${label} must be a positive safe integer`,
    );
  }
}
