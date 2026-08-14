import type { JsonValue } from "../../schema-bundle/index.js";

export type JsonObject = { [key: string]: JsonValue };
export type TransitionOutcome = "committed" | "rolled_back" | "rolled_back_with_safety_stop";
export type InstanceMode = "running" | "recovery_required";
export type ActivationState = "ready" | "leased" | "dispatched" | "fencing" | "result_staged" | "committed" | "retry_wait" | "quarantined" | "cancelled";

export interface SubscriptionRecord {
  cursor: number;
  paused?: boolean;
}

export interface PageRecord {
  page_seq: number;
  entries: JsonValue[];
  lossy?: boolean;
}

/** Durable application payload retained when an authoritative result is staged. */
export interface StagedResult {
  expected_cursors: Record<string, number>;
  outputs: JsonObject[];
  admitted_pages: Record<string, PageRecord[]>;
  projected_admission_entries: number;
  page_limit?: number;
  validation?: JsonObject;
}

export interface ActivationRecord {
  state: ActivationState;
  attempt: number;
  owner?: string;
  result_digest?: string;
  authoritative_disposition?: ActivationState;
  staged_result?: StagedResult;
  manifest?: JsonObject;
  next_attempt_authorization?: JsonObject;
  replay_evidence?: JsonObject;
  retry_delay?: number;
  extension_generation?: number;
  validation?: JsonObject;
}

export interface CoreSnapshot {
  projection_kind: "dolly.state-projection/v1";
  mode: InstanceMode;
  next_commit_seq: number;
  next_page_seq: number;
  storage_writer_owner: string | null;
  config: JsonObject;
  graph: JsonObject;
  ingress: Record<string, { operation_digest: string; block_id: string; pages: string[] }>;
  runtime_events: Record<string, { operation_digest: string; block_id: string }>;
  blocks: Record<string, JsonObject>;
  deliveries: JsonObject[];
  pages: Record<string, PageRecord[]>;
  subscriptions: Record<string, SubscriptionRecord>;
  manifests: Record<string, JsonObject>;
  activations: Record<string, ActivationRecord>;
  leases: Record<string, JsonObject>;
  quarantines: Record<string, JsonObject>;
  generations: JsonObject[];
  current_generation: number | null;
  outputs: JsonObject[];
  lossy_gaps: JsonObject[];
  volatile_lossy_entries: JsonObject[];
  journal: CoreEvent[];
  security_incidents: JsonObject[];
}

interface CommandBase { command_id: string }
export type CoreCommand =
  | (CommandBase & { type: "InstallConfig"; revision: number; effective_config: JsonObject; digest: string })
  | (CommandBase & { type: "InstallGraph"; revision: number; graph: JsonObject; digest: string })
  | (CommandBase & { type: "Ingress"; runtime_source: string; ingress_key: string; operation_digest: string; block_id: string; block: JsonObject; pages: string[] })
  | (CommandBase & { type: "RuntimeEvent"; runtime_source: string; event_key: string; operation_digest: string; block_id: string; block: JsonObject; pages: string[] })
  | (CommandBase & { type: "GrantStorageWriter"; owner: string })
  | (CommandBase & { type: "ReleaseStorageWriter"; owner: string })
  | (CommandBase & { type: "BuildManifest"; activation_id: string; manifest: JsonObject; expected_graph_revision?: number; expected_descriptor_revision?: number })
  | (CommandBase & { type: "IssueLease"; activation_id: string; lease_id: string; token_digest: string; extension_connection_id: string; worker_epoch: number; extension_generation?: number })
  | (CommandBase & { type: "DispatchLease"; activation_id: string; lease_id: string; dispatch_state: "prepared" | "started" | "transport_started" })
  | (CommandBase & { type: "ReceiveResult"; activation_id: string; lease_id: string; result_digest: string; status: "success" | "retryable" | "permanent"; result?: JsonObject })
  | (CommandBase & { type: "BeginFence"; activation_id: string })
  | (CommandBase & { type: "RecordReplayEvidence"; activation_id: string })
  | (CommandBase & { type: "FenceComplete"; activation_id: string; retry_delay: number })
  | (CommandBase & { type: "ApplyResult"; activation_id: string })
  | (CommandBase & { type: "CancelActivation"; activation_id: string; reason: string })
  | (CommandBase & { type: "ResolveQuarantine"; activation_id: string; resolution: "retry" | "cancel"; retry_delay?: number })
  | (CommandBase & { type: "CompleteQuarantineFence"; activation_id: string })
  | (CommandBase & { type: "DeadLetterRange"; subscription_id: string; start: number; end_exclusive: number; reason: string })
  | (CommandBase & { type: "SkipRange"; subscription_id: string; start: number; end_exclusive: number })
  | (CommandBase & { type: "LossyEvict"; page_id: string; start: number; end_exclusive: number; reason: string })
  | (CommandBase & { type: "Recover"; persisted_next_page_seq: number });

export interface ReducerInput {
  now: string;
  identifier?: string;
  retry_jitter?: number;
  crash_point?: string;
  storage_observation?: "before_commit" | "after_commit";
  graph_revision?: number;
  descriptor_revision?: number;
  host_result_verification?: {
    verified: boolean;
    activation_id: string;
    lease_id: string;
    token_digest: string;
    attempt: number;
    extension_connection_id: string;
    worker_epoch: number;
    extension_generation?: number;
    manifest_digest?: string;
    result_digest: string;
    payload_valid: boolean;
  };
  host_replay_evidence?: {
    verified: boolean;
    activation_id: string;
    source_attempt: number;
    target_generation?: number;
    observation: "not_started" | "succeeded" | "failed" | "unknown";
    record: JsonObject;
    digest: string;
  };
  host_fence_verification?: {
    verified: boolean;
    activation_id: string;
    source_attempt: number;
    execution_slot_empty: boolean;
    proof_digest: string;
  };
  recovery_verification?: {
    ordered_checks_complete: boolean;
    invariants_valid: boolean;
    persisted_values_valid: boolean;
    process_fences_valid: boolean;
    staged_results_valid: boolean;
    failure_reason?: string;
  };
}

export interface CoreEvent {
  event: string;
  commit_seq: number;
  command_id: string;
  details?: JsonObject;
}

export interface CoreError {
  code: string;
  retryable: boolean;
  outcome: "not_applied" | "applied" | "unknown";
  details?: JsonObject;
}

export interface Transition {
  outcome: TransitionOutcome;
  state: CoreSnapshot;
  events: CoreEvent[];
  error?: CoreError;
  reply?: JsonObject;
  projection: JsonObject;
  state_hash: string;
  safety_stop?: { state: CoreSnapshot; event: CoreEvent };
}

export function emptyCoreSnapshot(): CoreSnapshot {
  return {
    projection_kind: "dolly.state-projection/v1", mode: "running", next_commit_seq: 1, next_page_seq: 1,
    storage_writer_owner: null,
    config: {}, graph: {}, ingress: {}, runtime_events: {}, blocks: {}, deliveries: [], pages: {}, subscriptions: {},
    manifests: {}, activations: {}, leases: {}, quarantines: {}, generations: [], current_generation: null, outputs: [],
    lossy_gaps: [], volatile_lossy_entries: [], journal: [], security_incidents: [],
  };
}
