import { writeFileSync } from "node:fs";
import { canonicalJsonDigest, canonicalizeJson, type JsonValue } from "../src/schema-bundle/index.js";
import {
  emptyCoreSnapshot,
  hashCoreState,
  projectCoreState,
  reduceCore,
  type CoreCommand,
  type CoreSnapshot,
  type JsonObject,
  type ReducerInput,
} from "../src/core/reference-machine/index.js";

const NOW = "2026-08-13T00:00:00.000000Z";
const MANIFEST_DIGEST = `sha256:${"a".repeat(64)}`;
const TOKEN_DIGEST = `sha256:${"b".repeat(64)}`;

let state = emptyCoreSnapshot();
state.subscriptions.worker = { cursor: 1 };
const records: JsonObject[] = [{
  label: "seed",
  outcome: "seeded",
  state_hash: hashCoreState(state),
  projection: projectCoreState(state),
  events: [],
}];

function run(label: string, command: CoreCommand, input: Partial<ReducerInput> = {}): void {
  const transition = reduceCore(state, command, { now: NOW, graph_revision: 1, descriptor_revision: 1, ...input });
  state = transition.state;
  records.push({
    label,
    outcome: transition.outcome,
    state_hash: transition.state_hash,
    projection: transition.projection,
    events: transition.events as unknown as JsonValue,
    ...(transition.reply ? { reply: transition.reply } : {}),
    ...(transition.error ? { error: transition.error as unknown as JsonValue } : {}),
  });
}

const config = { streaming: "strict", endpoint: "local" };
run("install_config", {
  type: "InstallConfig",
  command_id: "config-1",
  revision: 1,
  effective_config: config,
  digest: canonicalJsonDigest(config),
});

const graph = { modules: ["worker"], edges: [] };
run("install_graph", {
  type: "InstallGraph",
  command_id: "graph-1",
  revision: 1,
  graph,
  digest: canonicalJsonDigest(graph),
});

run("ingress", {
  type: "Ingress",
  command_id: "ingress-1",
  runtime_source: "host",
  ingress_key: "message-1",
  operation_digest: `sha256:${"c".repeat(64)}`,
  block_id: "input-1",
  block: { kind: "text", text: "hello" },
  pages: ["worker", "audit", "worker"],
});

run("ingress_replay", {
  type: "Ingress",
  command_id: "ingress-replay",
  runtime_source: "host",
  ingress_key: "message-1",
  operation_digest: `sha256:${"c".repeat(64)}`,
  block_id: "ignored-on-replay",
  block: { kind: "text", text: "ignored" },
  pages: ["ignored"],
});

const manifest = {
  manifest_digest: MANIFEST_DIGEST,
  reason: "input",
  frozen_replay_contract: { mode: "never_auto_retry", evidence: "none", ledger: null },
};
run("build_manifest", {
  type: "BuildManifest",
  command_id: "manifest-1",
  activation_id: "activation-1",
  manifest,
  expected_graph_revision: 1,
  expected_descriptor_revision: 1,
});

run("issue_lease", {
  type: "IssueLease",
  command_id: "lease-1",
  activation_id: "activation-1",
  lease_id: "lease-1",
  token_digest: TOKEN_DIGEST,
  extension_connection_id: "connection-1",
  worker_epoch: 1,
});

run("dispatch_lease", {
  type: "DispatchLease",
  command_id: "dispatch-1",
  activation_id: "activation-1",
  lease_id: "lease-1",
  dispatch_state: "started",
});

const result: JsonObject = {
  expected_cursors: { worker: 1 },
  outputs: [{
    block_id: "output-1",
    block: { kind: "text", text: "done" },
    deliveries: [{ block_id: "output-1", page_id: "out" }],
  }],
  admitted_pages: { out: [{ page_seq: 1, entries: [{ block_id: "output-1" }] }] },
  projected_admission_entries: 1,
  page_limit: 4,
};
const resultDigest = canonicalJsonDigest(result);
run("receive_result", {
  type: "ReceiveResult",
  command_id: "result-1",
  activation_id: "activation-1",
  lease_id: "lease-1",
  result_digest: resultDigest,
  status: "success",
  result,
}, {
  host_result_verification: {
    verified: true,
    activation_id: "activation-1",
    lease_id: "lease-1",
    token_digest: TOKEN_DIGEST,
    attempt: 1,
    extension_connection_id: "connection-1",
    worker_epoch: 1,
    manifest_digest: MANIFEST_DIGEST,
    result_digest: resultDigest,
    payload_valid: true,
  },
});

run("apply_result", {
  type: "ApplyResult",
  command_id: "apply-1",
  activation_id: "activation-1",
});

const document = canonicalizeJson(records);
const outputPath = process.argv[2];
if (outputPath) writeFileSync(outputPath, `${document}\n`, { mode: 0o600 });
else process.stdout.write(`${document}\n`);
