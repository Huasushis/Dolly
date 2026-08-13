# Extension RPC v1 Method Contract Catalog

Status: normative for Dolly Extension RPC v1.

[`extension-rpc-v1.registry.json`](../../../protocol/extension-rpc-v1.registry.json)
is the machine-readable registry authority. This catalog is its human-readable
mirror for the request and notification methods named by
[Extension Wire Protocol](01-wire-protocol.md); any mismatch is a specification
build failure. A v1 implementation MUST
validate the selected `params` or successful `result` against the exact schema
resource below before exposing it to method code. Existing dedicated schemas
remain authoritative; the consolidated schemas only define methods that did
not previously have a machine-readable contract.

## 1. Registry rules

Every request has one caller, one callee, one params schema, and one success
result schema. The params and result roots are closed unless the referenced
schema explicitly declares an extension point. Failure uses a JSON-RPC error
whose `data` validates against
[`error.schema.json`](../../../schemas/error.schema.json); a failed request
never returns a success-result-shaped object with an ad hoc error member.

Unless a dedicated schema defines a stricter identity, a newly specified
state-changing request uses `operation_id` as its durable idempotency identity.
The callee computes and persists the semantic operation digest over the method
name and canonical semantic parameters, excluding `operation_id` and
`deadline`. Reuse of an identity with the same digest returns the recorded
state or result. Reuse with a different digest is `revision_conflict` and MUST
NOT mutate the first operation. A later deadline MAY allow continued polling;
it never creates a new semantic operation.

The status read has its own `operation_id` and names the original identity as
`target_operation_id`. `absent` is authoritative proof that no durable commit
record exists in that callee's scoped ledger and permits byte-identical replay
under the original identity. `unknown` means the commit or external-effect
outcome cannot be proved; it MUST NOT be converted to `absent`, failed, or a
new operation identity. A caller MAY replay an `unknown` operation only when
the target method contract independently proves the effect idempotent.

All request deadlines use the Core timestamp format. `module.activate` uses
the immutable `manifest.deadline`; it deliberately has no second envelope
deadline. Notifications have no response, commit acknowledgement, or implicit
retry guarantee.

## 2. Host-to-Extension requests

| Method | Params schema | Success result schema | Identity, commit, and reconciliation |
| --- | --- | --- | --- |
| `extension.initialize` | [`extension-initialize-request`](../../../schemas/extension-initialize-request.schema.json) | [`extension-initialize-result`](../../../schemas/extension-initialize-result.schema.json) | `(worker_epoch, extension_generation)` plus exact Extension config revision/value/schema digests; one initialization attempt; Host process-generation state resolves loss |
| `extension.ping` | [`ExtensionPingParams`](../../../schemas/extension-lifecycle-rpc.schema.json#/$defs/ExtensionPingParams) | [`ExtensionPingResult`](../../../schemas/extension-lifecycle-rpc.schema.json#/$defs/ExtensionPingResult) | ephemeral `operation_id`; read-only liveness probe; safe to retry |
| `extension.shutdown` | [`ExtensionShutdownParams`](../../../schemas/extension-lifecycle-rpc.schema.json#/$defs/ExtensionShutdownParams) | [`ExtensionShutdownResult`](../../../schemas/extension-lifecycle-rpc.schema.json#/$defs/ExtensionShutdownResult) | idempotent `operation_id`; process state and observed exit are authoritative after lost response |
| `module.instantiate` | [`ModuleInstantiateParams`](../../../schemas/extension-lifecycle-rpc.schema.json#/$defs/ModuleInstantiateParams) | [`ModuleInstantiateResult`](../../../schemas/extension-lifecycle-rpc.schema.json#/$defs/ModuleInstantiateResult) | durable `operation_id` plus exact effective config revision/value/schema digests; first Ready transition is commit; reconcile with `module.operation_status` |
| `module.activate` | [`activation-request`](../../../schemas/activation-request.schema.json) | [`activation-result`](../../../schemas/activation-result.schema.json) | immutable `activation_id` plus attempt/lease fence; result staging is commit; reconcile with `host.activation.status` |
| `module.prepare_config` | [`ModulePrepareConfigParams`](../../../schemas/extension-lifecycle-rpc.schema.json#/$defs/ModulePrepareConfigParams) | [`ModulePrepareConfigResult`](../../../schemas/extension-lifecycle-rpc.schema.json#/$defs/ModulePrepareConfigResult) | configuration transaction `operation_id` plus target effective config value/schema digests; durable prepared record, no active effect; `module.operation_status` |
| `module.commit_config` | [`ModuleCommitConfigParams`](../../../schemas/extension-lifecycle-rpc.schema.json#/$defs/ModuleCommitConfigParams) | [`ModuleCommitConfigResult`](../../../schemas/extension-lifecycle-rpc.schema.json#/$defs/ModuleCommitConfigResult) | same configuration transaction identity and prepare token; active revision change is commit; `module.operation_status` |
| `module.abort_config` | [`ModuleAbortConfigParams`](../../../schemas/extension-lifecycle-rpc.schema.json#/$defs/ModuleAbortConfigParams) | [`ModuleAbortConfigResult`](../../../schemas/extension-lifecycle-rpc.schema.json#/$defs/ModuleAbortConfigResult) | same configuration transaction identity and prepare token; abort cannot overwrite committed; `module.operation_status` |
| `module.snapshot` | [`ModuleSnapshotParams`](../../../schemas/extension-lifecycle-rpc.schema.json#/$defs/ModuleSnapshotParams) | [`ModuleSnapshotResult`](../../../schemas/extension-lifecycle-rpc.schema.json#/$defs/ModuleSnapshotResult) | durable `operation_id`; verified immutable envelope plus bytes is commit; `module.operation_status` |
| `module.restore` | [`ModuleRestoreParams`](../../../schemas/extension-lifecycle-rpc.schema.json#/$defs/ModuleRestoreParams) | [`ModuleRestoreResult`](../../../schemas/extension-lifecycle-rpc.schema.json#/$defs/ModuleRestoreResult) | durable `operation_id`; verified state digest installation is commit; `module.operation_status` |
| `module.migrate_state` | [`ModuleMigrateStateParams`](../../../schemas/extension-lifecycle-rpc.schema.json#/$defs/ModuleMigrateStateParams) | [`ModuleMigrateStateResult`](../../../schemas/extension-lifecycle-rpc.schema.json#/$defs/ModuleMigrateStateResult) | migration `operation_id`; immutable staged target snapshot is commit; `module.operation_status`; active source is never mutated |
| `module.operation_status` | [`ModuleOperationStatusParams`](../../../schemas/extension-lifecycle-rpc.schema.json#/$defs/ModuleOperationStatusParams) | [`ModuleOperationStatusResult`](../../../schemas/extension-lifecycle-rpc.schema.json#/$defs/ModuleOperationStatusResult) | read identity plus exact target method/`target_operation_id`; never starts or advances the target operation |
| `module.health` | [`ModuleHealthParams`](../../../schemas/extension-lifecycle-rpc.schema.json#/$defs/ModuleHealthParams) | [`ModuleHealthResult`](../../../schemas/extension-lifecycle-rpc.schema.json#/$defs/ModuleHealthResult) | ephemeral `operation_id`; read-only bounded probe; `unknown` is a health observation, not an operation outcome |
| `module.shutdown` | [`ModuleShutdownParams`](../../../schemas/extension-lifecycle-rpc.schema.json#/$defs/ModuleShutdownParams) | [`ModuleShutdownResult`](../../../schemas/extension-lifecycle-rpc.schema.json#/$defs/ModuleShutdownResult) | durable `operation_id`; Stopped transition is commit; `module.operation_status` |

## 3. Extension-to-Host requests

| Method | Params schema | Success result schema | Identity, commit, and reconciliation |
| --- | --- | --- | --- |
| `host.block.get` | [`BlockGetParams`](../../../schemas/host-resource-rpc.schema.json#/$defs/BlockGetParams) | [`block`](../../../schemas/block.schema.json) | read `operation_id`; immutable read, safe to retry; no durable status row required |
| `host.block.pin` | [`BlockPinParams`](../../../schemas/host-resource-rpc.schema.json#/$defs/BlockPinParams) | [`BlockPinResult`](../../../schemas/host-resource-rpc.schema.json#/$defs/BlockPinResult) | durable `operation_id`; pin row is commit; reconcile with `host.operation.status` |
| `host.block.unpin` | [`BlockUnpinParams`](../../../schemas/host-resource-rpc.schema.json#/$defs/BlockUnpinParams) | [`BlockUnpinResult`](../../../schemas/host-resource-rpc.schema.json#/$defs/BlockUnpinResult) | durable `operation_id`; release row is commit; reconcile with `host.operation.status` |
| `host.asset.import` | [`asset-import`](../../../schemas/asset-import.schema.json) | [`ImportResult`](../../../schemas/asset-status.schema.json#/$defs/ImportResult) | durable `import_id`; accepted record precedes acquisition; reconcile with `host.asset.status`; import success cannot be `absent` |
| `host.asset.status` | [`asset-status-request`](../../../schemas/asset-status-request.schema.json) | [`StatusResult`](../../../schemas/asset-status.schema.json#/$defs/StatusResult) | read `operation_id` plus original `import_id`; never advances import |
| `host.asset.get` | [`AssetGetParams`](../../../schemas/host-resource-rpc.schema.json#/$defs/AssetGetParams) | [`AssetGetResult`](../../../schemas/host-resource-rpc.schema.json#/$defs/AssetGetResult) | read `operation_id`; immutable bounded read/stream grant; safe to retry |
| `host.asset.materialize_view` | [`AssetMaterializeViewParams`](../../../schemas/host-resource-rpc.schema.json#/$defs/AssetMaterializeViewParams) | [`AssetMaterializeViewResult`](../../../schemas/host-resource-rpc.schema.json#/$defs/AssetMaterializeViewResult) | durable `operation_id`; immutable derived-Asset publication is commit; `host.operation.status` |
| `host.model.invoke` | [`model-request`](../../../schemas/model-request.schema.json) | [`model-response`](../../../schemas/model-response.schema.json) | durable `request_id`; Provider dispatch may be billable; output media is bound by `(request_id, ordinal)` and remains `running` until every Asset import is `available`; reconcile with `host.operation.status`; unreconciled Provider outcome is `unknown` |
| `host.tool.invoke` | [`tool-invoke`](../../../schemas/tool-invoke.schema.json) | [`InvokeResult`](../../../schemas/tool-result.schema.json#/$defs/InvokeResult) | Module-scoped identity compares an always-computable request digest; accepted resolution starts the durable row at `AUTHORIZED`; denied/conflict responses create no new row; dispatch is the external-effect boundary; reconcile with `host.tool.status` |
| `host.tool.status` | [`tool-status-request`](../../../schemas/tool-status-request.schema.json) | [`StatusResult`](../../../schemas/tool-result.schema.json#/$defs/StatusResult) | fresh read `operation_id` plus original `target_operation_id`; lookup is only `(authenticated module,target)` and is non-disclosing across Modules; result `operation_id` equals the target, not the read; never invokes tool |
| `host.ingress.submit` | [`ingress-submit`](../../../schemas/ingress-submit.schema.json) | [`ingress-result`](../../../schemas/ingress-result.schema.json) | scoped durable idempotency key; Core ingress transaction is commit; `host.ingress.status` |
| `host.ingress.status` | [`ingress-status-request`](../../../schemas/ingress-status-request.schema.json) | [`ingress-status`](../../../schemas/ingress-status.schema.json) | read `operation_id` plus original scoped key; never submits ingress |
| `host.activation.status` | [`activation-status-request`](../../../schemas/activation-status-request.schema.json) | [`activation-status`](../../../schemas/activation-status.schema.json) | read `operation_id` plus `activation_id`; authoritative Core state; never dispatches or commits Activation work |
| `host.module.request_activation` | [`RequestActivationParams`](../../../schemas/host-control-rpc.schema.json#/$defs/RequestActivationParams) | [`RequestActivationResult`](../../../schemas/host-control-rpc.schema.json#/$defs/RequestActivationResult) | durable `operation_id`; scheduling/coalescing record is commit; `host.operation.status` |
| `host.module.request_wakeup` | [`RequestWakeupParams`](../../../schemas/host-control-rpc.schema.json#/$defs/RequestWakeupParams) | [`RequestWakeupResult`](../../../schemas/host-control-rpc.schema.json#/$defs/RequestWakeupResult) | durable `operation_id` and scoped idempotency key; wakeup row is commit; `host.operation.status` |
| `host.config.propose` | [`config-proposal`](../../../schemas/config-proposal.schema.json) | [`ConfigProposeResult`](../../../schemas/host-control-rpc.schema.json#/$defs/ConfigProposeResult) | durable `operation_id`; proposal row is commit, never active configuration; `host.operation.status` |
| `host.operation.status` | [`OperationStatusParams`](../../../schemas/host-operation-status.schema.json#/$defs/OperationStatusParams) | [`OperationStatusResult`](../../../schemas/host-operation-status.schema.json#/$defs/OperationStatusResult) | read `operation_id` plus target method/identity; never starts, retries, cancels, or advances target work |

Dedicated status methods remain authoritative for Asset imports, tools,
ingress, and Core Activations. `host.operation.status` MUST reject those target
methods rather than presenting a second ledger with potentially different
state.

## 4. Notifications

| Notification | Direction | Params schema | Durability and loss semantics |
| --- | --- | --- | --- |
| `$/cancelRequest` | either direction | [`CancelRequestParams`](../../../schemas/extension-notification-rpc.schema.json#/$defs/CancelRequestParams) | best effort; targets only a request sent by the receiver; original terminal response is authoritative |
| `module.activation_disposition` | Host → Extension | [`activation-status`](../../../schemas/activation-status.schema.json) | advisory projection; loss reconciles through `host.activation.status` |
| `descriptor.changed` | Extension → Host | [`DescriptorChangedParams`](../../../schemas/extension-notification-rpc.schema.json#/$defs/DescriptorChangedParams) | untrusted complete candidate; outer identity and digest plus full Descriptor verification determine accepted revision |
| `extension.progress` | Extension → Host | [`ExtensionProgressParams`](../../../schemas/extension-notification-rpc.schema.json#/$defs/ExtensionProgressParams) | bounded, non-durable, and never changes operation state |
| `host.log.emit` | Extension → Host | [`LogEmitParams`](../../../schemas/extension-notification-rpc.schema.json#/$defs/LogEmitParams) | untrusted telemetry; loss is permitted; no payload authority |
| `host.metrics.record` | Extension → Host | [`MetricsRecordParams`](../../../schemas/extension-notification-rpc.schema.json#/$defs/MetricsRecordParams) | untrusted bounded samples; loss is permitted; no semantic commit |

## 5. State and outcome invariants

- **REQ-XRPC-003 — Closed method registry.** Every Extension RPC v1 request and
  notification has exactly one direction and one machine-readable params
  contract; every request also has exactly one machine-readable success-result
  contract.
- **INV-XRPC-004 — Durable reconciliation.** Every state-changing or externally
  billable Host method has a stable operation identity and exactly one
  authoritative dedicated or generic status path. Transport loss cannot turn
  `unknown` into `absent` or authorize a fresh semantic identity.
- **INV-XRPC-005 — Notification non-authority.** No notification is a durable
  commit acknowledgement or a substitute for its documented status query.
