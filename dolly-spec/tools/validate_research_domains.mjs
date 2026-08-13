#!/usr/bin/env node
/**
 * Executable semantic validators and conformance cases for the isolated
 * Testament and LevelUpper research domains.
 *
 * JSON Schema intentionally checks only shape.  The validators below enforce
 * cross-record identity, reference, digest, authorization, and isolation
 * invariants which JSON Schema cannot express.  They return an array of
 * deterministic diagnostic strings and never mutate their input.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const schemaRoot = path.join(root, "schemas");
const schemaBase = "https://dolly.example/spec/0.1/schemas/";

const schemaIds = Object.freeze({
  filterDecision: `${schemaBase}filter-decision.schema.json`,
  filterSignal: `${schemaBase}filter-signal.schema.json`,
  block: `${schemaBase}block.schema.json`,
  testamentCorpus: `${schemaBase}testament-corpus-manifest.schema.json`,
  testamentPlan: `${schemaBase}testament-replay-plan.schema.json`,
  levelShare: `${schemaBase}levelupper-share.schema.json`,
  levelContent: `${schemaBase}levelupper-portable-block.schema.json`,
  levelEntry: `${schemaBase}levelupper-entry-envelope.schema.json`,
  levelWire: `${schemaBase}levelupper-wire-control.schema.json`,
});

const ajv = new Ajv2020({allErrors: true, strict: false, allowUnionTypes: true});
addFormats(ajv);
for (const name of fs.readdirSync(schemaRoot).filter((entry) => entry.endsWith(".json")).sort()) {
  const schema = JSON.parse(fs.readFileSync(path.join(schemaRoot, name), "utf8"));
  ajv.addSchema(schema);
}

function clone(value) {
  return structuredClone(value);
}

/** RFC 8785-compatible for the schema-constrained JSON values used here. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Bytes(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function digestBytes(digest) {
  if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) return null;
  return Buffer.from(digest.slice("sha256:".length), "hex");
}

function uint32be(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}

function uint64be(value) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(value));
  return out;
}

/** DS(label, value) from the Testament and LevelUpper specifications. */
export function domainSeparatedDigest(label, value) {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  return sha256Bytes(Buffer.concat([
    Buffer.from(label, "utf8"),
    Buffer.from([0]),
    uint32be(bytes.length),
    bytes,
  ]));
}

function without(value, ...keys) {
  const copy = clone(value);
  for (const key of keys) delete copy[key];
  return copy;
}

function schemaErrors(schemaId, value) {
  const validate = ajv.getSchema(schemaId);
  if (!validate) return [`schema is unavailable: ${schemaId}`];
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error) =>
    `schema${error.instancePath || "/"} ${error.message}`);
}

function addDuplicateErrors(values, keyOf, label, errors) {
  const seen = new Set();
  for (const value of values) {
    const key = keyOf(value);
    if (seen.has(key)) errors.push(`duplicate ${label}: ${key}`);
    seen.add(key);
  }
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sortedUtf8(values) {
  return [...values].sort(utf8Compare);
}

function rowCompare(left, right) {
  const keyOrder = utf8Compare(String(left[0]), String(right[0]));
  return keyOrder || utf8Compare(canonicalJson(left), canonicalJson(right));
}

const rasterMediaTypes = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
  "image/bmp", "image/tiff",
]);

function cropErrors(view, mediaType, label) {
  const errors = [];
  if (view === null || view === undefined) return errors;
  if (!rasterMediaTypes.has(mediaType)) errors.push(`${label} crop view requires a supported raster media type`);
  if (!(view.x0 < view.x1) || !(view.y0 < view.y1)) {
    errors.push(`${label} crop view must satisfy x0 < x1 and y0 < y1`);
  }
  return errors;
}

function mapLookup(container, key) {
  if (container instanceof Map) return container.get(key);
  if (container !== null && typeof container === "object") return container[key];
  return undefined;
}

function setHas(container, key) {
  if (container instanceof Set) return container.has(key);
  if (Array.isArray(container)) return container.includes(key);
  if (container !== null && typeof container === "object") return container[key] === true;
  return false;
}

function genericCanonicalDigest(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value), "utf8"));
}

function filterStateSourceKey(source, decision) {
  return canonicalJson([
    source.instance_id,
    source.source_module_id,
    decision.channel,
    decision.state_epoch,
  ]);
}

export function filterAccumulatorStateDigest(decision, state) {
  return domainSeparatedDigest("dolly.filter-accumulator-state.v1", {
    storage_scope_id: decision.storage_scope_id,
    channel: decision.channel,
    state_epoch: decision.state_epoch,
    state,
  });
}

function correctedFilterScore(state, biasCorrection) {
  const W = 1000000n;
  let corrected = biasCorrection
    ? roundHalfEven(BigInt(state.accumulator) * W, BigInt(state.weight))
    : BigInt(state.accumulator);
  if (corrected < 0n) corrected = 0n;
  if (corrected > 1000n * W) corrected = 1000n * W;
  return corrected;
}

function replayFilterAccumulatorState(decision, context, errors) {
  const config = context.config;
  if (config === undefined) return null;

  for (const [label, state] of [
    ["before_state", decision.before_state],
    ["after_state", decision.after_state],
  ]) {
    if (state.algorithm_revision !== decision.algorithm_revision ||
        state.internal_scale !== 1000000 ||
        state.bias_correction !== config.bias_correction) {
      errors.push(`Filter ${label} arithmetic header disagrees with the frozen decision/config`);
    }
    const keys = state.sources.map((source) => filterStateSourceKey(source, decision));
    if (new Set(keys).size !== keys.length) errors.push(`Filter ${label} source tuple is not unique`);
    if (canonicalJson(keys) !== canonicalJson([...keys].sort(utf8Compare))) {
      errors.push(`Filter ${label} sources are not sorted by the state source key`);
    }
    for (const source of state.sources) if (source.instance_id !== context.instanceId) {
      errors.push(`Filter ${label} source ${source.source_module_id} has an untrusted instance_id`);
    }
  }

  if (decision.before_state_digest !== filterAccumulatorStateDigest(decision, decision.before_state)) {
    errors.push("Filter before_state_digest does not bind the exact prior accumulator state");
  }
  if (decision.after_state_digest !== filterAccumulatorStateDigest(decision, decision.after_state)) {
    errors.push("Filter after_state_digest does not bind the exact resulting accumulator state");
  }

  const stateByKey = new Map(decision.before_state.sources.map((source) => [
    filterStateSourceKey(source, decision),
    {
      instance_id: source.instance_id,
      source_module_id: source.source_module_id,
      accumulator: BigInt(source.accumulator),
      weight: BigInt(source.weight),
      observation_count: source.observation_count,
    },
  ]));
  const latestEligible = new Map();
  const eligibleDispositions = new Set(["applied", "duplicate", "missing_hold"]);

  for (const observation of decision.observations) {
    const key = filterStateSourceKey(observation, decision);
    let source = stateByKey.get(key);
    if (observation.disposition === "applied") {
      const prior = source ?? {
        instance_id: observation.instance_id,
        source_module_id: observation.source_module_id,
        accumulator: 0n,
        weight: 0n,
        observation_count: 0,
      };
      const next = applyFilterObservation(
        {accumulator: prior.accumulator, weight: prior.weight},
        observation.applied_score,
        config.new_sample_weight_ppm,
        config.bias_correction,
      );
      source = {
        instance_id: prior.instance_id,
        source_module_id: prior.source_module_id,
        accumulator: next.accumulator,
        weight: next.weight,
        observation_count: prior.observation_count + 1,
      };
      stateByKey.set(key, source);
    } else if (observation.disposition === "missing_hold" && source === undefined) {
      errors.push(`Filter observation ${observation.source_block_id} claims missing_hold for a never-seen source`);
    } else if (observation.disposition === "never_seen" && source !== undefined) {
      errors.push(`Filter observation ${observation.source_block_id} claims never_seen for tracked state`);
    } else if (observation.disposition === "duplicate" && source === undefined) {
      errors.push(`Filter observation ${observation.source_block_id} claims duplicate without tracked state`);
    }

    if (observation.projection_eligible) {
      if (!eligibleDispositions.has(observation.disposition) || source === undefined) {
        errors.push(`Filter observation ${observation.source_block_id} marks an ineligible disposition projectable`);
      } else {
        latestEligible.set(key, observation);
      }
    }
  }

  const derivedSources = [...stateByKey.values()]
    .map((source) => ({
      instance_id: source.instance_id,
      source_module_id: source.source_module_id,
      accumulator: Number(source.accumulator),
      weight: Number(source.weight),
      observation_count: source.observation_count,
    }))
    .sort((left, right) => utf8Compare(
      filterStateSourceKey(left, decision),
      filterStateSourceKey(right, decision),
    ));
  const derivedAfter = {
    algorithm_revision: decision.algorithm_revision,
    internal_scale: 1000000,
    bias_correction: config.bias_correction,
    sources: derivedSources,
  };
  if (canonicalJson(decision.after_state) !== canonicalJson(derivedAfter)) {
    errors.push("Filter after_state does not equal ordered observation replay from before_state");
  }

  const expectedCandidates = [...latestEligible.entries()].map(([key, observation]) => {
    const source = stateByKey.get(key);
    return {
      instance_id: source.instance_id,
      source_module_id: source.source_module_id,
      tie_break_key: canonicalJson([
        source.instance_id, source.source_module_id, decision.channel,
      ]),
      selected_input_block_id: observation.source_block_id,
      accumulator: Number(source.accumulator),
      weight: Number(source.weight),
      corrected_score_q: Number(correctedFilterScore(source, config.bias_correction)),
      distance: 0,
    };
  }).sort((left, right) => utf8Compare(left.tie_break_key, right.tie_break_key));
  const sum = expectedCandidates.reduce((total, candidate) =>
    total + BigInt(candidate.corrected_score_q), 0n);
  for (const candidate of expectedCandidates) {
    const signed = 3n * BigInt(expectedCandidates.length) * BigInt(candidate.corrected_score_q) - 2n * sum;
    candidate.distance = Number(signed < 0n ? -signed : signed);
  }
  if (canonicalJson(decision.candidates) !== canonicalJson(expectedCandidates)) {
    errors.push("Filter candidates do not equal the latest eligible Blocks and replayed accumulator state");
  }
  return {derivedAfter, expectedCandidates};
}

function validateTrustedFilterManifestBlocks(decision, context, errors) {
  if (context.trustedManifestBlocks === undefined ||
      context.trustedManifestBlockDigests === undefined) {
    errors.push("Filter projection validation requires Host-trusted Manifest Blocks and digests");
    return;
  }
  for (const observation of decision.observations) {
    const block = mapLookup(context.trustedManifestBlocks, observation.source_block_id);
    if (!block) {
      errors.push(`Filter trusted Manifest lacks Block ${observation.source_block_id}`);
      continue;
    }
    for (const error of schemaErrors(schemaIds.block, block)) {
      errors.push(`trusted Block ${observation.source_block_id}: ${error}`);
    }
    if (block.id !== observation.source_block_id || block.producer.kind !== "module" ||
        block.producer.instance_id !== observation.instance_id ||
        block.producer.module_id !== observation.source_module_id) {
      errors.push(`Filter trusted Block ${observation.source_block_id} identity/producer binding mismatch`);
    }
    if (block.body_digest !== genericCanonicalDigest(block.body)) {
      errors.push(`Filter trusted Block ${observation.source_block_id} body_digest mismatch`);
    }
    const expectedEnvelopeDigest = genericCanonicalDigest(without(block, "envelope_digest"));
    if (block.envelope_digest !== expectedEnvelopeDigest) {
      errors.push(`Filter trusted Block ${observation.source_block_id} envelope_digest mismatch`);
    }
    const manifestDigest = mapLookup(
      context.trustedManifestBlockDigests, observation.source_block_id);
    if (manifestDigest !== block.envelope_digest) {
      errors.push(`Filter trusted Block ${observation.source_block_id} does not match the frozen Manifest Block digest`);
    }
    const matchingSignals = block.body.parts.filter((part) =>
      part.kind === "json" &&
      part.schema_uri === "https://dolly.example/spec/0.1/schemas/filter-signal.schema.json" &&
      part.value?.channel === observation.channel);
    if (observation.disposition === "applied") {
      if (matchingSignals.length !== 1 ||
          schemaErrors(schemaIds.filterSignal, matchingSignals[0]?.value).length > 0 ||
          matchingSignals[0]?.value?.score !== observation.applied_score) {
        errors.push(`Filter trusted Block ${observation.source_block_id} does not derive the applied observation score`);
      }
    } else if (observation.disposition === "missing_hold" && matchingSignals.length !== 0) {
      errors.push(`Filter trusted Block ${observation.source_block_id} does not derive missing_hold`);
    }
  }
}

function reconstructFilterActivationPayload(decision, selected, context, errors) {
  if (!selected) {
    return {status: "success", output: null, scheduling_hint: null, error: null};
  }
  const block = mapLookup(context.trustedManifestBlocks, selected.selected_input_block_id);
  if (!block) return null;
  const config = context.config;
  const projectedParts = [];
  for (const [index, part] of block.body.parts.entries()) {
    if (part.kind === "text") {
      projectedParts.push(clone(part));
      continue;
    }
    if (part.kind === "json") continue;
    if (part.kind === "asset") {
      const authorization = mapLookup(context.authorizedAssets, part.asset_id);
      const view = part.view ?? null;
      if (!authorization || authorization.media_type !== part.media_type ||
          !Array.isArray(authorization.allowed_views) ||
          !authorization.allowed_views.some((allowed) =>
            canonicalJson(allowed) === canonicalJson(view))) {
        errors.push(`Filter selected Block Asset part ${index} lacks exact authorization`);
      }
      projectedParts.push(clone(part));
      continue;
    }
    if (part.kind === "block_ref" && config.copy_block_refs) {
      const allowedRelations = mapLookup(context.authorizedBlockRefs, part.block_id);
      if (!Array.isArray(allowedRelations) || !allowedRelations.includes(part.relation)) {
        errors.push(`Filter selected Block BlockRef part ${index} lacks exact authorization`);
      }
      projectedParts.push(clone(part));
    }
  }
  projectedParts.push({
    kind: "json",
    schema_uri: "https://dolly.example/spec/0.1/schemas/filter-signal.schema.json",
    value: {
      schema: "dolly.filter-signal/v1",
      channel: decision.channel,
      score: Number(roundHalfEven(BigInt(selected.corrected_score_q), 1000000n)),
    },
  });
  const draft = {
    schema: "dolly.block-draft/v1",
    parts: projectedParts,
    actions: [],
    metadata: {},
    hints: {},
  };
  if (config.copy_description) draft.description = block.body.description;
  if (draft.parts.length > config.max_output_parts) {
    errors.push("Filter reconstructed projection exceeds max_output_parts");
  }
  if (Buffer.byteLength(canonicalJson(draft), "utf8") > config.max_output_bytes) {
    errors.push("Filter reconstructed projection exceeds max_output_bytes");
  }
  return {status: "success", output: draft, scheduling_hint: null, error: null};
}

/**
 * Cross-field validator for a persisted two-thirds Filter decision.
 * Context.instanceId is the Runtime-trusted instance identity.  The exact
 * Activation output payload is embedded in the durable decision.  Its semantic
 * authority is the Host-trusted Manifest Block plus Asset/reference grants;
 * optional context.preparedOutput is only independently retained byte evidence.
 */
export function validateFilterDecision(decision, context = {}) {
  const errors = schemaErrors(schemaIds.filterDecision, decision);
  if (errors.length > 0) return errors;

  if (typeof context.instanceId !== "string" || context.instanceId.length === 0) {
    errors.push("Filter decision validation requires trusted instanceId context");
  }
  if (context.trustedStorageScopeId === undefined ||
      decision.storage_scope_id !== context.trustedStorageScopeId) {
    errors.push("Filter decision storage_scope_id does not match Host authority");
  }
  if (context.trustedManifestDigest === undefined ||
      decision.manifest_digest !== context.trustedManifestDigest) {
    errors.push("Filter decision manifest_digest does not match the frozen trusted Manifest");
  }
  if (context.committedBeforeState === undefined ||
      canonicalJson(decision.before_state) !== canonicalJson(context.committedBeforeState)) {
    errors.push("Filter before_state does not equal the Host/ledger committed prior state");
  }
  if (context.committedBeforeState !== undefined) {
    const authoritativeDigest = filterAccumulatorStateDigest(
      decision, context.committedBeforeState);
    if (context.committedBeforeStateDigest !== authoritativeDigest ||
        decision.before_state_digest !== context.committedBeforeStateDigest) {
      errors.push("Filter prior state digest does not match Host/ledger authority");
    }
  }
  if (context.trustedObservations === undefined ||
      canonicalJson(decision.observations) !== canonicalJson(context.trustedObservations)) {
    errors.push("Filter decision observations do not byte-match the trusted Manifest/Block-derived sequence");
  }
  validateTrustedFilterManifestBlocks(decision, context, errors);
  if (context.config === undefined) {
    errors.push("Filter decision validation requires the exact frozen config");
  } else {
    if (decision.config_digest !== genericCanonicalDigest(context.config)) {
      errors.push("Filter decision config_digest does not bind the exact frozen config");
    }
    if (context.configSchemaDigest === undefined ||
        decision.config_schema_digest !== context.configSchemaDigest) {
      errors.push("Filter decision config_schema_digest does not bind the installed config schema");
    }
    if (context.config.signal_channel !== decision.channel) {
      errors.push("Filter decision channel disagrees with frozen config");
    }
    if (context.config.state_epoch !== decision.state_epoch) {
      errors.push("Filter decision state_epoch disagrees with frozen config");
    }
    if (decision.before_state.sources.length > context.config.max_tracked_sources ||
        decision.after_state.sources.length > context.config.max_tracked_sources) {
      errors.push("Filter accumulator state exceeds frozen max_tracked_sources");
    }
  }
  const identities = decision.candidates.map((candidate) => canonicalJson([
    candidate.instance_id,
    candidate.source_module_id,
    decision.channel,
  ]));
  for (const candidate of decision.candidates) {
    const expectedTieBreakKey = canonicalJson([
      candidate.instance_id, candidate.source_module_id, decision.channel,
    ]);
    if (candidate.instance_id !== context.instanceId) {
      errors.push(`Filter candidate ${candidate.source_module_id} instance_id is not Runtime-trusted context`);
    }
    if (candidate.tie_break_key !== expectedTieBreakKey) {
      errors.push(`Filter candidate ${candidate.source_module_id} tie_break_key mismatch`);
    }
    if (context.config !== undefined) {
      const W = 1000000n;
      const maximum = 1000n * W;
      let expectedQ;
      if (context.config.bias_correction) {
        expectedQ = roundHalfEven(BigInt(candidate.accumulator) * W, BigInt(candidate.weight));
      } else {
        expectedQ = BigInt(candidate.accumulator);
      }
      if (expectedQ < 0n) expectedQ = 0n;
      if (expectedQ > maximum) expectedQ = maximum;
      if (BigInt(candidate.corrected_score_q) !== expectedQ) {
        errors.push(`Filter candidate ${candidate.source_module_id} corrected_score_q is inconsistent with A/Z and frozen bias mode`);
      }
    }
  }
  if (new Set(identities).size !== identities.length) {
    errors.push("Filter candidate trusted source tuple is not unique");
  }
  const observationIdentities = new Set();
  let priorOrdinal = -1;
  for (const observation of decision.observations) {
    const identity = canonicalJson([
      observation.instance_id, observation.source_module_id,
      observation.source_block_id, observation.channel,
    ]);
    if (observationIdentities.has(identity)) {
      errors.push("Filter observation trusted source/block/channel tuple is not unique");
    }
    observationIdentities.add(identity);
    if (observation.instance_id !== context.instanceId || observation.channel !== decision.channel) {
      errors.push(`Filter observation ${observation.source_block_id} disagrees with trusted instance/channel`);
    }
    if (observation.manifest_ordinal <= priorOrdinal) {
      errors.push("Filter observations are not in strictly ascending Manifest order");
    }
    priorOrdinal = observation.manifest_ordinal;
    if ((observation.disposition === "applied") !== (observation.applied_score !== null)) {
      errors.push(`Filter observation ${observation.source_block_id} applied_score/disposition mismatch`);
    }
  }
  replayFilterAccumulatorState(decision, context, errors);
  const sortedCandidates = [...decision.candidates].sort((left, right) => utf8Compare(
    left.tie_break_key,
    right.tie_break_key,
  ));
  if (canonicalJson(decision.candidates) !== canonicalJson(sortedCandidates)) {
    errors.push("Filter candidates are not sorted by trusted source tuple JCS UTF-8 bytes");
  }

  const count = decision.candidates.length;
  const sum = decision.candidates.reduce((total, candidate) =>
    total + BigInt(candidate.corrected_score_q), 0n);
  for (const candidate of decision.candidates) {
    const signed = 3n * BigInt(count) * BigInt(candidate.corrected_score_q) - 2n * sum;
    const expectedDistance = signed < 0n ? -signed : signed;
    if (BigInt(candidate.distance) !== expectedDistance) {
      errors.push(`Filter candidate ${candidate.source_module_id} distance is inconsistent with the cohort mean`);
    }
  }

  let selected = null;
  if (count === 0) {
    if (decision.selected_instance_id !== null || decision.selected_source_module_id !== null ||
        decision.selected_input_block_id !== null || decision.output_payload.output !== null) {
      errors.push("zero-candidate Filter decision must have a null selection and null output");
    }
  } else {
    selected = decision.candidates.find((candidate) =>
      candidate.instance_id === decision.selected_instance_id &&
      candidate.source_module_id === decision.selected_source_module_id &&
      candidate.selected_input_block_id === decision.selected_input_block_id);
    if (!selected) {
      errors.push("Filter selected source/block pair is not one of the candidates");
    }
    for (const candidate of decision.candidates) {
      const observation = decision.observations.find((item) =>
        item.instance_id === candidate.instance_id &&
        item.source_module_id === candidate.source_module_id &&
        item.source_block_id === candidate.selected_input_block_id &&
        item.channel === decision.channel);
      if (!observation) {
        errors.push(`Filter candidate ${candidate.source_module_id} selected Block is absent from Manifest observations`);
      } else if (["never_seen", "malformed", "self_ignored", "non_module_ignored"].includes(observation.disposition)) {
        errors.push(`Filter candidate ${candidate.source_module_id} selected an ineligible observation disposition`);
      }
    }
    const winner = [...decision.candidates].sort((left, right) => {
      const distanceOrder = BigInt(left.distance) < BigInt(right.distance) ? -1
        : BigInt(left.distance) > BigInt(right.distance) ? 1 : 0;
      if (distanceOrder !== 0) return distanceOrder;
      return utf8Compare(
        left.tie_break_key,
        right.tie_break_key,
      );
    })[0];
    if (!selected || selected.source_module_id !== winner.source_module_id ||
        selected.selected_input_block_id !== winner.selected_input_block_id) {
      errors.push("Filter selection is not the minimum-distance candidate under the fixed tie break");
    }
    if (selected && decision.output_payload?.output !== null) {
      const signals = (decision.output_payload.output.parts ?? []).filter((part) =>
        part.kind === "json" &&
        part.schema_uri === "https://dolly.example/spec/0.1/schemas/filter-signal.schema.json" &&
        part.value?.channel === decision.channel);
      const expectedScore = Number(roundHalfEven(BigInt(selected.corrected_score_q), 1000000n));
      if (signals.length !== 1 || signals[0].value?.score !== expectedScore) {
        errors.push("Filter output normalized signal does not equal round_half_even(q/R)");
      }
    }
  }
  const reconstructedPayload = reconstructFilterActivationPayload(
    decision, selected, context, errors);
  if (reconstructedPayload !== null &&
      canonicalJson(decision.output_payload) !== canonicalJson(reconstructedPayload)) {
    errors.push("Filter output_payload is not the exact v1 projection of the trusted selected Block");
  }
  if (decision.output_digest !== genericCanonicalDigest(decision.output_payload)) {
    errors.push("Filter output_digest does not match the exact prepared canonical payload");
  }
  if (context.preparedOutput !== undefined &&
      canonicalJson(context.preparedOutput) !== canonicalJson(decision.output_payload)) {
    errors.push("Filter embedded output_payload disagrees with independently read prepared output");
  }
  return errors;
}

export function validateFilterStateConfigTransition(current, proposed) {
  const errors = [];
  const sameNamespace = current.storage_scope_id === proposed.storage_scope_id &&
    current.channel === proposed.config.signal_channel &&
    current.state_epoch === proposed.config.state_epoch;
  if (sameNamespace && current.observation_count > 0 &&
      current.bias_correction !== proposed.config.bias_correction) {
    errors.push("FILTER_STATE_HEADER_CONFLICT: populated state cannot change bias_correction in place");
  }
  if (sameNamespace && (current.algorithm_revision !== "two-thirds-mean-filter-v1" ||
      current.internal_scale !== 1000000)) {
    errors.push("FILTER_STATE_HEADER_CONFLICT: state arithmetic header is incompatible");
  }
  return errors;
}

function roundHalfEven(numerator, denominator) {
  if (denominator <= 0n || numerator < 0n) throw new Error("roundHalfEven expects nonnegative numerator and positive denominator");
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const twice = remainder * 2n;
  if (twice < denominator) return quotient;
  if (twice > denominator) return quotient + 1n;
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

function applyFilterObservation(state, score, newSampleWeightPpm, biasCorrection) {
  const W = 1000000n;
  const w = BigInt(newSampleWeightPpm);
  const xq = BigInt(score) * W;
  const accumulator = roundHalfEven((W - w) * state.accumulator + w * xq, W);
  const weight = roundHalfEven((W - w) * state.weight + w * W, W);
  let corrected = biasCorrection
    ? roundHalfEven(accumulator * W, weight)
    : accumulator;
  if (corrected < 0n) corrected = 0n;
  if (corrected > 1000n * W) corrected = 1000n * W;
  return {accumulator, weight, corrected};
}

function testamentBlockDigest(block) {
  return domainSeparatedDigest("dolly.testament.block.v1", without(block, "content_digest"));
}

function testamentInputGroupDigest(group) {
  return domainSeparatedDigest("dolly.testament.input-group.v1", group);
}

function testamentSplitDigest(name, recordKeys) {
  return domainSeparatedDigest("dolly.testament.split.v1", {
    name,
    record_keys: recordKeys,
  });
}

function testamentInventoryValue(corpus) {
  return {
    blocks: corpus.blocks.map((block) =>
      [block.foreign_block_key, block.content_digest]).sort(rowCompare),
    assets: corpus.assets.map((asset) => [
      asset.foreign_asset_key,
      asset.content_digest,
      asset.byte_length,
      asset.media_type,
    ]).sort(rowCompare),
    input_groups: corpus.input_groups.map((group) => [
      group.record_key,
      testamentInputGroupDigest(group),
    ]).sort(rowCompare),
    actions: corpus.blocks.flatMap((block) => block.recorded_actions.map((action) => [
      action.source_action_key,
      block.foreign_block_key,
      action.ordinal,
      action.arguments_schema.schema_digest,
    ])).sort(rowCompare),
    fixtures: corpus.fixture_manifest.entries.map((fixture) => [
      fixture.fixture_key,
      fixture.fixture_digest,
      fixture.role,
      fixture.oracle_only,
    ]).sort(rowCompare),
  };
}

function unsafeCorpusObjectRef(objectRef) {
  return typeof objectRef !== "string" ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(objectRef) ||
    objectRef.includes("/") || objectRef.includes("\\");
}

/**
 * Context:
 *   fixtureDigest: exact independently authorized fixture bundle digest
 *   assetBytesByObjectRef: Map/object of corpus-local object_ref -> Buffer
 */
export function validateTestamentCorpus(corpus, context = {}) {
  const errors = schemaErrors(schemaIds.testamentCorpus, corpus);
  if (errors.length > 0) return errors;

  addDuplicateErrors(corpus.blocks, (item) => item.foreign_block_key,
    "foreign_block_key", errors);
  addDuplicateErrors(corpus.assets, (item) => item.foreign_asset_key,
    "foreign_asset_key", errors);
  addDuplicateErrors(corpus.input_groups, (item) => item.record_key,
    "input-group record_key", errors);

  const blockByKey = new Map(corpus.blocks.map((block) => [block.foreign_block_key, block]));
  const assetByKey = new Map(corpus.assets.map((asset) => [asset.foreign_asset_key, asset]));
  const groupByKey = new Map(corpus.input_groups.map((group) => [group.record_key, group]));
  const actionByKey = new Map();

  for (const block of corpus.blocks) {
    const expected = testamentBlockDigest(block);
    if (block.content_digest !== expected) {
      errors.push(`Block ${block.foreign_block_key} content_digest mismatch`);
    }
    for (const [actionIndex, action] of block.recorded_actions.entries()) {
      if (action.ordinal !== actionIndex) {
        errors.push(`Block ${block.foreign_block_key} recorded Action ${action.source_action_key} ordinal mismatch`);
      }
      if (actionByKey.has(action.source_action_key)) {
        errors.push(`duplicate source_action_key: ${action.source_action_key}`);
      }
      actionByKey.set(action.source_action_key, action);
      const schema = mapLookup(context.actionArgumentSchemas, action.arguments_schema.uri);
      if (!schema || schema.digest !== action.arguments_schema.schema_digest) {
        errors.push(`recorded Action ${action.source_action_key} argument schema is unavailable or digest-mismatched`);
      } else if (typeof schema.validate === "function" && !schema.validate(action.arguments)) {
        errors.push(`recorded Action ${action.source_action_key} arguments fail the pinned schema`);
      }
    }
    for (const [partIndex, part] of block.parts.entries()) {
      if (part.kind === "asset" && !assetByKey.has(part.foreign_asset_key)) {
        errors.push(`Block ${block.foreign_block_key} part ${partIndex} has dangling Asset ${part.foreign_asset_key}`);
      }
      if (part.kind === "asset" && assetByKey.has(part.foreign_asset_key)) {
        const asset = assetByKey.get(part.foreign_asset_key);
        if (part.media_type !== asset.media_type) {
          errors.push(`Block ${block.foreign_block_key} part ${partIndex} media_type disagrees with Asset ${part.foreign_asset_key}`);
        }
        errors.push(...cropErrors(part.view, part.media_type,
          `Block ${block.foreign_block_key} part ${partIndex}`));
      }
      if (part.kind === "block_ref" && !blockByKey.has(part.foreign_block_key)) {
        errors.push(`Block ${block.foreign_block_key} part ${partIndex} has dangling BlockRef ${part.foreign_block_key}`);
      }
    }
  }

  for (const asset of corpus.assets) {
    if (unsafeCorpusObjectRef(asset.object_ref)) {
      errors.push(`Asset ${asset.foreign_asset_key} has unsafe corpus object_ref ${asset.object_ref}`);
    }
    const bytes = mapLookup(context.assetBytesByObjectRef, asset.object_ref);
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
      errors.push(`Asset ${asset.foreign_asset_key} exact object bytes are unavailable`);
      continue;
    }
    if (asset.byte_length !== bytes.byteLength) {
      errors.push(`Asset ${asset.foreign_asset_key} byte_length mismatch`);
    }
    if (asset.content_digest !== sha256Bytes(bytes)) {
      errors.push(`Asset ${asset.foreign_asset_key} raw-byte content_digest mismatch`);
    }
  }

  const seenOccurrences = new Set();
  for (const group of corpus.input_groups) {
    for (const occurrence of group.occurrences) {
      const occurrenceKey = canonicalJson([
        group.record_key,
        occurrence.foreign_block_key,
        occurrence.source_page_alias,
        occurrence.occurrence_ordinal,
      ]);
      if (seenOccurrences.has(occurrenceKey)) {
        errors.push(`duplicate occurrence key: ${occurrenceKey}`);
      }
      seenOccurrences.add(occurrenceKey);
      if (!blockByKey.has(occurrence.foreign_block_key)) {
        errors.push(`input group ${group.record_key} has dangling occurrence ${occurrence.foreign_block_key}`);
      }
    }
  }

  const fixtureEntries = corpus.fixture_manifest.entries;
  addDuplicateErrors(fixtureEntries, (item) => item.fixture_key, "fixture_key", errors);
  for (const fixture of fixtureEntries) {
    if (fixture.oracle_only !== (fixture.role === "oracle_only")) {
      errors.push(`fixture ${fixture.fixture_key} oracle_only disagrees with role`);
    }
    for (const blockKey of fixture.block_keys) if (!blockByKey.has(blockKey)) {
      errors.push(`fixture ${fixture.fixture_key} has dangling Block ${blockKey}`);
    }
    for (const assetKey of fixture.asset_keys) if (!assetByKey.has(assetKey)) {
      errors.push(`fixture ${fixture.fixture_key} has dangling Asset ${assetKey}`);
    }
    for (const actionKey of fixture.action_keys) if (!actionByKey.has(actionKey)) {
      errors.push(`fixture ${fixture.fixture_key} has dangling recorded Action ${actionKey}`);
    }
  }

  const allSplitKeys = [];
  const splitOwner = new Map();
  for (const name of ["train", "development", "held_out"]) {
    const split = corpus.splits[name];
    const expectedOrder = sortedUtf8(split.record_keys);
    if (canonicalJson(split.record_keys) !== canonicalJson(expectedOrder)) {
      errors.push(`split ${name} record_keys are not ascending by UTF-8 bytes`);
    }
    const localSeen = new Set();
    for (const recordKey of split.record_keys) {
      if (localSeen.has(recordKey)) errors.push(`split ${name} repeats ${recordKey}`);
      localSeen.add(recordKey);
      if (!groupByKey.has(recordKey)) errors.push(`split ${name} names unknown input group ${recordKey}`);
      if (splitOwner.has(recordKey) && splitOwner.get(recordKey) !== name) {
        errors.push(`split overlap for ${recordKey}: ${splitOwner.get(recordKey)} and ${name}`);
      }
      splitOwner.set(recordKey, name);
      allSplitKeys.push(recordKey);
    }
    const expectedDigest = testamentSplitDigest(name, split.record_keys);
    if (split.digest !== expectedDigest) errors.push(`split ${name} digest mismatch`);
  }
  const declaredGroupKeys = sortedUtf8([...groupByKey.keys()]);
  const coveredGroupKeys = sortedUtf8([...new Set(allSplitKeys)]);
  if (canonicalJson(declaredGroupKeys) !== canonicalJson(coveredGroupKeys)) {
    errors.push("split inventory is not complete for declared input groups");
  }

  // References are required to be an importable DAG.  The same traversal is
  // also the information-flow oracle for target-visible oracle_only content.
  const visiting = new Set();
  const visited = new Set();
  function checkDag(blockKey) {
    if (visiting.has(blockKey)) {
      errors.push(`BlockRef cycle reaches ${blockKey}`);
      return;
    }
    if (visited.has(blockKey)) return;
    const block = blockByKey.get(blockKey);
    if (!block) return;
    visiting.add(blockKey);
    for (const part of block.parts) if (part.kind === "block_ref") checkDag(part.foreign_block_key);
    visiting.delete(blockKey);
    visited.add(blockKey);
  }
  for (const key of blockByKey.keys()) checkDag(key);

  for (const group of corpus.input_groups) {
    const closure = new Set();
    const pending = group.occurrences.map((item) => item.foreign_block_key);
    while (pending.length > 0) {
      const key = pending.pop();
      if (closure.has(key)) continue;
      closure.add(key);
      const block = blockByKey.get(key);
      if (!block) continue;
      if (block.role === "oracle_only") {
        errors.push(`input group ${group.record_key} target-visible closure reaches oracle_only Block ${key}`);
      }
      for (const part of block.parts) if (part.kind === "block_ref") pending.push(part.foreign_block_key);
    }
  }

  if (context.fixtureDigest === undefined) {
    errors.push("exact authorized fixture bundle digest is unavailable");
  } else if (corpus.fixture_manifest.bundle_digest !== context.fixtureDigest) {
    errors.push("fixture_manifest bundle_digest does not match the authorized fixture bundle");
  }

  const expectedInventoryDigest = domainSeparatedDigest(
    "dolly.testament.inventory.v1", testamentInventoryValue(corpus));
  if (corpus.inventory_digest !== expectedInventoryDigest) {
    errors.push("inventory_digest mismatch");
  }
  const expectedCorpusDigest = domainSeparatedDigest(
    "dolly.testament.corpus.v1", without(corpus, "corpus_digest"));
  if (corpus.corpus_digest !== expectedCorpusDigest) {
    errors.push("corpus_digest mismatch");
  }
  return errors;
}

/**
 * Context:
 *   corpus: a validated Corpus Manifest
 *   sandboxTemplateDigests / backupManifestDigests: authorized inventories
 *   actionFixtureDigests / actionAdapterDigests: authorized immutable objects
 *   livePolicyAuthorization: exact {plan_digest, network_policy,
 *     external_effect_policy} authorization for non-default policies
 */
export function validateTestamentReplayPlan(plan, context = {}) {
  const errors = schemaErrors(schemaIds.testamentPlan, plan);

  const expectedPlanDigest = domainSeparatedDigest(
    "dolly.testament.replay-plan.v1", without(plan, "plan_digest"));
  if (plan.plan_digest !== expectedPlanDigest) errors.push("plan_digest mismatch");

  if (!context.corpus || context.corpus.corpus_digest !== plan.corpus_digest) {
    errors.push("replay plan corpus_digest does not bind the validated Corpus");
  }
  if (!setHas(context.sandboxTemplateDigests, plan.sandbox_template_digest)) {
    errors.push("sandbox_template_digest is absent from the authorized inventory");
  }

  if (plan.mode === "full_snapshot_clone") {
    if ((plan.mappings ?? []).length !== 0) errors.push("full_snapshot_clone must not contain mappings");
    if (plan.source_backup_manifest_digest === null ||
        !setHas(context.backupManifestDigests, plan.source_backup_manifest_digest)) {
      errors.push("full_snapshot_clone backup digest is absent from the authorized inventory");
    }
  } else if (plan.mode === "portable_semantic_replay") {
    if ((plan.mappings ?? []).length === 0) errors.push("portable_semantic_replay requires mappings");
    if (plan.source_backup_manifest_digest !== null) {
      errors.push("portable_semantic_replay cannot bind a source backup");
    }
  }

  const sourceAliases = new Set((context.corpus?.input_groups ?? [])
    .map((group) => group.source_recipient_alias));
  const mappedAliases = new Set();
  const blockByKey = new Map((context.corpus?.blocks ?? []).map((block) =>
    [block.foreign_block_key, block]));
  const actionByKey = new Map();
  for (const block of context.corpus?.blocks ?? []) {
    for (const action of block.recorded_actions) actionByKey.set(action.source_action_key, action);
  }
  const fixtureByKey = new Map((context.corpus?.fixture_manifest?.entries ?? [])
    .map((fixture) => [fixture.fixture_key, fixture]));

  function reachableActionKeys(alias) {
    const blockKeys = new Set();
    const pending = (context.corpus?.input_groups ?? [])
      .filter((group) => group.source_recipient_alias === alias)
      .flatMap((group) => group.occurrences.map((item) => item.foreign_block_key));
    while (pending.length > 0) {
      const key = pending.pop();
      if (blockKeys.has(key)) continue;
      blockKeys.add(key);
      const block = blockByKey.get(key);
      for (const part of block?.parts ?? []) if (part.kind === "block_ref") pending.push(part.foreign_block_key);
    }
    return new Set([...blockKeys].flatMap((key) =>
      (blockByKey.get(key)?.recorded_actions ?? []).map((action) => action.source_action_key)));
  }
  for (const mapping of plan.mappings ?? []) {
    if (mappedAliases.has(mapping.source_recipient_alias)) {
      errors.push(`duplicate source mapping key: ${mapping.source_recipient_alias}`);
    }
    mappedAliases.add(mapping.source_recipient_alias);
    if (!sourceAliases.has(mapping.source_recipient_alias)) {
      errors.push(`mapping names unknown source recipient ${mapping.source_recipient_alias}`);
    }

    const targetKeys = new Set();
    const sandboxIds = new Set();
    for (const target of mapping.targets ?? []) {
      const targetKey = canonicalJson([
        target.treatment_id,
        target.sandbox_id,
        target.target_module_id,
        target.replay_page_id,
      ]);
      if (targetKeys.has(targetKey)) errors.push(`duplicate target endpoint in ${mapping.source_recipient_alias}`);
      targetKeys.add(targetKey);
      if (mapping.fanout_mode === "independent_clones" && sandboxIds.has(target.sandbox_id)) {
        errors.push(`independent_clones share sandbox_id ${target.sandbox_id}`);
      }
      sandboxIds.add(target.sandbox_id);
    }
    if (mapping.fanout_mode === "cooperative_graph" && sandboxIds.size > 1) {
      errors.push(`cooperative_graph mapping ${mapping.source_recipient_alias} spans multiple sandboxes`);
    }
    const reachableActions = reachableActionKeys(mapping.source_recipient_alias);
    const seenRules = new Set();
    for (const rule of mapping.action_rules ?? []) {
      if (seenRules.has(rule.source_action_key)) {
        errors.push(`duplicate action rule ${rule.source_action_key} in ${mapping.source_recipient_alias}`);
      }
      seenRules.add(rule.source_action_key);
      if (!reachableActions.has(rule.source_action_key)) {
        errors.push(`extra or unreachable action rule ${rule.source_action_key} in ${mapping.source_recipient_alias}`);
      }
      if (rule.policy === "mock") {
        const fixture = fixtureByKey.get(rule.fixture_key);
        if (!fixture || fixture.fixture_digest !== rule.fixture_digest ||
            !fixture.action_keys.includes(rule.source_action_key) || fixture.oracle_only) {
          errors.push(`mock rule ${rule.source_action_key} does not bind an exact non-oracle admitted fixture`);
        }
      }
      if (rule.policy === "explicit_remap" &&
          !setHas(context.actionAdapterDigests, rule.adapter_digest)) {
        errors.push(`explicit_remap rule ${rule.source_action_key} has an unauthorized adapter digest`);
      }
    }
    for (const key of reachableActions) if (!seenRules.has(key)) {
      errors.push(`reachable recorded Action lacks an explicit rule: ${key}`);
    }
  }
  if (plan.mode === "portable_semantic_replay") {
    for (const alias of sourceAliases) {
      if (!mappedAliases.has(alias)) errors.push(`required source recipient is unmapped: ${alias}`);
    }
  }

  const liveNetwork = !["deny_all", "fixtures_only"].includes(plan.network_policy);
  const liveEffects = !["deny", "mock_only"].includes(plan.external_effect_policy);
  if (liveNetwork || liveEffects) {
    const authorization = context.livePolicyAuthorization;
    if (!authorization || authorization.plan_digest !== plan.plan_digest ||
        authorization.network_policy !== plan.network_policy ||
        authorization.external_effect_policy !== plan.external_effect_policy) {
      errors.push("live network/external effects require a separate exact plan-bound authorization");
    }
  }
  if (plan.mode === "full_snapshot_clone" && (liveNetwork || liveEffects)) {
    errors.push("full_snapshot_clone never permits live network or external-effect policy");
  }

  if (plan.scheduler === "scripted_steps") {
    const inventory = mapLookup(context.schedulerResources, plan.scheduler_config.script_digest);
    if (!inventory || inventory.transition_catalog_digest !== plan.scheduler_config.transition_catalog_digest) {
      errors.push("scripted scheduler does not bind an authorized script/catalog pair");
    } else {
      for (const transition of plan.scheduler_config.ordered_transition_ids) {
        if (!inventory.transition_ids.includes(transition)) {
          errors.push(`scripted scheduler transition is absent from pinned catalog: ${transition}`);
        }
      }
    }
  }
  if (plan.scheduler === "controller") {
    for (const [idField, digestField, kind] of [
      ["model_id", "model_digest", "model"],
      ["prompt_id", "prompt_digest", "prompt"],
      ["policy_id", "policy_digest", "policy"],
      ["transition_catalog_id", "transition_catalog_digest", "transition_catalog"],
    ]) {
      const binding = mapLookup(context.controllerResources, `${kind}:${plan.scheduler_config[idField]}`);
      if (!binding || binding !== plan.scheduler_config[digestField]) {
        errors.push(`controller ${kind} ID/digest does not bind an authorized immutable object`);
      }
    }
  }
  return errors;
}

function canonicalEndpoint(raw) {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "wss:") return {error: "endpoint protocol is not wss"};
    if (parsed.username !== "" || parsed.password !== "") return {error: "endpoint contains credentials"};
    if (parsed.search !== "") return {error: "endpoint contains query parameters"};
    if (parsed.hash !== "") return {error: "endpoint contains a fragment"};
    return {value: parsed.href};
  } catch {
    return {error: "endpoint is not a valid absolute URL"};
  }
}

export function validateLevelUpperShare(config) {
  const errors = schemaErrors(schemaIds.levelShare, config);
  if (errors.length > 0) return errors;

  addDuplicateErrors(config.peers, (peer) => peer.peer_id, "peer_id", errors);
  addDuplicateErrors(config.shares, (share) => share.share_id, "share_id", errors);
  const peers = new Map(config.peers.map((peer) => [peer.peer_id, peer]));
  const shares = new Map(config.shares.map((share) => [share.share_id, share]));

  const endpointOwners = new Map();
  for (const peer of config.peers) {
    const localEndpoints = new Set();
    for (const endpoint of peer.endpoints) {
      const normalized = canonicalEndpoint(endpoint);
      if (normalized.error) {
        errors.push(`peer ${peer.peer_id} ${normalized.error}: ${endpoint}`);
        continue;
      }
      if (localEndpoints.has(normalized.value)) {
        errors.push(`peer ${peer.peer_id} has canonically duplicate endpoint ${normalized.value}`);
      }
      localEndpoints.add(normalized.value);
      const priorOwner = endpointOwners.get(normalized.value);
      if (priorOwner && priorOwner !== peer.peer_id) {
        errors.push(`endpoint ${normalized.value} is assigned to multiple peer identities`);
      }
      endpointOwners.set(normalized.value, peer.peer_id);
    }
    for (const allowedShare of peer.allowed_share_ids) {
      const share = shares.get(allowedShare);
      if (!share || share.peer_id !== peer.peer_id) {
        errors.push(`peer ${peer.peer_id} allows undeclared or differently owned share ${allowedShare}`);
      }
    }
  }

  for (const share of config.shares) {
    const peer = peers.get(share.peer_id);
    if (!peer) {
      errors.push(`share ${share.share_id} names undeclared peer ${share.peer_id}`);
    } else if (!peer.allowed_share_ids.includes(share.share_id)) {
      errors.push(`share ${share.share_id} is not authorized by peer ${share.peer_id}`);
    }
    const directionKinds = new Set();
    const directionIds = new Set();
    const pagesByKind = new Map();
    const labelsByKind = new Map();
    for (const direction of share.directions) {
      if (directionIds.has(direction.direction_id)) {
        errors.push(`share ${share.share_id} repeats direction_id ${direction.direction_id}`);
      }
      directionIds.add(direction.direction_id);
      if (directionKinds.has(direction.kind)) {
        errors.push(`share ${share.share_id} repeats ${direction.kind} direction`);
      }
      directionKinds.add(direction.kind);
      pagesByKind.set(direction.kind, new Set(direction.local_page_ids));
      labelsByKind.set(direction.kind, new Set(direction.remote_stream_labels));
    }
    const exportPages = pagesByKind.get("export") ?? new Set();
    const importPages = pagesByKind.get("import") ?? new Set();
    for (const page of exportPages) {
      if (importPages.has(page)) errors.push(`share ${share.share_id} aliases Page ${page} for export and import`);
    }
    const exportLabels = labelsByKind.get("export") ?? new Set();
    const importLabels = labelsByKind.get("import") ?? new Set();
    for (const label of exportLabels) {
      if (importLabels.has(label)) {
        errors.push(`share ${share.share_id} aliases remote stream ${label} for export and import`);
      }
    }
  }
  return errors;
}

export const levelUpperActivationReplayDescriptor = Object.freeze({
  mode: "fenced_replay",
  evidence: "activation_ledger",
  ledger: Object.freeze({
    namespace: "org.dolly.levelupper.activation",
    schema_version: "v1",
    location: "module_state_directory",
  }),
});

/** The exporting Descriptor must opt into exactly this recovery contract. */
export function validateLevelUpperActivationDescriptor(descriptor) {
  return canonicalJson(descriptor) === canonicalJson(levelUpperActivationReplayDescriptor)
    ? []
    : ["LevelUpper activation replay descriptor is not the fixed fenced_replay contract"];
}

function levelStorageTenantKey(value) {
  return canonicalJson([
    value?.daemon_installation_id, value?.instance_id, value?.storage_scope_id,
  ]);
}

/**
 * Bind every durable lookup/handle to the Host-owned tenant tuple.  Peer/share
 * strings are secondary routing keys and deliberately do not participate in
 * tenant selection.
 */
export function validateLevelUpperStorageAuthority(operation, context = {}) {
  const errors = [];
  const expected = levelStorageTenantKey(context.expectedTenant);
  const actual = levelStorageTenantKey(operation.tenant);
  if (expected.includes("null") || expected.includes("undefined")) {
    errors.push("LevelUpper storage validation lacks the Host-owned tenant tuple");
  } else if (actual !== expected) {
    errors.push("LevelUpper durable operation/ACK/pin/Broker handle has the wrong storage tenant scope");
  }
  if (context.authorizedHandleTenant !== undefined &&
      levelStorageTenantKey(context.authorizedHandleTenant) !== expected) {
    errors.push("LevelUpper Broker/pin handle was issued to a different storage tenant scope");
  }
  return errors;
}

export function validateLevelUpperContent(content, context = {}) {
  const errors = schemaErrors(schemaIds.levelContent, content);
  if (errors.length > 0) return errors;

  const expected = domainSeparatedDigest(
    "dolly.levelupper.content.v1", without(content, "content_digest"));
  if (content.content_digest !== expected) errors.push("portable content_digest mismatch");

  const assets = new Map();
  for (const [index, part] of content.parts.entries()) {
    if (part.kind === "asset") {
      if (context.maxAssetBytes !== undefined && part.byte_length > context.maxAssetBytes) {
        errors.push(`portable Asset part ${index} exceeds negotiated max_asset_bytes`);
      }
      const binding = canonicalJson([part.content_digest, part.byte_length, part.media_type, part.view]);
      const prior = assets.get(part.foreign_asset_key);
      if (prior !== undefined && prior !== binding) {
        errors.push(`foreign_asset_key ${part.foreign_asset_key} has conflicting manifests`);
      }
      assets.set(part.foreign_asset_key, binding);
      errors.push(...cropErrors(part.view, part.media_type, `portable Asset part ${index}`));
    } else if (part.kind === "json" && context.schemaDigests !== undefined) {
      const expectedSchemaDigest = mapLookup(context.schemaDigests, part.schema_uri);
      if (expectedSchemaDigest === undefined || expectedSchemaDigest !== part.schema_digest) {
        errors.push(`portable JSON part ${index} has an unavailable or mismatched schema_digest`);
      }
    }
  }
  return errors;
}

export function levelUpperEntryHash(entry) {
  const payload = Buffer.from(canonicalJson(
    without(entry, "previous_entry_hash", "entry_hash")), "utf8");
  const previous = entry.export_seq === 1
    ? Buffer.alloc(32)
    : digestBytes(entry.previous_entry_hash);
  if (previous === null) return null;
  return sha256Bytes(Buffer.concat([
    Buffer.from("dolly.levelupper.entry.v1", "utf8"),
    Buffer.from([0]),
    previous,
    uint64be(entry.export_seq),
    uint32be(payload.length),
    payload,
  ]));
}

function previousHashFromContext(entry, context) {
  if (context.previousEntryHash !== undefined) return context.previousEntryHash;
  const key = canonicalJson([
    entry.share_id, entry.direction_id, entry.share_epoch_id, entry.export_seq - 1,
  ]);
  return mapLookup(context.previousEntryHashes, key);
}

export function validateLevelUpperEntry(entry, context = {}) {
  const errors = schemaErrors(schemaIds.levelEntry, entry);
  if (errors.length > 0) return errors;

  const path = entry.origin.visited_peer_path;
  if (entry.origin.hop_count !== path.length) {
    errors.push("hop_count does not equal visited_peer_path length");
  }
  if (path.length === 0 || path[0] !== entry.origin.origin_peer_id) {
    errors.push("origin_peer_id is not the first visited peer");
  }
  if (context.expectedOrigin !== undefined) {
    for (const [field, expected] of Object.entries(context.expectedOrigin)) {
      if (entry.origin[field] !== expected) errors.push(`origin ${field} was not preserved`);
    }
  } else if (entry.origin.hop_count === 1) {
    if (entry.origin.origin_direction_id !== entry.direction_id ||
        entry.origin.origin_share_epoch_id !== entry.share_epoch_id ||
        entry.origin.origin_entry_key !== entry.foreign_entry_key) {
      errors.push("first-hop origin direction/epoch/entry does not bind the initial occurrence");
    }
  }
  if (new Set(path).size !== path.length) errors.push("visited_peer_path repeats a peer");
  if (entry.origin.hop_count > entry.origin.hop_limit) errors.push("hop_count exceeds hop_limit");

  if (entry.export_seq === 1) {
    if (entry.previous_entry_hash !== null) errors.push("export_seq 1 must have null previous_entry_hash");
  } else {
    if (entry.previous_entry_hash === null) {
      errors.push("export_seq greater than 1 requires previous_entry_hash");
    }
    const expectedPrevious = previousHashFromContext(entry, context);
    if (expectedPrevious === undefined) {
      errors.push("prior checkpoint evidence is required for export_seq greater than 1");
    } else if (entry.previous_entry_hash !== expectedPrevious) {
      errors.push("previous_entry_hash does not match the exact prior checkpoint");
    }
  }
  const expectedEntryHash = levelUpperEntryHash(entry);
  if (expectedEntryHash === null || entry.entry_hash !== expectedEntryHash) {
    errors.push("entry_hash mismatch");
  }
  return errors;
}

function levelUpperFrameDigest(frame) {
  return domainSeparatedDigest("dolly.levelupper.frame.v1", without(frame, "frame_digest"));
}

export function levelUpperNegotiationDigest(value) {
  return domainSeparatedDigest("dolly.levelupper.negotiation.v1", {
    hello_frame_digests: [...value.hello_frame_digests].sort(utf8Compare),
    peer_ids: [...value.peer_ids].sort(utf8Compare),
    protocol_version: value.protocol_version,
    effective_limits: value.effective_limits,
  });
}

function validateHelloNegotiation(frame, context, errors) {
  if (frame.body.kind === "hello" && frame.body.minimum_version > frame.body.maximum_version) {
    errors.push("hello minimum_version exceeds maximum_version");
  }
  if (!context.negotiation) return;
  const negotiation = context.negotiation;
  const low = Math.max(
    negotiation.local_min, negotiation.peer_min, negotiation.configured_min,
  );
  const high = Math.min(negotiation.local_max, negotiation.peer_max);
  if (low > high) {
    errors.push("LevelUpper protocol version ranges do not intersect");
    return;
  }
  if (frame.protocol_version !== high) {
    errors.push("LevelUpper selected protocol_version is not the highest mutually supported version");
  }
  if (["open_share", "accept_share"].includes(frame.body.kind)) {
    const names = [
      "max_frame_bytes", "max_batch_entries", "max_in_flight_bytes",
      "max_asset_bytes", "max_asset_chunk_bytes", "max_outstanding_requests",
    ];
    const expectedLimits = {};
    for (const name of names) {
      expectedLimits[name] = Math.min(
        negotiation.local_limits[name], negotiation.peer_limits[name],
        negotiation.configured_limits[name],
      );
    }
    if (canonicalJson(frame.body.effective_limits) !== canonicalJson(expectedLimits)) {
      errors.push("open-share effective_limits do not equal the negotiated minima");
    }
    const expectedTranscript = levelUpperNegotiationDigest({
      hello_frame_digests: negotiation.hello_frame_digests,
      peer_ids: negotiation.peer_ids,
      protocol_version: high,
      effective_limits: expectedLimits,
    });
    if (frame.body.negotiation_transcript_digest !== expectedTranscript) {
      errors.push("open-share negotiation_transcript_digest mismatch");
    }
  }
}

function validateFlowRevision(frame, context, errors) {
  if (frame.body.kind !== "flow_control") return;
  const key = canonicalJson([
    frame.connection_epoch, frame.body.share.share_id,
    frame.body.share.direction_id, frame.body.share.share_epoch_id,
  ]);
  const prior = mapLookup(context.flowState, key);
  if (!prior) return;
  if (frame.body.credit_revision < prior.credit_revision) {
    errors.push("flow_control credit_revision is older than retained state and must be ignored");
  } else if (frame.body.credit_revision === prior.credit_revision &&
      (frame.body.credit_bytes !== prior.credit_bytes ||
       frame.body.credit_entries !== prior.credit_entries)) {
    errors.push("flow_control repeats a credit_revision with conflicting absolute grants");
  }
}

function validateCheckpointDisposition(frame, context, errors) {
  const body = frame.body;
  if (body.kind === "resume_checkpoint") {
    if ((body.export_seq === 0) !== (body.entry_hash === null)) {
      errors.push("resume checkpoint requires seq=0 iff entry_hash is null");
    }
    const expected = context.continuousCheckpoint;
    if (expected !== undefined && (body.export_seq !== expected.export_seq ||
        body.entry_hash !== expected.entry_hash)) {
      errors.push("resume checkpoint does not equal the durable continuous high-water");
    }
  }
  if (body.kind === "entry_ack") {
    const expected = context.continuousCheckpoint;
    if (!expected || body.export_seq !== expected.export_seq ||
        body.entry_hash !== expected.entry_hash) {
      errors.push("entry ACK does not equal the durable continuous locally committed checkpoint");
    }
    if (context.senderDurableHighWater !== undefined &&
        body.export_seq > context.senderDurableHighWater) {
      errors.push("entry ACK exceeds the sender durable high-water");
    }
  }
  if (body.kind === "entry_nack" && context.priorAcknowledgedHighWater !== undefined &&
      context.proposedAcknowledgedHighWater !== context.priorAcknowledgedHighWater) {
    errors.push("entry NACK must not advance acknowledged high-water");
  }
}

function sameShareBinding(outer, entry) {
  return outer.share_id === entry.share_id &&
    outer.share_revision === entry.share_revision &&
    outer.direction_id === entry.direction_id &&
    outer.share_epoch_id === entry.share_epoch_id;
}

function shareBindingMatches(left, right) {
  return left?.share_id === right?.share_id &&
    left?.share_revision === right?.share_revision &&
    left?.direction_id === right?.direction_id &&
    left?.share_epoch_id === right?.share_epoch_id;
}

function validateAssetRequestBody(frame, context, errors) {
  const body = frame.body;
  const offer = mapLookup(context.retainedAssetOffers, body.foreign_asset_key);
  if (!offer) {
    errors.push(`asset_request has no retained offer for ${body.foreign_asset_key}`);
    return;
  }
  if (offer.share !== undefined && !shareBindingMatches(body.share, offer.share)) {
    errors.push("asset_request share binding does not match the retained offer");
  }
  const outstanding = context.currentOutstandingRequests;
  const maximum = context.maxOutstandingRequests;
  if (!Number.isInteger(outstanding) || !Number.isInteger(maximum)) {
    errors.push("asset_request validation requires current and maximum outstanding-request counts");
  } else if (outstanding >= maximum) {
    errors.push("asset_request exceeds max_outstanding_requests");
  }

  const configuredChunk = context.maxAssetChunkBytes ?? Number.MAX_SAFE_INTEGER;
  const offeredChunk = offer.chunk_bytes ?? Number.MAX_SAFE_INTEGER;
  const maxChunk = Math.min(configuredChunk, offeredChunk);
  const offerLength = BigInt(offer.byte_length);
  let previousEnd = -1n;
  let total = 0n;
  for (const [index, range] of body.ranges.entries()) {
    const offset = BigInt(range.offset);
    const length = BigInt(range.length);
    const end = offset + length;
    if (index > 0 && offset < previousEnd) {
      errors.push(`asset_request ranges overlap or are not sorted at index ${index}`);
    }
    if (end > offerLength) errors.push(`asset_request range ${index} exceeds retained offer length`);
    if (range.length > maxChunk) errors.push(`asset_request range ${index} exceeds effective chunk limit`);
    previousEnd = end;
    total += length;
  }
  if (context.remainingCreditBytes !== undefined && total > BigInt(context.remainingCreditBytes)) {
    errors.push("asset_request total exceeds negotiated remaining byte credit");
  }
}

function validateAssetOfferBody(frame, context, errors) {
  const body = frame.body;
  if (context.maxAssetBytes !== undefined && body.byte_length > context.maxAssetBytes) {
    errors.push("asset_offer exceeds effective max_asset_bytes");
  }
  if (context.maxAssetChunkBytes !== undefined && body.chunk_bytes > context.maxAssetChunkBytes) {
    errors.push("asset_offer chunk_bytes exceeds effective chunk limit");
  }
  const manifest = mapLookup(context.contentAssetManifests, body.foreign_asset_key);
  if (!manifest) {
    errors.push(`asset_offer has no retained portable-content manifest for ${body.foreign_asset_key}`);
  } else if (manifest.content_digest !== body.content_digest ||
      manifest.byte_length !== body.byte_length || manifest.media_type !== body.media_type) {
    errors.push("asset_offer metadata does not exactly match portable content");
  }
}

function validateAssetCompleteBody(frame, context, errors) {
  const body = frame.body;
  const offer = mapLookup(context.retainedAssetOffers, body.foreign_asset_key);
  const staged = mapLookup(context.stagedAssets, body.foreign_asset_key);
  if (!offer || !staged) {
    errors.push("asset_complete requires a retained offer and durable staging evidence");
    return;
  }
  if (!shareBindingMatches(body.share, offer.share)) {
    errors.push("asset_complete share binding does not match the retained offer");
  }
  if (staged.exact_coverage !== true || staged.byte_length !== offer.byte_length) {
    errors.push("asset_complete does not have exact durable interval coverage");
  }
  if (staged.content_digest !== offer.content_digest ||
      body.content_digest !== offer.content_digest) {
    errors.push("asset_complete full-object digest does not match the retained offer");
  }
}

/**
 * Context:
 *   authenticatedPeerId: Broker-authenticated peer for this stream
 *   retainedContentDigests: already retained or same-batch content digests
 *   previousEntryHashes: Map/object keyed by JCS([share_id, epoch_id, seq])
 */
export function validateLevelUpperWire(frame, context = {}) {
  const errors = schemaErrors(schemaIds.levelWire, frame);
  if (errors.length > 0) return errors;

  if (frame.frame_digest !== levelUpperFrameDigest(frame)) errors.push("frame_digest mismatch");
  if (context.authenticatedPeerId !== undefined &&
      frame.sender_peer_id !== context.authenticatedPeerId) {
    errors.push("sender_peer_id does not match the authenticated Broker peer");
  }
  validateHelloNegotiation(frame, context, errors);
  validateFlowRevision(frame, context, errors);
  validateCheckpointDisposition(frame, context, errors);
  if (frame.body.kind === "portable_content") {
    for (const error of validateLevelUpperContent(frame.body.content, context.contentContext ?? {})) {
      errors.push(`nested content: ${error}`);
    }
  }
  if (frame.body.kind === "portable_entry") {
    const entry = frame.body.entry;
    if (!sameShareBinding(frame.body.share, entry)) {
      errors.push("outer and nested entry share/revision/epoch binding disagree");
    }
    const path = entry.origin.visited_peer_path;
    if (path.length === 0 || path[path.length - 1] !== frame.sender_peer_id) {
      errors.push("sender_peer_id is not the final visited peer");
    }
    if (!setHas(context.retainedContentDigests, entry.content_digest)) {
      errors.push("portable entry content_digest is not retained or present in the bounded batch");
    }
    for (const error of validateLevelUpperEntry(entry, context)) {
      errors.push(`nested entry: ${error}`);
    }
  }
  if (frame.body.kind === "asset_offer") validateAssetOfferBody(frame, context, errors);
  if (frame.body.kind === "asset_request") validateAssetRequestBody(frame, context, errors);
  if (frame.body.kind === "asset_complete") validateAssetCompleteBody(frame, context, errors);
  return errors;
}

function rawUuid(value) {
  return Buffer.from(value.replaceAll("-", ""), "hex");
}

function formatUuid(bytes) {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function rawDigest(value) {
  return Buffer.from(value.slice("sha256:".length), "hex");
}

function strictUtf8(bytes) {
  return new TextDecoder("utf-8", {fatal: true}).decode(bytes);
}

function intervalContains(range, offset, length) {
  const start = BigInt(range.offset);
  const end = start + BigInt(range.length);
  const candidateStart = BigInt(offset);
  const candidateEnd = candidateStart + BigInt(length);
  return candidateStart >= start && candidateEnd <= end;
}

/**
 * Validate the exact DLYLUA01 binary Asset-chunk frame.  Context is mandatory
 * because the bytes are accepted only as an answer to one retained request:
 * protocol_version, link_session_id, connection_epoch, authenticated_peer_id,
 * message_id, share, foreign_asset_key, requested_ranges, offer_byte_length,
 * max_asset_chunk_bytes, and optional prior_chunks.
 */
export function validateLevelUpperBinaryChunk(input, context = {}) {
  const errors = [];
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
    return ["binary chunk input is not bytes"];
  }
  const bytes = Buffer.from(input);
  let cursor = 0;
  function take(length) {
    if (!Number.isSafeInteger(length) || length < 0 || cursor + length > bytes.length) {
      throw new Error("binary frame is truncated or length-overflows its container");
    }
    const out = bytes.subarray(cursor, cursor + length);
    cursor += length;
    return out;
  }
  function u16() { return take(2).readUInt16BE(); }
  function u32() { return take(4).readUInt32BE(); }
  function u64() { return take(8).readBigUInt64BE(); }

  let decoded;
  try {
    const magic = take(8).toString("ascii");
    const protocolVersion = u16();
    const linkSessionId = formatUuid(take(16));
    const connectionEpoch = u64();
    const senderPeerId = `sha256:${take(32).toString("hex")}`;
    const messageId = formatUuid(take(16));
    const shareRevision = u64();
    const shareIdBytes = take(u16());
    const shareId = strictUtf8(shareIdBytes);
    if (!shareIdBytes.equals(Buffer.from(shareId, "utf8"))) throw new Error("share_id is not canonical UTF-8");
    const directionIdBytes = take(u16());
    const directionId = strictUtf8(directionIdBytes);
    if (!directionIdBytes.equals(Buffer.from(directionId, "utf8"))) {
      throw new Error("direction_id is not canonical UTF-8");
    }
    const shareEpochId = formatUuid(take(16));
    const assetKeyBytes = take(u16());
    const foreignAssetKey = strictUtf8(assetKeyBytes);
    if (!assetKeyBytes.equals(Buffer.from(foreignAssetKey, "utf8"))) {
      throw new Error("foreign_asset_key is not canonical UTF-8");
    }
    const offset = u64();
    const length = u32();
    const chunkDigest = `sha256:${take(32).toString("hex")}`;
    const chunk = take(length);
    if (cursor !== bytes.length) throw new Error("binary frame has trailing bytes");
    decoded = {
      magic, protocolVersion, linkSessionId, connectionEpoch, senderPeerId,
      messageId, shareRevision, shareId, directionId, shareEpochId, foreignAssetKey,
      offset, length, chunkDigest, chunk,
    };
  } catch (error) {
    return [error.message];
  }

  if (decoded.magic !== "DLYLUA01") errors.push("binary chunk magic mismatch");
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(decoded.shareId)) {
    errors.push("binary chunk share_id is not a StableId");
  }
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(decoded.directionId)) {
    errors.push("binary chunk direction_id is not a StableId");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(decoded.foreignAssetKey)) {
    errors.push("binary chunk foreign_asset_key is invalid");
  }

  const required = [
    "protocol_version", "link_session_id", "connection_epoch", "authenticated_peer_id",
    "message_id", "share", "foreign_asset_key", "requested_ranges", "offer_byte_length",
    "max_asset_chunk_bytes",
  ];
  for (const field of required) if (context[field] === undefined) {
    errors.push(`binary chunk validation context lacks ${field}`);
  }
  if (errors.some((error) => error.startsWith("binary chunk validation context lacks"))) return errors;

  if (decoded.protocolVersion !== context.protocol_version) errors.push("binary chunk protocol_version fence mismatch");
  if (decoded.linkSessionId !== context.link_session_id) errors.push("binary chunk link_session_id fence mismatch");
  if (decoded.connectionEpoch !== BigInt(context.connection_epoch)) errors.push("binary chunk connection_epoch fence mismatch");
  if (decoded.senderPeerId !== context.authenticated_peer_id) errors.push("binary chunk authenticated peer fence mismatch");
  if (decoded.messageId !== context.message_id) errors.push("binary chunk message_id/request fence mismatch");
  if (decoded.shareId !== context.share.share_id ||
      decoded.shareRevision !== BigInt(context.share.share_revision) ||
      decoded.directionId !== context.share.direction_id ||
      decoded.shareEpochId !== context.share.share_epoch_id) {
    errors.push("binary chunk share/revision/direction/epoch fence mismatch");
  }
  if (decoded.foreignAssetKey !== context.foreign_asset_key) errors.push("binary chunk Asset key fence mismatch");

  const end = decoded.offset + BigInt(decoded.length);
  if (end > BigInt(context.offer_byte_length)) errors.push("binary chunk range exceeds retained offer");
  if (!context.requested_ranges.some((range) =>
    intervalContains(range, decoded.offset, decoded.length))) {
    errors.push("binary chunk range is outside the outstanding request");
  }
  if (decoded.length > context.max_asset_chunk_bytes) errors.push("binary chunk exceeds effective chunk limit");
  if (decoded.chunkDigest !== sha256Bytes(decoded.chunk)) errors.push("binary chunk digest mismatch");

  for (const prior of context.prior_chunks ?? []) {
    const priorStart = BigInt(prior.offset);
    const priorEnd = priorStart + BigInt(prior.length);
    if (decoded.offset < priorEnd && end > priorStart) {
      const identical = decoded.offset === priorStart && decoded.length === prior.length &&
        decoded.chunkDigest === prior.content_digest;
      if (!identical) errors.push("binary chunk conflicts or overlaps an already staged chunk");
    }
  }
  return errors;
}

function testDigest(character) {
  return `sha256:${character.repeat(64)}`;
}

function testUuid(suffix) {
  return `0198ab31-6c44-7e8a-b2bb-${String(suffix).padStart(12, "0")}`;
}

function sealCorpus(corpus, context) {
  for (const asset of corpus.assets) {
    const bytes = mapLookup(context.assetBytesByObjectRef, asset.object_ref);
    if (Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) {
      asset.byte_length = bytes.byteLength;
      asset.content_digest = sha256Bytes(bytes);
    }
  }
  for (const block of corpus.blocks) block.content_digest = testamentBlockDigest(block);
  for (const name of ["train", "development", "held_out"]) {
    corpus.splits[name].digest = testamentSplitDigest(name, corpus.splits[name].record_keys);
  }
  corpus.inventory_digest = domainSeparatedDigest(
    "dolly.testament.inventory.v1", testamentInventoryValue(corpus));
  corpus.corpus_digest = domainSeparatedDigest(
    "dolly.testament.corpus.v1", without(corpus, "corpus_digest"));
  return corpus;
}

function makeCorpusFixture() {
  const assetBytes = Buffer.from("testament-asset-bytes", "utf8");
  const context = {
    fixtureDigest: testDigest("f"),
    assetBytesByObjectRef: new Map([["object-1", assetBytes]]),
    actionArgumentSchemas: new Map([["https://schemas.example/action/v1", {
      digest: testDigest("e"),
      validate: (value) => value !== null && typeof value === "object" &&
        !Array.isArray(value) && value.message === "hello",
    }]]),
  };
  const digest = testDigest("0");
  const revisions = {
    recorder: testDigest("1"), graph: testDigest("2"), config: testDigest("3"),
    packages: testDigest("4"), models: testDigest("5"), tools: testDigest("6"),
    prompts: testDigest("7"), environment: testDigest("8"),
  };
  const block = (key, role, parts, recordedActions = []) => ({
    foreign_block_key: key,
    role,
    description: key,
    parts,
    recorded_actions: recordedActions,
    content_digest: digest,
  });
  const group = (recordKey, alias, blockKey, ordinal) => ({
    record_key: recordKey,
    source_recipient_alias: alias,
    recorded_virtual_time_us: ordinal * 1000,
    record_ordinal: ordinal,
    occurrences: [{
      foreign_block_key: blockKey,
      source_page_alias: `source-page-${ordinal}`,
      occurrence_ordinal: 0,
    }],
    source_descriptor_digest: testDigest("9"),
    source_config_digest: testDigest("a"),
  });
  const corpus = {
    schema: "dolly.testament-corpus/v1",
    semantic_validator: "org.dolly.validator.testament-corpus@1",
    corpus_id: "corpus-main",
    corpus_revision: 1,
    source_kind: "recorded",
    created_at: "2026-08-12T12:00:00.000000Z",
    source_revisions: revisions,
    authorization_digest: testDigest("b"),
    redaction_policy_digest: testDigest("c"),
    retention_policy_digest: testDigest("d"),
    security_domain: "testament-domain",
    blocks: [
      block("block-a", "stimulus", [
        {kind: "text", text: "alpha", format: "plain"},
        {kind: "block_ref", foreign_block_key: "block-evidence", relation: "evidence"},
      ], [{
        source_action_key: "action-a",
        ordinal: 0,
        name: "org.example.testament.action.send",
        arguments_schema: {
          uri: "https://schemas.example/action/v1",
          schema_digest: testDigest("e"),
        },
        source_target_alias: "target-source-a",
        side_effect_class: "non_idempotent_write",
        arguments: {message: "hello"},
      }]),
      block("block-b", "stimulus", [{kind: "text", text: "beta", format: "plain"}]),
      block("block-c", "stimulus", [
        {kind: "asset", foreign_asset_key: "asset-1", media_type: "text/plain", view: null},
      ]),
      block("block-d", "stimulus", [{kind: "text", text: "delta", format: "plain"}]),
      block("block-evidence", "demonstration", [{kind: "text", text: "evidence", format: "plain"}]),
      block("block-oracle", "oracle_only", [{kind: "text", text: "answer", format: "plain"}]),
    ],
    assets: [{
      foreign_asset_key: "asset-1",
      object_ref: "object-1",
      byte_length: 0,
      content_digest: digest,
      media_type: "text/plain",
      security_domain: "testament-domain",
    }],
    input_groups: [
      group("record-a", "source-a", "block-a", 1),
      group("record-b", "source-b", "block-b", 2),
      group("record-c", "source-c", "block-c", 3),
      group("record-d", "source-d", "block-d", 4),
    ],
    splits: {
      train: {record_keys: ["record-a", "record-b"], digest},
      development: {record_keys: ["record-c"], digest},
      held_out: {record_keys: ["record-d"], digest},
    },
    fixture_manifest: {
      bundle_digest: context.fixtureDigest,
      entries: [{
        fixture_key: "fixture-a",
        fixture_digest: testDigest("d"),
        role: "demonstration",
        oracle_only: false,
        block_keys: ["block-a"],
        asset_keys: [],
        action_keys: ["action-a"],
      }],
    },
    inventory_digest: digest,
    corpus_digest: digest,
  };
  return {corpus: sealCorpus(corpus, context), context};
}

function sealPlan(plan) {
  plan.plan_digest = domainSeparatedDigest(
    "dolly.testament.replay-plan.v1", without(plan, "plan_digest"));
  return plan;
}

function makeFilterDecisionFixture() {
  const instanceId = "instance-main";
  const signalSchemaUri =
    "https://dolly.example/spec/0.1/schemas/filter-signal.schema.json";
  const assetId = `ast_b3_${"a".repeat(52)}`;
  const assetView = {kind: "image_rect_v1", x0: 100000, y0: 100000, x1: 900000, y1: 900000};
  const referencedBlockId = testUuid(450);
  const config = {
    schema: "dolly.filter-config/v1",
    signal_channel: "default",
    state_epoch: "epoch-main",
    new_sample_weight_ppm: 1000000,
    bias_correction: true,
    candidate_scope: "manifest_present_sources",
    self_source_policy: "ignore",
    tie_break: "source_identity_jcs_utf8",
    copy_description: true,
    copy_block_refs: true,
    copy_json_parts: false,
    copy_metadata: false,
    copy_research_hints: false,
    max_tracked_sources: 4096,
    max_observation_ledger_entries: 100000,
    max_output_parts: 64,
    max_output_bytes: 1048576,
  };
  const preparedOutput = {
    status: "success",
    output: {
      schema: "dolly.block-draft/v1",
      description: "selected expert projection",
      parts: [
        {kind: "text", text: "answer", format: "plain"},
        {kind: "asset", asset_id: assetId, media_type: "image/png", view: clone(assetView)},
        {kind: "block_ref", block_id: referencedBlockId, relation: "evidence"},
        {
          kind: "json",
          schema_uri: signalSchemaUri,
          value: {schema: "dolly.filter-signal/v1", channel: "default", score: 200},
        },
      ],
      actions: [], metadata: {}, hints: {},
    },
    scheduling_hint: null,
    error: null,
  };
  const candidates = [
    ["expert-a", 401, 200000000, 900000000],
    ["expert-b", 402, 400000000, 900000000],
    ["expert-c", 403, 750000000, 4050000000],
  ].map(([source, suffix, score, distance]) => ({
    instance_id: instanceId,
    source_module_id: source,
    tie_break_key: canonicalJson([instanceId, source, "default"]),
    selected_input_block_id: testUuid(suffix),
    accumulator: score,
    weight: 1000000,
    corrected_score_q: score,
    distance,
  }));
  const beforeState = {
    algorithm_revision: "two-thirds-mean-filter-v1",
    internal_scale: 1000000,
    bias_correction: true,
    sources: [],
  };
  const afterState = {
    algorithm_revision: "two-thirds-mean-filter-v1",
    internal_scale: 1000000,
    bias_correction: true,
    sources: candidates.map((candidate) => ({
      instance_id: candidate.instance_id,
      source_module_id: candidate.source_module_id,
      accumulator: candidate.accumulator,
      weight: candidate.weight,
      observation_count: 1,
    })),
  };
  const decision = {
    schema: "dolly.filter-decision/v1",
    activation_id: testUuid(400),
    manifest_digest: testDigest("1"),
    config_revision: 1,
    config_digest: genericCanonicalDigest(config),
    config_schema_digest: testDigest("5"),
    algorithm_revision: "two-thirds-mean-filter-v1",
    storage_scope_id: testUuid(499),
    channel: "default",
    state_epoch: "epoch-main",
    before_state: beforeState,
    after_state: afterState,
    before_state_digest: testDigest("2"),
    after_state_digest: testDigest("3"),
    observations: candidates.map((candidate, index) => ({
      instance_id: instanceId,
      source_module_id: candidate.source_module_id,
      source_block_id: candidate.selected_input_block_id,
      channel: "default",
      manifest_ordinal: index,
      disposition: "applied",
      applied_score: candidate.corrected_score_q / 1000000,
      projection_eligible: true,
    })),
    candidates,
    selected_source_module_id: "expert-a",
    selected_instance_id: instanceId,
    selected_input_block_id: testUuid(401),
    output_payload: preparedOutput,
    output_digest: genericCanonicalDigest(preparedOutput),
    state: "prepared",
  };
  decision.before_state_digest = filterAccumulatorStateDigest(decision, beforeState);
  decision.after_state_digest = filterAccumulatorStateDigest(decision, afterState);

  const makeTrustedBlock = (candidate, ordinal) => {
    const selected = candidate.source_module_id === "expert-a";
    const score = candidate.corrected_score_q / 1000000;
    const parts = selected ? [
      {kind: "text", text: "answer", format: "plain"},
      {kind: "json", schema_uri: "https://schemas.example/content/v1", value: {drop: "all JSON"}},
      {
        kind: "json", schema_uri: signalSchemaUri,
        value: {schema: "dolly.filter-signal/v1", channel: "default", score},
      },
      {kind: "asset", asset_id: assetId, media_type: "image/png", view: clone(assetView)},
      {kind: "block_ref", block_id: referencedBlockId, relation: "evidence"},
    ] : [
      {kind: "text", text: `answer from ${candidate.source_module_id}`, format: "plain"},
      {
        kind: "json", schema_uri: signalSchemaUri,
        value: {schema: "dolly.filter-signal/v1", channel: "default", score},
      },
    ];
    const block = {
      schema: "dolly.block/v1",
      id: candidate.selected_input_block_id,
      created_at: `2026-08-12T12:00:0${ordinal}.000000Z`,
      creation_commit_seq: ordinal + 1,
      producer: {kind: "module", instance_id: instanceId, module_id: candidate.source_module_id},
      trace: {
        trace_id: testUuid(460 + ordinal),
        root_trace_ids: [testUuid(470 + ordinal)],
        causal_parents: [],
        hop_count: 0,
      },
      body: {
        description: selected ? "selected expert projection" : candidate.source_module_id,
        parts,
        actions: selected ? [{
          action_id: testUuid(480),
          name: "org.example.source.action",
          arguments: {ignored: true},
        }] : [],
        metadata: selected ? {"org.example.source": {ignored: true}} : {},
        hints: selected ? {"org.example.hint": {
          version: 1,
          schema_uri: "https://schemas.example/hint/v1",
          schema_digest: testDigest("a"),
          experiment_id: "filter-output",
          payload: {ignored: true},
        }} : {},
      },
      body_digest: testDigest("0"),
      envelope_digest: testDigest("0"),
    };
    block.body_digest = genericCanonicalDigest(block.body);
    block.envelope_digest = genericCanonicalDigest(without(block, "envelope_digest"));
    return block;
  };
  const trustedBlocks = candidates.map(makeTrustedBlock);
  return {
    decision,
    context: {
      instanceId,
      preparedOutput,
      config,
      configSchemaDigest: testDigest("5"),
      trustedStorageScopeId: decision.storage_scope_id,
      trustedManifestDigest: decision.manifest_digest,
      committedBeforeState: clone(beforeState),
      committedBeforeStateDigest: decision.before_state_digest,
      trustedObservations: clone(decision.observations),
      trustedManifestBlocks: new Map(trustedBlocks.map((block) => [block.id, block])),
      trustedManifestBlockDigests: new Map(trustedBlocks.map((block) => [block.id, block.envelope_digest])),
      authorizedAssets: new Map([[assetId, {
        media_type: "image/png", allowed_views: [clone(assetView)],
      }]]),
      authorizedBlockRefs: new Map([[referencedBlockId, ["evidence"]]]),
    },
  };
}

function makePlanFixture(corpus) {
  const mapping = (alias, number, targets = 1) => ({
    source_recipient_alias: alias,
    targets: Array.from({length: targets}, (_, index) => ({
      treatment_id: `treatment-${number}-${index + 1}`,
      sandbox_id: `sandbox-${number}-${index + 1}`,
      target_module_id: `target-${number}-${index + 1}`,
      replay_page_id: `replay-page-${number}-${index + 1}`,
    })),
    fanout_mode: "independent_clones",
    state_isolation: "fresh",
    transform_profile: "strict-portable",
    transform_revision_digest: testDigest(String(number)),
    action_rules: alias === "source-a" ? [{
      source_action_key: "action-a",
      policy: "strip_and_record",
      fixture_key: null,
      fixture_digest: null,
      adapter_digest: null,
      target_action_alias: null,
    }] : [],
    missing_reference_policy: "strict",
  });
  return sealPlan({
    schema: "dolly.testament-replay-plan/v1",
    semantic_validator: "org.dolly.validator.testament-replay-plan@1",
    run_id: testUuid(701),
    mode: "portable_semantic_replay",
    corpus_digest: corpus.corpus_digest,
    source_backup_manifest_digest: null,
    sandbox_template_digest: testDigest("e"),
    mappings: [
      mapping("source-a", 1), mapping("source-b", 2, 2),
      mapping("source-c", 3), mapping("source-d", 4),
    ],
    clock: {mode: "event_driven", scale_numerator: 1, scale_denominator: 1},
    scheduler: "normal_graph",
    scheduler_config: null,
    budgets: {
      activations: 100, blocks: 100, model_calls: 0, tool_calls: 0, tokens: 0,
      cost_microunits: 0, virtual_time_us: 1000000, wall_seconds: 60,
      network_bytes: 0, disk_bytes: 1048576, memory_bytes: 1048576,
    },
    network_policy: "deny_all",
    external_effect_policy: "deny",
    seeds: [1],
    stop_conditions: ["budget-exhausted"],
    plan_digest: testDigest("0"),
  });
}

function makeLevelShareFixture(peerId) {
  return {
    schema: "dolly.levelupper-share-config/v1",
    semantic_validator: "org.dolly.validator.levelupper-share@1",
    node_display_name: "local-node",
    minimum_protocol_version: 1,
    network_broker_grant: "org.dolly.levelupper-network",
    peers: [{
      peer_id: peerId,
      node_display_name: "remote-node",
      transport_role: "both",
      endpoints: ["wss://relay.example/ws"],
      credential_ref: "secret://levelupper/peer-a",
      allowed_share_ids: ["share-main"],
    }],
    shares: [{
      share_id: "share-main",
      share_revision: 1,
      peer_id: peerId,
      directions: [
        {direction_id: "export-main", kind: "export", local_page_ids: ["page-export"], remote_stream_labels: ["outbound"], source_alias: "local-source"},
        {direction_id: "import-main", kind: "import", local_page_ids: ["page-import"], remote_stream_labels: ["inbound"], source_alias: "remote-source"},
      ],
      content_policy: "portable_parts",
      metadata_policy: "strip",
      action_policy: "strip_and_record",
      asset_policy: "authorized_transfer",
      reference_policy: "strict",
      ordering: "strict",
      hop_limit: 8,
      limits: {
        max_backlog_items: 1000,
        max_backlog_bytes: 1048576,
        max_backlog_age_seconds: 3600,
        max_batch_items: 16,
        max_frame_bytes: 65536,
        max_asset_bytes: 1048576,
        max_in_flight_bytes: 1048576,
        max_outstanding_requests: 32,
      },
    }],
  };
}

function sealLevelContent(content) {
  content.content_digest = domainSeparatedDigest(
    "dolly.levelupper.content.v1", without(content, "content_digest"));
  return content;
}

function makeLevelContentFixture() {
  return sealLevelContent({
    schema: "dolly.levelupper-portable-block/v1",
    semantic_validator: "org.dolly.validator.levelupper-content@1",
    foreign_block_key: "foreign-block-1",
    source_alias: "remote-source",
    description: "portable content",
    parts: [
      {kind: "text", text: "hello", format: "plain", language: "en"},
      {
        kind: "json", value: {signal: 7}, schema_uri: "https://schemas.example/signal/v1",
        schema_digest: testDigest("7"),
      },
      {
        kind: "asset", foreign_asset_key: "foreign-asset-1", content_digest: testDigest("8"),
        byte_length: 100, media_type: "image/png", view: null,
      },
    ],
    content_digest: testDigest("0"),
  });
}

function sealLevelEntry(entry) {
  entry.entry_hash = levelUpperEntryHash(entry) ?? testDigest("0");
  return entry;
}

function makeLevelEntryFixture(peerId, contentDigest, exportSeq = 1, previous = null) {
  return sealLevelEntry({
    schema: "dolly.levelupper-entry-envelope/v1",
    semantic_validator: "org.dolly.validator.levelupper-entry@1",
    foreign_entry_key: `foreign-entry-${exportSeq}`,
    foreign_block_key: "foreign-block-1",
    share_id: "share-main",
    share_revision: 1,
    direction_id: "export-main",
    share_epoch_id: testUuid(801),
    export_seq: exportSeq,
    origin: {
      origin_peer_id: peerId,
      origin_direction_id: "export-main",
      origin_share_epoch_id: testUuid(801),
      origin_entry_key: `foreign-entry-${exportSeq}`,
      visited_peer_path: [peerId],
      hop_count: 1,
      hop_limit: 8,
    },
    content_digest: contentDigest,
    previous_entry_hash: previous,
    entry_hash: testDigest("0"),
  });
}

function sealLevelFrame(frame) {
  frame.frame_digest = levelUpperFrameDigest(frame);
  return frame;
}

function makeLevelFrameFixture(peerId, entry) {
  return sealLevelFrame({
    schema: "dolly.levelupper-wire-control/v1",
    semantic_validator: "org.dolly.validator.levelupper-wire@1",
    protocol_version: 1,
    link_session_id: testUuid(802),
    connection_epoch: 1,
    sender_peer_id: peerId,
    message_id: testUuid(803),
    body: {
      kind: "portable_entry",
      share: {
        share_id: entry.share_id,
        share_revision: entry.share_revision,
        direction_id: entry.direction_id,
        share_epoch_id: entry.share_epoch_id,
      },
      entry,
    },
    frame_digest: testDigest("0"),
  });
}

function makeLevelControlFrame(peerId, body, suffix = 820) {
  return sealLevelFrame({
    schema: "dolly.levelupper-wire-control/v1",
    semantic_validator: "org.dolly.validator.levelupper-wire@1",
    protocol_version: 1,
    link_session_id: testUuid(suffix),
    connection_epoch: 1,
    sender_peer_id: peerId,
    message_id: testUuid(suffix + 1),
    body,
    frame_digest: testDigest("0"),
  });
}

function makeNegotiationFixture(peerId, remotePeerId, assetShare) {
  const localLimits = {
    max_frame_bytes: 65536,
    max_batch_entries: 32,
    max_in_flight_bytes: 1048576,
    max_asset_bytes: 1048576,
    max_asset_chunk_bytes: 65536,
    max_outstanding_requests: 64,
  };
  const peerLimits = {
    max_frame_bytes: 32768,
    max_batch_entries: 16,
    max_in_flight_bytes: 524288,
    max_asset_bytes: 524288,
    max_asset_chunk_bytes: 32768,
    max_outstanding_requests: 32,
  };
  const configuredLimits = {
    max_frame_bytes: 49152,
    max_batch_entries: 20,
    max_in_flight_bytes: 786432,
    max_asset_bytes: 786432,
    max_asset_chunk_bytes: 49152,
    max_outstanding_requests: 48,
  };
  const effectiveLimits = Object.fromEntries(Object.keys(localLimits).map((key) =>
    [key, Math.min(localLimits[key], peerLimits[key], configuredLimits[key])]));
  const negotiation = {
    local_min: 1,
    local_max: 3,
    peer_min: 2,
    peer_max: 4,
    configured_min: 2,
    local_limits: localLimits,
    peer_limits: peerLimits,
    configured_limits: configuredLimits,
    hello_frame_digests: [testDigest("1"), testDigest("2")],
    peer_ids: [peerId, remotePeerId],
  };
  const digest = levelUpperNegotiationDigest({
    hello_frame_digests: negotiation.hello_frame_digests,
    peer_ids: negotiation.peer_ids,
    protocol_version: 3,
    effective_limits: effectiveLimits,
  });
  const frame = makeLevelControlFrame(peerId, {
    kind: "open_share",
    share: assetShare,
    direction: "export",
    effective_limits: effectiveLimits,
    policy_digest: testDigest("3"),
    negotiation_transcript_digest: digest,
  }, 815);
  frame.protocol_version = 3;
  sealLevelFrame(frame);
  return {frame, context: {authenticatedPeerId: peerId, negotiation}};
}

function encodeLevelUpperBinaryChunk(fields) {
  const shareId = Buffer.from(fields.share_id, "utf8");
  const directionId = Buffer.from(fields.direction_id, "utf8");
  const assetKey = Buffer.from(fields.foreign_asset_key, "utf8");
  const shareLength = Buffer.alloc(2);
  shareLength.writeUInt16BE(shareId.length);
  const assetLength = Buffer.alloc(2);
  assetLength.writeUInt16BE(assetKey.length);
  const directionLength = Buffer.alloc(2);
  directionLength.writeUInt16BE(directionId.length);
  const protocol = Buffer.alloc(2);
  protocol.writeUInt16BE(fields.protocol_version);
  const connectionEpoch = Buffer.alloc(8);
  connectionEpoch.writeBigUInt64BE(BigInt(fields.connection_epoch));
  const shareRevision = Buffer.alloc(8);
  shareRevision.writeBigUInt64BE(BigInt(fields.share_revision));
  const offset = Buffer.alloc(8);
  offset.writeBigUInt64BE(BigInt(fields.offset));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(fields.chunk.length);
  return Buffer.concat([
    Buffer.from("DLYLUA01", "ascii"), protocol, rawUuid(fields.link_session_id),
    connectionEpoch, rawDigest(fields.sender_peer_id), rawUuid(fields.message_id),
    shareRevision, shareLength, shareId, directionLength, directionId,
    rawUuid(fields.share_epoch_id), assetLength,
    assetKey, offset, length, rawDigest(sha256Bytes(fields.chunk)), fields.chunk,
  ]);
}

function assertAccepted(label, validator, value, context) {
  const errors = validator(value, context);
  if (errors.length > 0) throw new Error(`${label}: expected acceptance; ${errors.join("; ")}`);
}

function assertRejected(label, validator, value, context, fragment) {
  const errors = validator(value, context);
  if (errors.length === 0) throw new Error(`${label}: expected rejection`);
  if (fragment && !errors.some((error) => error.includes(fragment))) {
    throw new Error(`${label}: expected diagnostic containing ${JSON.stringify(fragment)}; ${errors.join("; ")}`);
  }
}

function validateDeclarativeCoverageVectors() {
  const errors = [];
  const vectorSchemaId = "https://dolly.example/spec/0.1/test-vectors/vector.schema.json";
  // The independent validator normally loads only schemas/.  Load the common
  // vector shape explicitly so this coverage assertion cannot silently accept
  // malformed declarative evidence.
  if (!ajv.getSchema(vectorSchemaId)) {
    ajv.addSchema(JSON.parse(fs.readFileSync(
      path.join(root, "test-vectors", "vector.schema.json"), "utf8")));
  }
  const levelPath = path.join(root, "test-vectors", "research",
    "TST-LEVEL-003-semantic-wire-and-asset-boundaries.json");
  if (!fs.existsSync(levelPath)) return ["TST-LEVEL-003 declarative vector is missing"];
  const vector = JSON.parse(fs.readFileSync(levelPath, "utf8"));
  errors.push(...schemaErrors(vectorSchemaId, vector));
  const requiredCovers = Array.from({length: 6}, (_, index) =>
    `REQ-LEVELUPPER-00${index + 1}`);
  for (const requirement of requiredCovers) if (!vector.covers.includes(requirement)) {
    errors.push(`TST-LEVEL-003 does not cover ${requirement}`);
  }
  const requiredCases = [
    "share.endpoint_credentials",
    "share.endpoint_query",
    "share.endpoint_fragment",
    "share.duplicate_peer_id",
    "share.duplicate_share_id",
    "share.duplicate_direction",
    "share.duplicate_direction_id",
    "share.page_direction_alias",
    "share.unauthorized_peer_share",
    "activation.wrong_fenced_replay_descriptor",
    "content.digest_mismatch",
    "entry.previous_hash_mismatch",
    "entry.hop_path_mismatch",
    "entry.hash_mismatch",
    "wire.outer_nested_share_mismatch",
    "wire.sender_path_mismatch",
    "wire.frame_digest_mismatch",
    "wire.unretained_content_digest",
    "wire.protocol_downgrade",
    "wire.negotiation_transcript_mismatch",
    "wire.effective_limit_mismatch",
    "wire.flow_credit_conflicting_repeat",
    "wire.flow_credit_stale_revision",
    "wire.checkpoint_zero_hash_mismatch",
    "wire.ack_not_continuous_high_water",
    "wire.ack_above_sender_high_water",
    "wire.nack_advances_high_water",
    "storage.same_peer_share_cross_scope_ack",
    "storage.same_peer_share_cross_scope_pin",
    "storage.same_peer_share_cross_scope_broker_handle",
    "asset.offer_content_metadata_mismatch",
    "asset.request_ranges_unsorted",
    "asset.request_ranges_overlap",
    "asset.request_range_out_of_offer",
    "asset.request_count_over_limit",
    "asset.complete_inexact_coverage",
    "asset.binary_cross_session_replay",
    "asset.binary_unsolicited_range",
    "asset.binary_conflicting_overlap",
  ];
  const actualCases = new Set(vector.initial?.semantic_negative_cases ?? []);
  for (const name of requiredCases) if (!actualCases.has(name)) {
    errors.push(`TST-LEVEL-003 omits semantic negative case ${name}`);
  }
  const filterPath = path.join(root, "test-vectors", "extensions",
    "TST-FILTER-004-latest-eligible-multiblock.json");
  if (!fs.existsSync(filterPath)) {
    errors.push("TST-FILTER-004 declarative vector is missing");
  } else {
    const filterVector = JSON.parse(fs.readFileSync(filterPath, "utf8"));
    errors.push(...schemaErrors(vectorSchemaId, filterVector));
    const names = new Set((filterVector.initial?.cases ?? []).map((item) => item.name));
    for (const name of ["valid_then_malformed", "valid_then_oversize", "malformed_then_valid"]) {
      if (!names.has(name)) errors.push(`TST-FILTER-004 omits multi-Block ordering case ${name}`);
    }
  }
  const filterFencePath = path.join(root, "test-vectors", "extensions",
    "TST-FILTER-005-state-header-config-fence.json");
  if (!fs.existsSync(filterFencePath)) {
    errors.push("TST-FILTER-005 declarative vector is missing");
  } else {
    const filterFence = JSON.parse(fs.readFileSync(filterFencePath, "utf8"));
    errors.push(...schemaErrors(vectorSchemaId, filterFence));
  }
  const filterReplayPath = path.join(root, "test-vectors", "extensions",
    "TST-FILTER-006-decision-state-replay.json");
  if (!fs.existsSync(filterReplayPath)) {
    errors.push("TST-FILTER-006 declarative vector is missing");
  } else {
    const filterReplay = JSON.parse(fs.readFileSync(filterReplayPath, "utf8"));
    errors.push(...schemaErrors(vectorSchemaId, filterReplay));
    const replayForgeries = filterReplay.initial?.forgeries ?? [];
    if (!replayForgeries.some((item) =>
      item.kind === "derived_accumulator" && item.claimed_accumulator === 300000000)) {
      errors.push("TST-FILTER-006 does not pin the forged A=300000000 boundary");
    }
    for (const kind of [
      "committed_before_state", "trusted_observation_score", "manifest_context_substitution",
    ]) if (!replayForgeries.some((item) => item.kind === kind)) {
      errors.push(`TST-FILTER-006 omits authority forgery ${kind}`);
    }
  }
  const filterOutputPath = path.join(root, "test-vectors", "extensions",
    "TST-FILTER-007-output-reachability.json");
  if (!fs.existsSync(filterOutputPath)) {
    errors.push("TST-FILTER-007 declarative vector is missing");
  } else {
    const filterOutput = JSON.parse(fs.readFileSync(filterOutputPath, "utf8"));
    errors.push(...schemaErrors(vectorSchemaId, filterOutput));
    const outputForgeries = new Set(filterOutput.initial?.forgeries ?? []);
    for (const kind of [
      "action", "text", "description", "asset", "block_ref", "extra_json",
      "metadata", "hint", "manifest_block_substitution", "asset_authorization",
      "block_ref_authorization", "output_budget",
    ]) if (!outputForgeries.has(kind)) {
      errors.push(`TST-FILTER-007 omits output reachability forgery ${kind}`);
    }
  }
  return errors;
}

function runSelfTests() {
  let cases = 0;
  const accept = (...args) => { assertAccepted(...args); cases += 1; };
  const reject = (...args) => { assertRejected(...args); cases += 1; };

  const coverageErrors = validateDeclarativeCoverageVectors();
  if (coverageErrors.length > 0) {
    throw new Error(`declarative research coverage vectors: ${coverageErrors.join("; ")}`);
  }
  cases += 1;

  const {corpus, context: corpusContext} = makeCorpusFixture();
  accept("Testament Corpus positive", validateTestamentCorpus, corpus, corpusContext);

  let changed = clone(corpus);
  changed.blocks.push(clone(changed.blocks[0]));
  sealCorpus(changed, corpusContext);
  reject("Testament duplicate Block key", validateTestamentCorpus, changed, corpusContext, "duplicate foreign_block_key");

  changed = clone(corpus);
  changed.input_groups[0].occurrences.push(clone(changed.input_groups[0].occurrences[0]));
  sealCorpus(changed, corpusContext);
  reject("Testament duplicate occurrence", validateTestamentCorpus, changed, corpusContext, "duplicate occurrence key");

  changed = clone(corpus);
  changed.blocks[2].parts[0].foreign_asset_key = "asset-missing";
  sealCorpus(changed, corpusContext);
  reject("Testament dangling Asset", validateTestamentCorpus, changed, corpusContext, "dangling Asset");

  changed = clone(corpus);
  changed.blocks[2].parts[0].media_type = "image/png";
  sealCorpus(changed, corpusContext);
  reject("Testament Asset media binding", validateTestamentCorpus, changed,
    corpusContext, "media_type disagrees");

  changed = clone(corpus);
  changed.blocks[2].parts[0].view = {
    kind: "image_rect_v1", x0: 9, y0: 0, x1: 3, y1: 2,
  };
  sealCorpus(changed, corpusContext);
  reject("Testament invalid crop", validateTestamentCorpus, changed,
    corpusContext, "x0 < x1");

  changed = clone(corpus);
  changed.blocks[0].parts[1].foreign_block_key = "block-missing";
  sealCorpus(changed, corpusContext);
  reject("Testament dangling BlockRef", validateTestamentCorpus, changed, corpusContext, "dangling BlockRef");

  changed = clone(corpus);
  changed.splits.train.record_keys.reverse();
  sealCorpus(changed, corpusContext);
  reject("Testament unsorted split", validateTestamentCorpus, changed, corpusContext, "not ascending");

  changed = clone(corpus);
  changed.splits.held_out.record_keys = ["record-b", "record-d"];
  sealCorpus(changed, corpusContext);
  reject("Testament overlapping split", validateTestamentCorpus, changed, corpusContext, "split overlap");

  changed = clone(corpus);
  changed.splits.held_out.record_keys = ["record-c"];
  sealCorpus(changed, corpusContext);
  reject("Testament incomplete split", validateTestamentCorpus, changed, corpusContext, "not complete");

  changed = clone(corpus);
  changed.blocks.find((item) => item.foreign_block_key === "block-evidence").role = "oracle_only";
  sealCorpus(changed, corpusContext);
  reject("Testament transitive oracle closure", validateTestamentCorpus, changed, corpusContext, "oracle_only");

  changed = clone(corpus);
  changed.assets[0].object_ref = "file:production-db";
  sealCorpus(changed, corpusContext);
  reject("Testament unsafe object_ref", validateTestamentCorpus, changed, corpusContext, "unsafe corpus object_ref");

  changed = clone(corpus);
  changed.corpus_digest = testDigest("0");
  reject("Testament corpus digest", validateTestamentCorpus, changed, corpusContext, "corpus_digest mismatch");

  const plan = makePlanFixture(corpus);
  const planContext = {
    corpus,
    sandboxTemplateDigests: new Set([plan.sandbox_template_digest]),
    backupManifestDigests: new Set([testDigest("a")]),
    actionFixtureDigests: new Set(),
    actionAdapterDigests: new Set(),
  };
  accept("Testament portable plan positive", validateTestamentReplayPlan, plan, planContext);

  changed = clone(plan);
  changed.mappings[1].targets[1].sandbox_id = changed.mappings[1].targets[0].sandbox_id;
  sealPlan(changed);
  reject("Testament independent sandbox isolation", validateTestamentReplayPlan,
    changed, planContext, "independent_clones share sandbox_id");

  changed = clone(plan);
  changed.mappings.push(clone(changed.mappings[0]));
  sealPlan(changed);
  reject("Testament duplicate source mapping", validateTestamentReplayPlan,
    changed, planContext, "duplicate source mapping key");

  const clonePlan = clone(plan);
  clonePlan.mode = "full_snapshot_clone";
  clonePlan.source_backup_manifest_digest = testDigest("a");
  clonePlan.mappings = [];
  sealPlan(clonePlan);
  accept("Testament full clone positive", validateTestamentReplayPlan, clonePlan, planContext);

  changed = clone(clonePlan);
  changed.mappings = [clone(plan.mappings[0])];
  sealPlan(changed);
  reject("Testament full clone remap", validateTestamentReplayPlan,
    changed, planContext, "must not contain mappings");

  changed = clone(plan);
  changed.network_policy = "pinned_allowlist";
  changed.external_effect_policy = "pinned_research";
  sealPlan(changed);
  reject("Testament live policy default deny", validateTestamentReplayPlan,
    changed, planContext, "separate exact plan-bound authorization");
  accept("Testament exact live policy authorization", validateTestamentReplayPlan, changed, {
    ...planContext,
    livePolicyAuthorization: {
      plan_digest: changed.plan_digest,
      network_policy: changed.network_policy,
      external_effect_policy: changed.external_effect_policy,
    },
  });

  const filter = makeFilterDecisionFixture();
  accept("Filter prepared decision positive", validateFilterDecision,
    filter.decision, filter.context);
  changed = clone(filter.decision);
  changed.candidates.push({...clone(changed.candidates[0]), selected_input_block_id: testUuid(404)});
  reject("Filter candidate source uniqueness", validateFilterDecision,
    changed, filter.context, "trusted source tuple is not unique");
  changed = clone(filter.decision);
  changed.candidates.reverse();
  reject("Filter candidate canonical order", validateFilterDecision,
    changed, filter.context, "not sorted");
  changed = clone(filter.decision);
  changed.candidates[0].distance += 1;
  reject("Filter mean distance", validateFilterDecision,
    changed, filter.context, "inconsistent with the cohort mean");
  changed = clone(filter.decision);
  changed.selected_source_module_id = "expert-b";
  changed.selected_input_block_id = testUuid(402);
  reject("Filter deterministic tie winner", validateFilterDecision,
    changed, filter.context, "minimum-distance candidate");
  changed = clone(filter.decision);
  changed.selected_input_block_id = testUuid(4999);
  reject("Filter selected pair membership", validateFilterDecision,
    changed, filter.context, "not one of the candidates");
  changed = clone(filter.decision);
  changed.output_digest = testDigest("f");
  reject("Filter prepared payload digest", validateFilterDecision,
    changed, filter.context, "exact prepared canonical payload");
  changed = clone(filter.decision);
  reject("Filter config digest binding", validateFilterDecision,
    changed, {...filter.context, config: {...filter.context.config, copy_description: false}},
    "config_digest does not bind");
  changed = clone(filter.decision);
  const toggledConfig = {...filter.context.config, bias_correction: false};
  changed.config_digest = genericCanonicalDigest(toggledConfig);
  changed.candidates[0].accumulator = 100000000;
  changed.candidates[0].weight = 200000;
  reject("Filter bias-mode toggle", validateFilterDecision,
    changed, {...filter.context, config: toggledConfig},
    "corrected_score_q is inconsistent");
  changed = clone(filter.decision);
  changed.output_payload.output.parts.at(-1).value.score = 201;
  changed.output_digest = genericCanonicalDigest(changed.output_payload);
  reject("Filter normalized output score", validateFilterDecision,
    changed, filter.context, "round_half_even(q/R)");
  changed = clone(filter.decision);
  changed.observations.reverse();
  reject("Filter ordered observation replay", validateFilterDecision,
    changed, filter.context, "strictly ascending Manifest order");
  changed = clone(filter.decision);
  changed.before_state_digest = testDigest("f");
  reject("Filter prior state digest", validateFilterDecision,
    changed, filter.context, "exact prior accumulator state");

  // This forgery is internally self-consistent: candidate A/q, distances,
  // normalized output, after-state digest, and output digest are all resealed.
  // Only replaying score=200 from the exact empty prior state exposes A=300m.
  changed = clone(filter.decision);
  changed.after_state.sources[0].accumulator = 300000000;
  changed.candidates[0].accumulator = 300000000;
  changed.candidates[0].corrected_score_q = 300000000;
  const forgedSum = changed.candidates.reduce((total, candidate) =>
    total + BigInt(candidate.corrected_score_q), 0n);
  for (const candidate of changed.candidates) {
    const delta = 3n * BigInt(changed.candidates.length) *
      BigInt(candidate.corrected_score_q) - 2n * forgedSum;
    candidate.distance = Number(delta < 0n ? -delta : delta);
  }
  changed.output_payload.output.parts.at(-1).value.score = 300;
  changed.output_digest = genericCanonicalDigest(changed.output_payload);
  changed.after_state_digest = filterAccumulatorStateDigest(changed, changed.after_state);
  reject("Filter forged A=300000000", validateFilterDecision,
    changed, filter.context, "ordered observation replay from before_state");

  // A forged prior state can be made locally consistent when w=1, because the
  // next sample overwrites A/Z.  Only the Host/ledger authority comparison
  // distinguishes it from the actually committed empty state.
  changed = clone(filter.decision);
  changed.before_state.sources = [{
    instance_id: "instance-main",
    source_module_id: "expert-a",
    accumulator: 999000000,
    weight: 1000000,
    observation_count: 99,
  }];
  changed.before_state_digest = filterAccumulatorStateDigest(changed, changed.before_state);
  reject("Filter forged committed before_state", validateFilterDecision,
    changed, filter.context, "Host/ledger committed prior state");

  // Likewise, reseal every derived field around a forged score=300.  The
  // trusted Manifest/Block-derived observation sequence remains score=200.
  changed = clone(filter.decision);
  changed.observations[0].applied_score = 300;
  changed.after_state.sources[0].accumulator = 300000000;
  changed.candidates[0].accumulator = 300000000;
  changed.candidates[0].corrected_score_q = 300000000;
  const forgedObservationSum = changed.candidates.reduce((total, candidate) =>
    total + BigInt(candidate.corrected_score_q), 0n);
  for (const candidate of changed.candidates) {
    const delta = 3n * BigInt(changed.candidates.length) *
      BigInt(candidate.corrected_score_q) - 2n * forgedObservationSum;
    candidate.distance = Number(delta < 0n ? -delta : delta);
  }
  changed.output_payload.output.parts.at(-1).value.score = 300;
  changed.output_digest = genericCanonicalDigest(changed.output_payload);
  changed.after_state_digest = filterAccumulatorStateDigest(changed, changed.after_state);
  reject("Filter forged observation score", validateFilterDecision,
    changed, filter.context, "trusted Manifest/Block-derived sequence");

  changed = clone(filter.decision);
  changed.manifest_digest = testDigest("e");
  reject("Filter manifest context substitution", validateFilterDecision,
    changed, filter.context, "frozen trusted Manifest");

  // `preparedOutput` and output_digest are archival byte evidence, not semantic
  // authority.  Every mutation below is schema-valid and reseals both, yet it
  // must still fail exact reconstruction from the trusted selected Block.
  const rejectResealedFilterOutput = (name, mutate) => {
    const forged = clone(filter.decision);
    mutate(forged.output_payload.output);
    forged.output_digest = genericCanonicalDigest(forged.output_payload);
    reject(name, validateFilterDecision, forged, {
      ...filter.context,
      preparedOutput: clone(forged.output_payload),
    }, "exact v1 projection");
  };
  rejectResealedFilterOutput("Filter forged output Action", (output) => {
    output.actions.push({name: "org.example.forged.action", arguments: {}});
  });
  rejectResealedFilterOutput("Filter changed output Text", (output) => {
    output.parts[0].text = "forged answer";
  });
  rejectResealedFilterOutput("Filter changed output description", (output) => {
    output.description = "forged description";
  });
  rejectResealedFilterOutput("Filter changed output Asset", (output) => {
    output.parts[1].media_type = "image/jpeg";
  });
  rejectResealedFilterOutput("Filter changed output BlockRef", (output) => {
    output.parts[2].relation = "reply_to";
  });
  rejectResealedFilterOutput("Filter extra output JSON", (output) => {
    output.parts.splice(-1, 0, {kind: "json", value: {forged: true}});
  });
  rejectResealedFilterOutput("Filter forged output metadata", (output) => {
    output.metadata = {"org.example.forged": true};
  });
  rejectResealedFilterOutput("Filter forged output hint", (output) => {
    output.hints = {"org.example.forged": {
      version: 1,
      schema_uri: "https://schemas.example/forged-hint/v1",
      schema_digest: testDigest("f"),
      experiment_id: "forged-output",
      payload: {forged: true},
    }};
  });

  const substitutedBlocks = new Map(filter.context.trustedManifestBlocks);
  const substitutedSelected = clone(substitutedBlocks.get(testUuid(401)));
  substitutedSelected.body.parts[0].text = "substituted manifest Block";
  substitutedSelected.body_digest = genericCanonicalDigest(substitutedSelected.body);
  substitutedSelected.envelope_digest = genericCanonicalDigest(
    without(substitutedSelected, "envelope_digest"));
  substitutedBlocks.set(substitutedSelected.id, substitutedSelected);
  reject("Filter Manifest Block substitution", validateFilterDecision,
    filter.decision, {...filter.context, trustedManifestBlocks: substitutedBlocks},
    "frozen Manifest Block digest");
  reject("Filter Asset authorization substitution", validateFilterDecision,
    filter.decision, {...filter.context, authorizedAssets: new Map()},
    "Asset part 3 lacks exact authorization");
  reject("Filter BlockRef authorization substitution", validateFilterDecision,
    filter.decision, {...filter.context, authorizedBlockRefs: new Map()},
    "BlockRef part 4 lacks exact authorization");
  const undersizedConfig = {...filter.context.config, max_output_parts: 3};
  changed = clone(filter.decision);
  changed.config_digest = genericCanonicalDigest(undersizedConfig);
  reject("Filter output Part budget", validateFilterDecision,
    changed, {...filter.context, config: undersizedConfig}, "exceeds max_output_parts");

  let arithmetic = {accumulator: 0n, weight: 0n};
  arithmetic = applyFilterObservation(arithmetic, 100, 200000, true);
  if (arithmetic.accumulator !== 20000000n || arithmetic.weight !== 200000n ||
      arithmetic.corrected !== 100000000n) {
    throw new Error("TST-FILTER-001 first-observation arithmetic oracle mismatch");
  }
  arithmetic = applyFilterObservation(arithmetic, 900, 200000, true);
  if (arithmetic.accumulator !== 196000000n || arithmetic.weight !== 360000n ||
      arithmetic.corrected !== 544444444n) {
    throw new Error("TST-FILTER-001 second-observation arithmetic oracle mismatch");
  }
  let saturation = {accumulator: 0n, weight: 0n};
  for (let index = 0; index < 17336; index += 1) {
    saturation = applyFilterObservation(saturation, 1000, 7, true);
  }
  if (saturation.accumulator !== 114278232n || saturation.weight !== 114221n ||
      saturation.corrected !== 1000000000n) {
    throw new Error("TST-FILTER-003 saturation arithmetic oracle mismatch");
  }
  cases += 2;

  const stateHeader = {
    storage_scope_id: filter.decision.storage_scope_id,
    channel: "default",
    state_epoch: "epoch-main",
    algorithm_revision: "two-thirds-mean-filter-v1",
    internal_scale: 1000000,
    bias_correction: true,
    observation_count: 7,
  };
  reject("Filter populated state bias fence", validateFilterStateConfigTransition,
    stateHeader, {
      storage_scope_id: stateHeader.storage_scope_id,
      config: {...filter.context.config, bias_correction: false},
    }, "FILTER_STATE_HEADER_CONFLICT");
  accept("Filter fresh state epoch bias change", validateFilterStateConfigTransition,
    stateHeader, {
      storage_scope_id: stateHeader.storage_scope_id,
      config: {...filter.context.config, state_epoch: "epoch-fresh", bias_correction: false},
    });

  const peerId = testDigest("a");
  const share = makeLevelShareFixture(peerId);
  accept("LevelUpper share positive", validateLevelUpperShare, share);
  accept("LevelUpper fixed Activation descriptor", validateLevelUpperActivationDescriptor,
    clone(levelUpperActivationReplayDescriptor));
  changed = clone(levelUpperActivationReplayDescriptor);
  changed.ledger.namespace = "org.example.unsafe-ledger";
  reject("LevelUpper wrong Activation descriptor", validateLevelUpperActivationDescriptor,
    changed, undefined, "fixed fenced_replay");

  for (const [label, endpoint, fragment] of [
    ["credentials", "wss://user:pass@relay.example/ws", "contains credentials"],
    ["query", "wss://relay.example/ws?token=x", "contains query"],
    ["fragment", "wss://relay.example/ws#secret", "contains a fragment"],
  ]) {
    changed = clone(share);
    changed.peers[0].endpoints = [endpoint];
    reject(`LevelUpper endpoint ${label}`, validateLevelUpperShare, changed, undefined, fragment);
  }

  changed = clone(share);
  changed.peers[0].endpoints.push("wss://RELAY.EXAMPLE:443/ws");
  reject("LevelUpper canonical endpoint duplicate", validateLevelUpperShare,
    changed, undefined, "canonically duplicate endpoint");

  changed = clone(share);
  changed.peers.push(clone(changed.peers[0]));
  reject("LevelUpper duplicate peer", validateLevelUpperShare, changed, undefined, "duplicate peer_id");

  changed = clone(share);
  changed.shares.push(clone(changed.shares[0]));
  reject("LevelUpper duplicate share", validateLevelUpperShare, changed, undefined, "duplicate share_id");

  changed = clone(share);
  changed.shares[0].directions[1].kind = "export";
  reject("LevelUpper duplicate direction", validateLevelUpperShare, changed, undefined, "repeats export direction");

  changed = clone(share);
  changed.shares[0].directions[1].direction_id = "export-main";
  reject("LevelUpper duplicate direction identity", validateLevelUpperShare,
    changed, undefined, "repeats direction_id");

  changed = clone(share);
  changed.shares[0].directions[1].local_page_ids = ["page-export"];
  reject("LevelUpper Page direction alias", validateLevelUpperShare, changed, undefined, "aliases Page");

  changed = clone(share);
  changed.peers[0].allowed_share_ids = ["share-other"];
  reject("LevelUpper unauthorized share", validateLevelUpperShare, changed, undefined, "not authorized by peer");

  const content = makeLevelContentFixture();
  const contentContext = {
    maxAssetBytes: 1024,
    schemaDigests: new Map([["https://schemas.example/signal/v1", testDigest("7")]]),
  };
  accept("LevelUpper content positive", validateLevelUpperContent, content, contentContext);
  changed = clone(content);
  changed.description = "tampered";
  reject("LevelUpper content digest", validateLevelUpperContent, changed, contentContext, "content_digest mismatch");
  changed = clone(content);
  changed.parts[2].view = {kind: "image_rect_v1", x0: 9, y0: 0, x1: 3, y1: 2};
  sealLevelContent(changed);
  reject("LevelUpper invalid crop", validateLevelUpperContent, changed,
    contentContext, "x0 < x1");

  const entry1 = makeLevelEntryFixture(peerId, content.content_digest);
  accept("LevelUpper first entry positive", validateLevelUpperEntry, entry1, {});
  const entry2 = makeLevelEntryFixture(peerId, content.content_digest, 2, entry1.entry_hash);
  const priorKey = canonicalJson([
    entry2.share_id, entry2.direction_id, entry2.share_epoch_id, 1,
  ]);
  const entryContext = {previousEntryHashes: new Map([[priorKey, entry1.entry_hash]])};
  accept("LevelUpper chained entry positive", validateLevelUpperEntry, entry2, entryContext);

  changed = clone(entry2);
  changed.previous_entry_hash = testDigest("b");
  sealLevelEntry(changed);
  reject("LevelUpper exact previous hash", validateLevelUpperEntry,
    changed, entryContext, "exact prior checkpoint");

  changed = clone(entry2);
  changed.origin.hop_count = 2;
  sealLevelEntry(changed);
  reject("LevelUpper hop/path", validateLevelUpperEntry, changed, entryContext, "hop_count does not equal");

  changed = clone(entry2);
  changed.entry_hash = testDigest("c");
  reject("LevelUpper entry digest", validateLevelUpperEntry, changed, entryContext, "entry_hash mismatch");

  const frame = makeLevelFrameFixture(peerId, entry2);
  const wireContext = {
    authenticatedPeerId: peerId,
    retainedContentDigests: new Set([content.content_digest]),
    previousEntryHashes: entryContext.previousEntryHashes,
  };
  accept("LevelUpper wire positive", validateLevelUpperWire, frame, wireContext);

  changed = clone(frame);
  changed.body.share.share_revision = 2;
  sealLevelFrame(changed);
  reject("LevelUpper outer/nested share binding", validateLevelUpperWire,
    changed, wireContext, "outer and nested");

  changed = clone(frame);
  changed.sender_peer_id = testDigest("b");
  sealLevelFrame(changed);
  reject("LevelUpper sender/path binding", validateLevelUpperWire,
    changed, {...wireContext, authenticatedPeerId: testDigest("b")}, "final visited peer");

  changed = clone(frame);
  changed.frame_digest = testDigest("d");
  reject("LevelUpper frame digest", validateLevelUpperWire, changed, wireContext, "frame_digest mismatch");

  reject("LevelUpper retained content binding", validateLevelUpperWire, frame,
    {...wireContext, retainedContentDigests: new Set()}, "not retained");

  const assetShare = {
    share_id: "share-main",
    share_revision: 1,
    direction_id: "export-main",
    share_epoch_id: testUuid(801),
  };
  const remotePeerId = testDigest("d");
  const negotiationFixture = makeNegotiationFixture(peerId, remotePeerId, assetShare);
  accept("LevelUpper open-share negotiation positive", validateLevelUpperWire,
    negotiationFixture.frame, negotiationFixture.context);
  changed = clone(negotiationFixture.frame);
  changed.protocol_version = 2;
  sealLevelFrame(changed);
  reject("LevelUpper protocol downgrade", validateLevelUpperWire,
    changed, negotiationFixture.context, "highest mutually supported");
  changed = clone(negotiationFixture.frame);
  changed.body.negotiation_transcript_digest = testDigest("e");
  sealLevelFrame(changed);
  reject("LevelUpper negotiation transcript", validateLevelUpperWire,
    changed, negotiationFixture.context, "negotiation_transcript_digest mismatch");
  changed = clone(negotiationFixture.frame);
  changed.body.effective_limits.max_batch_entries += 1;
  sealLevelFrame(changed);
  reject("LevelUpper negotiated limit minimum", validateLevelUpperWire,
    changed, negotiationFixture.context, "effective_limits do not equal");

  const flowFrame = makeLevelControlFrame(peerId, {
    kind: "flow_control",
    share: assetShare,
    credit_revision: 2,
    credit_bytes: 4096,
    credit_entries: 4,
  }, 817);
  const flowKey = canonicalJson([
    flowFrame.connection_epoch, assetShare.share_id,
    assetShare.direction_id, assetShare.share_epoch_id,
  ]);
  const flowContext = {
    authenticatedPeerId: peerId,
    flowState: new Map([[flowKey, {
      credit_revision: 2, credit_bytes: 4096, credit_entries: 4,
    }]]),
  };
  accept("LevelUpper byte-identical flow repeat", validateLevelUpperWire,
    flowFrame, flowContext);
  changed = clone(flowFrame);
  changed.body.credit_bytes = 8192;
  sealLevelFrame(changed);
  reject("LevelUpper conflicting flow revision", validateLevelUpperWire,
    changed, flowContext, "conflicting absolute grants");
  changed = clone(flowFrame);
  changed.body.credit_revision = 1;
  sealLevelFrame(changed);
  reject("LevelUpper stale flow revision", validateLevelUpperWire,
    changed, flowContext, "older than retained state");

  const storageTenant = {
    daemon_installation_id: testUuid(840),
    instance_id: "instance-one",
    storage_scope_id: testUuid(841),
  };
  accept("LevelUpper storage tenant positive", validateLevelUpperStorageAuthority,
    {kind: "ack", tenant: storageTenant}, {
      expectedTenant: storageTenant, authorizedHandleTenant: storageTenant,
    });
  reject("LevelUpper wrong-scope ACK", validateLevelUpperStorageAuthority,
    {kind: "ack", tenant: {...storageTenant, storage_scope_id: testUuid(842)}},
    {expectedTenant: storageTenant, authorizedHandleTenant: storageTenant},
    "wrong storage tenant scope");
  reject("LevelUpper wrong-scope pin handle", validateLevelUpperStorageAuthority,
    {kind: "pin", tenant: storageTenant}, {
      expectedTenant: storageTenant,
      authorizedHandleTenant: {...storageTenant, storage_scope_id: testUuid(843)},
    }, "issued to a different storage tenant scope");
  reject("LevelUpper wrong-scope Broker handle", validateLevelUpperStorageAuthority,
    {kind: "broker", tenant: storageTenant}, {
      expectedTenant: storageTenant,
      authorizedHandleTenant: {...storageTenant, instance_id: "instance-two"},
    }, "issued to a different storage tenant scope");

  const checkpoint = makeLevelControlFrame(peerId, {
    kind: "resume_checkpoint",
    share: assetShare,
    export_seq: 0,
    entry_hash: null,
  }, 844);
  accept("LevelUpper empty continuous checkpoint", validateLevelUpperWire,
    checkpoint, {
      authenticatedPeerId: peerId,
      continuousCheckpoint: {export_seq: 0, entry_hash: null},
    });
  changed = clone(checkpoint);
  changed.body.entry_hash = testDigest("9");
  sealLevelFrame(changed);
  reject("LevelUpper zero checkpoint hash", validateLevelUpperWire,
    changed, {authenticatedPeerId: peerId}, "seq=0 iff");

  const ack = makeLevelControlFrame(peerId, {
    kind: "entry_ack",
    share: assetShare,
    foreign_entry_key: entry2.foreign_entry_key,
    export_seq: entry2.export_seq,
    entry_hash: entry2.entry_hash,
    code: "LOCALLY_COMMITTED",
  }, 846);
  const ackContext = {
    authenticatedPeerId: peerId,
    continuousCheckpoint: {export_seq: entry2.export_seq, entry_hash: entry2.entry_hash},
    senderDurableHighWater: entry2.export_seq,
  };
  accept("LevelUpper exact continuous ACK", validateLevelUpperWire, ack, ackContext);
  reject("LevelUpper ACK above sender high-water", validateLevelUpperWire,
    ack, {...ackContext, senderDurableHighWater: 1}, "exceeds the sender");
  reject("LevelUpper ACK not continuous", validateLevelUpperWire,
    ack, {...ackContext, continuousCheckpoint: {export_seq: 1, entry_hash: entry1.entry_hash}},
    "does not equal the durable continuous");

  const nack = makeLevelControlFrame(peerId, {
    kind: "entry_nack",
    share: assetShare,
    foreign_entry_key: entry2.foreign_entry_key,
    export_seq: entry2.export_seq,
    entry_hash: entry2.entry_hash,
    code: "SEQUENCE_GAP",
    disposition: "terminal_share_block",
  }, 848);
  reject("LevelUpper NACK cannot advance", validateLevelUpperWire,
    nack, {
      authenticatedPeerId: peerId,
      priorAcknowledgedHighWater: 1,
      proposedAcknowledgedHighWater: 2,
    }, "must not advance");
  const portableAssetPart = content.parts.find((part) => part.kind === "asset");
  const assetOffer = {
    share: assetShare,
    byte_length: portableAssetPart.byte_length,
    content_digest: portableAssetPart.content_digest,
    chunk_bytes: 1024,
  };
  const offerFrame = makeLevelControlFrame(peerId, {
    kind: "asset_offer",
    share: assetShare,
    foreign_asset_key: "foreign-asset-1",
    content_digest: assetOffer.content_digest,
    byte_length: assetOffer.byte_length,
    media_type: "image/png",
    chunk_bytes: assetOffer.chunk_bytes,
  }, 818);
  const offerContext = {
    authenticatedPeerId: peerId,
    maxAssetBytes: 1024,
    maxAssetChunkBytes: 2048,
    contentAssetManifests: new Map([["foreign-asset-1", {
      content_digest: portableAssetPart.content_digest,
      byte_length: portableAssetPart.byte_length,
      media_type: portableAssetPart.media_type,
    }]]),
  };
  accept("LevelUpper Asset offer content binding", validateLevelUpperWire,
    offerFrame, offerContext);
  changed = clone(offerFrame);
  changed.body.media_type = "image/jpeg";
  sealLevelFrame(changed);
  reject("LevelUpper Asset offer metadata mismatch", validateLevelUpperWire,
    changed, offerContext, "exactly match portable content");
  const requestFrame = makeLevelControlFrame(peerId, {
    kind: "asset_request",
    share: assetShare,
    foreign_asset_key: "foreign-asset-1",
    ranges: [{offset: 0, length: 16}, {offset: 32, length: 16}],
  });
  const assetRequestContext = {
    authenticatedPeerId: peerId,
    retainedAssetOffers: new Map([["foreign-asset-1", assetOffer]]),
    currentOutstandingRequests: 1,
    maxOutstandingRequests: 4,
    maxAssetChunkBytes: 32,
    remainingCreditBytes: 64,
  };
  accept("LevelUpper sorted bounded Asset request", validateLevelUpperWire,
    requestFrame, assetRequestContext);

  changed = clone(requestFrame);
  changed.body.ranges = [{offset: 32, length: 16}, {offset: 0, length: 16}];
  sealLevelFrame(changed);
  reject("LevelUpper unsorted Asset ranges", validateLevelUpperWire,
    changed, assetRequestContext, "not sorted");

  changed = clone(requestFrame);
  changed.body.ranges = [{offset: 0, length: 16}, {offset: 15, length: 16}];
  sealLevelFrame(changed);
  reject("LevelUpper overlapping Asset ranges", validateLevelUpperWire,
    changed, assetRequestContext, "overlap");

  changed = clone(requestFrame);
  changed.body.ranges = [{offset: 96, length: 16}];
  sealLevelFrame(changed);
  reject("LevelUpper Asset range exceeds offer", validateLevelUpperWire,
    changed, assetRequestContext, "exceeds retained offer");

  reject("LevelUpper outstanding-request bound", validateLevelUpperWire,
    requestFrame, {...assetRequestContext, currentOutstandingRequests: 4},
    "max_outstanding_requests");

  const completeFrame = makeLevelControlFrame(peerId, {
    kind: "asset_complete",
    share: assetShare,
    foreign_asset_key: "foreign-asset-1",
    content_digest: assetOffer.content_digest,
  }, 824);
  const completeContext = {
    authenticatedPeerId: peerId,
    retainedAssetOffers: new Map([["foreign-asset-1", assetOffer]]),
    stagedAssets: new Map([["foreign-asset-1", {
      exact_coverage: true,
      byte_length: portableAssetPart.byte_length,
      content_digest: assetOffer.content_digest,
    }]]),
  };
  accept("LevelUpper exact Asset completion", validateLevelUpperWire,
    completeFrame, completeContext);
  reject("LevelUpper incomplete Asset completion", validateLevelUpperWire,
    completeFrame, {
      ...completeContext,
      stagedAssets: new Map([["foreign-asset-1", {
        exact_coverage: false, byte_length: 80, content_digest: assetOffer.content_digest,
      }]]),
    }, "exact durable interval coverage");

  const chunkFields = {
    protocol_version: 1,
    link_session_id: testUuid(830),
    connection_epoch: 3,
    sender_peer_id: peerId,
    message_id: testUuid(831),
    share_id: "share-main",
    share_revision: 1,
    direction_id: "export-main",
    share_epoch_id: testUuid(801),
    foreign_asset_key: "foreign-asset-1",
    offset: 8,
    chunk: Buffer.from("asset-chunk", "utf8"),
  };
  const binaryChunk = encodeLevelUpperBinaryChunk(chunkFields);
  const binaryContext = {
    protocol_version: chunkFields.protocol_version,
    link_session_id: chunkFields.link_session_id,
    connection_epoch: chunkFields.connection_epoch,
    authenticated_peer_id: chunkFields.sender_peer_id,
    message_id: chunkFields.message_id,
    share: {
      share_id: chunkFields.share_id,
      share_revision: chunkFields.share_revision,
      direction_id: chunkFields.direction_id,
      share_epoch_id: chunkFields.share_epoch_id,
    },
    foreign_asset_key: chunkFields.foreign_asset_key,
    requested_ranges: [{offset: 0, length: 64}],
    offer_byte_length: portableAssetPart.byte_length,
    max_asset_chunk_bytes: 32,
    prior_chunks: [],
  };
  accept("LevelUpper exact binary chunk", validateLevelUpperBinaryChunk,
    binaryChunk, binaryContext);
  reject("LevelUpper cross-session binary replay", validateLevelUpperBinaryChunk,
    binaryChunk, {...binaryContext, link_session_id: testUuid(832)},
    "link_session_id fence mismatch");
  reject("LevelUpper unsolicited binary range", validateLevelUpperBinaryChunk,
    binaryChunk, {...binaryContext, requested_ranges: [{offset: 32, length: 32}]},
    "outside the outstanding request");
  reject("LevelUpper overlapping binary chunk", validateLevelUpperBinaryChunk,
    binaryChunk, {
      ...binaryContext,
      prior_chunks: [{offset: 4, length: 8, content_digest: testDigest("c")}],
    }, "conflicts or overlaps");
  reject("LevelUpper binary trailing bytes", validateLevelUpperBinaryChunk,
    Buffer.concat([binaryChunk, Buffer.from([0])]), binaryContext, "trailing bytes");

  const hello = sealLevelFrame({
    schema: "dolly.levelupper-wire-control/v1",
    semantic_validator: "org.dolly.validator.levelupper-wire@1",
    protocol_version: 1,
    link_session_id: testUuid(810),
    connection_epoch: 1,
    sender_peer_id: peerId,
    message_id: testUuid(811),
    body: {
      kind: "hello", minimum_version: 2, maximum_version: 1, nonce: testUuid(812),
      limits: {
        max_frame_bytes: 65536, max_batch_entries: 16, max_in_flight_bytes: 1048576,
        max_asset_bytes: 1048576, max_asset_chunk_bytes: 65536,
        max_outstanding_requests: 32,
      },
    },
    frame_digest: testDigest("0"),
  });
  reject("LevelUpper hello version range", validateLevelUpperWire, hello,
    {authenticatedPeerId: peerId}, "minimum_version exceeds");

  process.stdout.write(`Research semantic validators: ${cases} cases passed\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSelfTests();
}
