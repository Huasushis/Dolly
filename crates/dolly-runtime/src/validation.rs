use std::collections::{BTreeMap, BTreeSet};

use dolly_canonical_json::{CanonicalJsonValue, Sha256Digest, canonicalize};
use dolly_core_domain::{ModuleId, PageId};
use dolly_core_reducer::{CoreSnapshot, EnvironmentInput};
use dolly_core_reducer::{FrozenDescriptor, NeighborGraph, build_neighbor_descriptors};
use dolly_schema::{
    ACTIVATION_MANIFEST_SCHEMA_ID, ActivationManifest, ActivationReplayEvidence,
    ActivationReplayMode, BLOCK_SCHEMA_ID, BlockEnvelope, MODULE_DESCRIPTOR_SCHEMA_ID,
    ModuleDescriptor, embedded_schema_catalog,
};
use serde::Deserialize;
use serde_json::Value;

use crate::RuntimeError;
use crate::premise::{
    CursorSpan, ExecutionOrder, InputItemOrder, InputOccurrence, LossyGap, ReplayEvidence,
    ReplayMode, ReplayScope,
};

#[derive(Debug)]
pub(crate) struct ValidatedManifest {
    pub(crate) manifest: ActivationManifest,
    pub(crate) order: ExecutionOrder,
    pub(crate) graph_digest: String,
    pub(crate) descriptor_digest: String,
    pub(crate) replay_scope: ReplayScope,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GraphEnvelope {
    revision: i64,
    graph: Value,
    digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GraphDocument {
    receiving_module: String,
    #[serde(default)]
    input_pages: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    output_pages: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    subscriptions: BTreeMap<String, Vec<String>>,
    descriptors: BTreeMap<String, GraphDescriptor>,
    #[serde(default)]
    authorized_metadata_namespaces: Vec<String>,
    #[serde(default)]
    authorized_action_names: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GraphDescriptor {
    module_id: String,
    descriptor_revision: i64,
    source_descriptor_digest: String,
    /// The authoritative Extension that owns this Module in this graph. The
    /// field is Host-derived during validated graph construction/admission
    /// (the activating Extension whose package+descriptor this Module is
    /// admitted from), never trusted from arbitrary graph input. It rides the
    /// canonical validated representation InstallGraph persists so storage
    /// ingress verification can bind a grant's Extension to the exact module
    /// owner.
    owner_extension_id: String,
    value: Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfigEnvelope {
    revision: i64,
    effective_config: Value,
    digest: String,
    #[serde(default)]
    schema_digest: Option<String>,
    #[serde(default)]
    effective_config_schema_digest: Option<String>,
}

#[derive(Debug)]
pub(crate) struct GraphAuthority {
    pub(crate) graph_digest: String,
    pub(crate) descriptor_digest: String,
    pub(crate) replay_scope: ReplayScope,
}

fn invalid_manifest(detail: impl Into<String>) -> RuntimeError {
    RuntimeError::ManifestInvalid {
        detail: detail.into(),
    }
}

fn invalid_graph(detail: impl Into<String>) -> RuntimeError {
    RuntimeError::GraphInvalid {
        detail: detail.into(),
    }
}

fn invalid_descriptor(detail: impl Into<String>) -> RuntimeError {
    RuntimeError::DescriptorInvalid {
        detail: detail.into(),
    }
}

fn invalid_revision(detail: impl Into<String>) -> RuntimeError {
    RuntimeError::RevisionConflict {
        detail: detail.into(),
    }
}

fn invalid_digest(detail: impl Into<String>) -> RuntimeError {
    RuntimeError::DigestMismatch {
        detail: detail.into(),
    }
}

fn invalid_direction(detail: impl Into<String>) -> RuntimeError {
    RuntimeError::DirectionInvalid {
        detail: detail.into(),
    }
}

fn invalid_order(detail: impl Into<String>) -> RuntimeError {
    RuntimeError::OrderInvalid {
        detail: detail.into(),
    }
}

fn canonical_value(value: &Value) -> Result<(Vec<u8>, String), RuntimeError> {
    let (bytes, digest) =
        canonicalize(value).map_err(|error| invalid_manifest(error.to_string()))?;
    Ok((bytes.into_vec(), digest.to_canonical_string()))
}

fn canonical_equal(left: &Value, right: &Value) -> Result<bool, RuntimeError> {
    Ok(canonical_value(left)?.0 == canonical_value(right)?.0)
}

fn verify_digest(value: &Value, claimed: &str, label: &str) -> Result<(), RuntimeError> {
    let parsed: Sha256Digest = claimed
        .parse()
        .map_err(|_| invalid_digest(format!("{label} is not a canonical SHA-256 digest")))?;
    let (bytes, _) = canonical_value(value)?;
    parsed
        .verify_bytes(&bytes)
        .map_err(|_| invalid_digest(format!("{label} does not match canonical bytes")))
}

fn verify_digest_without_field(
    value: &Value,
    field: &str,
    claimed: &str,
    label: &str,
) -> Result<(), RuntimeError> {
    let mut without = value
        .as_object()
        .cloned()
        .ok_or_else(|| invalid_manifest(format!("{label} must be an object")))?;
    without.remove(field);
    verify_digest(&Value::Object(without), claimed, label)
}

fn validate_schema(value: &Value, schema_id: &str, label: &str) -> Result<(), RuntimeError> {
    let instance = CanonicalJsonValue::try_from(value.clone())
        .map_err(|error| invalid_manifest(format!("{label} is not canonical JSON: {error}")))?;
    let catalog = embedded_schema_catalog()
        .map_err(|error| invalid_manifest(format!("schema catalog unavailable: {error}")))?;
    catalog
        .validate(schema_id, &instance, 64)
        .map_err(|error| invalid_manifest(format!("{label} violates its schema: {error:?}")))
}

fn value_of<T: serde::Serialize>(value: &T, label: &str) -> Result<Value, RuntimeError> {
    serde_json::to_value(value)
        .map_err(|error| invalid_manifest(format!("cannot encode {label}: {error}")))
}

fn parse_module_id(value: &str, label: &str) -> Result<(), RuntimeError> {
    value
        .parse::<ModuleId>()
        .map(|_| ())
        .map_err(|error| invalid_graph(format!("{label} is not a valid Module ID: {error}")))
}

fn parse_page_id(value: &str, label: &str) -> Result<(), RuntimeError> {
    value
        .parse::<PageId>()
        .map(|_| ())
        .map_err(|error| invalid_graph(format!("{label} is not a valid Page ID: {error}")))
}

fn validate_unique_strings(
    values: &[String],
    label: &str,
    parser: fn(&str, &str) -> Result<(), RuntimeError>,
) -> Result<(), RuntimeError> {
    let mut seen = BTreeSet::new();
    for value in values {
        parser(value, label)?;
        if !seen.insert(value) {
            return Err(invalid_direction(format!(
                "{label} contains a duplicate value"
            )));
        }
    }
    Ok(())
}

fn validate_block(value: &Value) -> Result<(String, String), RuntimeError> {
    validate_schema(value, BLOCK_SCHEMA_ID, "input Block")?;
    let block: BlockEnvelope = serde_json::from_value(value.clone())
        .map_err(|error| invalid_manifest(format!("input Block is malformed: {error}")))?;
    let body = value
        .get("body")
        .ok_or_else(|| invalid_manifest("input Block has no body"))?;
    verify_digest(body, &block.body_digest.to_string(), "Block body_digest")?;
    verify_digest_without_field(
        value,
        "envelope_digest",
        &block.envelope_digest.to_string(),
        "Block envelope_digest",
    )?;
    Ok((block.id.to_string(), block.envelope_digest.to_string()))
}

fn occurrence_key(occurrence: &InputOccurrence) -> (&str, u64, u64) {
    (
        occurrence.page_id(),
        occurrence.commit_seq(),
        occurrence.page_seq(),
    )
}

fn delivery_key(occurrence: &InputOccurrence) -> (u64, String, u64) {
    (
        occurrence.commit_seq(),
        occurrence.page_id().to_owned(),
        occurrence.page_seq(),
    )
}

fn validate_manifest_order(manifest: &ActivationManifest) -> Result<ExecutionOrder, RuntimeError> {
    let mut input_items = Vec::with_capacity(manifest.input_items.len());
    let mut block_ids = BTreeSet::new();
    let mut previous_delivery: Option<(u64, String, u64)> = None;
    let mut previous_item_first: Option<(u64, String, u64)> = None;

    for item in &manifest.input_items {
        if item.occurrences.is_empty() {
            return Err(invalid_order(
                "input item must contain at least one occurrence",
            ));
        }
        if item.occurrence_count as usize != item.occurrences.len() {
            return Err(invalid_order(
                "input occurrence_count does not match occurrences",
            ));
        }
        let block_value = value_of(&item.block, "input Block")?;
        let (block_id, block_digest) = validate_block(&block_value)?;
        if !block_ids.insert(block_id.clone()) {
            return Err(invalid_order("a Block occurs in more than one input item"));
        }

        let mut occurrences = Vec::with_capacity(item.occurrences.len());
        for occurrence in &item.occurrences {
            let current = InputOccurrence::new(
                occurrence.page_id.to_string(),
                occurrence.page_seq.value(),
                occurrence.commit_seq.value(),
            );
            let key = delivery_key(&current);
            if previous_delivery
                .as_ref()
                .is_some_and(|previous| previous >= &key)
            {
                return Err(invalid_order(
                    "input occurrences are not in (commit_seq, page_id, page_seq) order",
                ));
            }
            previous_delivery = Some(key);
            occurrences.push(current);
        }
        let first = occurrence_key(&occurrences[0]);
        let first_key = (first.1, first.0.to_string(), first.2);
        if previous_item_first
            .as_ref()
            .is_some_and(|previous| previous >= &first_key)
        {
            return Err(invalid_order(
                "input items are not in first-occurrence delivery order",
            ));
        }
        previous_item_first = Some(first_key);
        input_items.push(InputItemOrder::new(block_id, block_digest, occurrences));
    }

    let mut cursor_spans = Vec::with_capacity(manifest.cursor_spans.len());
    let mut previous_page: Option<String> = None;
    for span in &manifest.cursor_spans {
        let page_id = span.page_id.to_string();
        if previous_page
            .as_ref()
            .is_some_and(|previous| previous >= &page_id)
        {
            return Err(invalid_order("cursor_spans are not ordered by page_id"));
        }
        if span.from_page_seq.value() >= span.to_page_seq.value() {
            return Err(invalid_order("cursor span is not half-open and increasing"));
        }
        previous_page = Some(page_id.clone());
        cursor_spans.push(CursorSpan::new(
            page_id,
            span.from_page_seq.value(),
            span.to_page_seq.value(),
        ));
    }

    let mut lossy_gaps = Vec::with_capacity(manifest.lossy_gaps.len());
    let mut previous_gap: Option<(String, u64, Option<u64>)> = None;
    for gap in &manifest.lossy_gaps {
        let page_id = gap.page_id.to_string();
        let from_page_seq = gap.from_page_seq.map(|value| value.value());
        let to_page_seq = gap.to_page_seq.value();
        if from_page_seq.is_some_and(|from| from >= to_page_seq) {
            return Err(invalid_order("lossy gap is not half-open and increasing"));
        }
        let key = (page_id.clone(), to_page_seq, from_page_seq);
        if previous_gap
            .as_ref()
            .is_some_and(|previous| previous >= &key)
        {
            return Err(invalid_order(
                "lossy_gaps are not ordered by (page_id, to_page_seq, from_page_seq)",
            ));
        }
        previous_gap = Some(key);
        lossy_gaps.push(LossyGap::new(
            page_id,
            from_page_seq,
            to_page_seq,
            format!("{:?}", gap.reason).to_lowercase(),
        ));
    }

    let output_page_ids: Vec<String> = manifest
        .output_page_ids
        .iter()
        .map(ToString::to_string)
        .collect();
    validate_sorted_unique(&output_page_ids, "output_page_ids")?;

    Ok(ExecutionOrder::new(
        input_items,
        cursor_spans,
        lossy_gaps,
        output_page_ids,
    ))
}

fn validate_sorted_unique(values: &[String], label: &str) -> Result<(), RuntimeError> {
    if values.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(invalid_order(format!(
            "{label} is not bytewise sorted and unique"
        )));
    }
    Ok(())
}

fn validate_graph_document(graph: &GraphDocument) -> Result<(), RuntimeError> {
    parse_module_id(&graph.receiving_module, "graph receiving_module")?;
    if !graph.descriptors.contains_key(&graph.receiving_module) {
        return Err(invalid_graph(
            "graph receiving_module has no frozen Descriptor",
        ));
    }
    for (module_id, pages) in &graph.input_pages {
        parse_module_id(module_id, "graph input_pages module")?;
        validate_unique_strings(pages, "graph input page IDs", parse_page_id)?;
    }
    for (module_id, pages) in &graph.output_pages {
        parse_module_id(module_id, "graph output_pages module")?;
        validate_unique_strings(pages, "graph output page IDs", parse_page_id)?;
    }
    for (page_id, modules) in &graph.subscriptions {
        parse_page_id(page_id, "graph subscription page ID")?;
        validate_unique_strings(modules, "graph subscription Module IDs", parse_module_id)?;
    }
    validate_sorted_unique(
        &graph.authorized_metadata_namespaces,
        "authorized_metadata_namespaces",
    )?;
    validate_sorted_unique(&graph.authorized_action_names, "authorized_action_names")?;
    for module_id in graph
        .input_pages
        .keys()
        .chain(graph.output_pages.keys())
        .chain(graph.subscriptions.values().flatten())
    {
        if !graph.descriptors.contains_key(module_id) {
            return Err(invalid_graph(format!(
                "graph references Module {module_id} without a frozen Descriptor"
            )));
        }
    }
    Ok(())
}

fn replay_scope_from_descriptor(
    descriptor: &ModuleDescriptor,
) -> Result<ReplayScope, RuntimeError> {
    let contract = &descriptor.activation_replay_contract;
    let (mode, evidence) = match (&contract.mode, &contract.evidence) {
        (ActivationReplayMode::NeverAutoRetry, ActivationReplayEvidence::None) => {
            (ReplayMode::NeverAutoRetry, ReplayEvidence::None)
        }
        (ActivationReplayMode::FencedReplay, ActivationReplayEvidence::PureCompute) => {
            (ReplayMode::FencedReplay, ReplayEvidence::PureCompute)
        }
        (ActivationReplayMode::FencedReplay, ActivationReplayEvidence::ActivationLedger) => {
            (ReplayMode::FencedReplay, ReplayEvidence::ActivationLedger)
        }
        _ => {
            return Err(RuntimeError::ReplayInvalid {
                detail: "Descriptor replay mode and evidence are incompatible".into(),
            });
        }
    };
    let ledger = contract.ledger.as_ref();
    if matches!(evidence, ReplayEvidence::ActivationLedger) != ledger.is_some() {
        return Err(RuntimeError::ReplayInvalid {
            detail: "activation_ledger replay requires exactly one ledger descriptor".into(),
        });
    }
    Ok(ReplayScope::new(
        mode,
        evidence,
        ledger.map(|value| value.namespace.clone()),
        ledger.map(|value| value.schema_version.clone()),
        ledger.map(|_| "module_state_directory".to_string()),
    ))
}

fn validate_graph_and_descriptor(
    snapshot: &CoreSnapshot,
    manifest: &ActivationManifest,
) -> Result<GraphAuthority, RuntimeError> {
    let envelope: GraphEnvelope =
        serde_json::from_value(snapshot.graph.clone()).map_err(|error| {
            invalid_graph(format!("persisted graph authority is malformed: {error}"))
        })?;
    if envelope.revision <= 0 {
        return Err(invalid_graph("persisted graph revision must be positive"));
    }
    verify_digest(&envelope.graph, &envelope.digest, "persisted graph digest")?;
    let graph: GraphDocument = serde_json::from_value(envelope.graph.clone()).map_err(|error| {
        invalid_graph(format!("persisted graph document is malformed: {error}"))
    })?;
    validate_graph_document(&graph)?;
    if graph.receiving_module != manifest.module_id.to_string() {
        return Err(invalid_direction(
            "manifest module_id does not match graph receiving_module",
        ));
    }
    if manifest.graph_revision.value() as i64 != envelope.revision {
        return Err(invalid_revision(
            "manifest graph_revision does not match persisted graph revision",
        ));
    }

    let mut frozen = BTreeMap::new();
    let mut receiver_descriptor: Option<ModuleDescriptor> = None;
    let mut receiver_digest = None;
    for (module_id, descriptor) in graph.descriptors {
        if descriptor.module_id != module_id {
            return Err(invalid_descriptor(format!(
                "graph Descriptor key {module_id} does not match its module_id"
            )));
        }
        if descriptor.descriptor_revision <= 0 {
            return Err(invalid_descriptor(format!(
                "Descriptor {module_id} revision must be positive"
            )));
        }
        if descriptor
            .owner_extension_id
            .parse::<dolly_core_domain::ExtensionId>()
            .is_err()
        {
            return Err(invalid_descriptor(format!(
                "Descriptor {module_id} owner_extension_id is not a valid ExtensionId"
            )));
        }
        verify_digest(
            &descriptor.value,
            &descriptor.source_descriptor_digest,
            &format!("Descriptor {module_id} source_descriptor_digest"),
        )
        .map_err(|_| invalid_descriptor(format!("Descriptor {module_id} digest mismatch")))?;
        validate_schema(
            &descriptor.value,
            MODULE_DESCRIPTOR_SCHEMA_ID,
            &format!("Descriptor {module_id}"),
        )?;
        let typed: ModuleDescriptor =
            serde_json::from_value(descriptor.value.clone()).map_err(|error| {
                invalid_descriptor(format!("Descriptor {module_id} is malformed: {error}"))
            })?;
        if typed.module_id.to_string() != module_id
            || typed.descriptor_revision.value() as i64 != descriptor.descriptor_revision
        {
            return Err(invalid_descriptor(format!(
                "Descriptor {module_id} identity or revision disagrees with graph"
            )));
        }
        if module_id == manifest.module_id.to_string() {
            receiver_digest = Some(descriptor.source_descriptor_digest.clone());
            receiver_descriptor = Some(typed.clone());
        }
        frozen.insert(
            module_id.clone(),
            FrozenDescriptor {
                module_id: module_id.clone(),
                descriptor_revision: descriptor.descriptor_revision,
                source_descriptor_digest: descriptor.source_descriptor_digest.clone(),
                owner_extension_id: descriptor.owner_extension_id.clone(),
                value: descriptor.value,
            },
        );
    }
    let receiver_descriptor = receiver_descriptor
        .ok_or_else(|| invalid_descriptor("manifest receiving Descriptor is missing"))?;
    if manifest.descriptor_revision.value() as i64
        != receiver_descriptor.descriptor_revision.value() as i64
    {
        return Err(invalid_revision(
            "manifest descriptor_revision does not match receiving Descriptor",
        ));
    }
    let replay_scope = replay_scope_from_descriptor(&receiver_descriptor)?;
    let expected_neighbors = build_neighbor_descriptors(&NeighborGraph {
        receiving_module: manifest.module_id.to_string(),
        input_pages: graph_input_pages(snapshot)?,
        output_pages: graph_output_pages(snapshot)?,
        subscriptions: graph_subscriptions(snapshot)?,
        descriptors: frozen,
        authorized_metadata_namespaces: graph_authorized_namespaces(snapshot)?,
        authorized_action_names: graph_authorized_actions(snapshot)?,
    })
    .map_err(|error| invalid_direction(format!("neighbor projection failed: {error}")))?;
    let expected_value = value_of(&expected_neighbors, "expected neighbor projection")?;
    let actual_value = value_of(
        &manifest.neighbor_descriptors,
        "manifest neighbor projection",
    )?;
    if !canonical_equal(&expected_value, &actual_value)? {
        return Err(invalid_direction(
            "manifest neighbor descriptors are not the graph-derived projection",
        ));
    }
    let output_pages = graph_output_pages(snapshot)?;
    let mut expected_outputs = output_pages
        .get(&manifest.module_id.to_string())
        .cloned()
        .unwrap_or_default();
    expected_outputs.sort();
    expected_outputs.dedup();
    if manifest
        .output_page_ids
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        != expected_outputs
    {
        return Err(invalid_direction(
            "manifest output_page_ids do not match the graph output direction",
        ));
    }
    Ok(GraphAuthority {
        graph_digest: envelope.digest,
        descriptor_digest: receiver_digest
            .ok_or_else(|| invalid_descriptor("receiving Descriptor digest was not retained"))?,
        replay_scope,
    })
}

fn graph_document_from_snapshot(snapshot: &CoreSnapshot) -> Result<GraphDocument, RuntimeError> {
    let envelope: GraphEnvelope =
        serde_json::from_value(snapshot.graph.clone()).map_err(|error| {
            invalid_graph(format!("persisted graph authority is malformed: {error}"))
        })?;
    serde_json::from_value(envelope.graph)
        .map_err(|error| invalid_graph(format!("persisted graph document is malformed: {error}")))
}

fn graph_input_pages(
    snapshot: &CoreSnapshot,
) -> Result<BTreeMap<String, Vec<String>>, RuntimeError> {
    Ok(graph_document_from_snapshot(snapshot)?.input_pages)
}

fn graph_output_pages(
    snapshot: &CoreSnapshot,
) -> Result<BTreeMap<String, Vec<String>>, RuntimeError> {
    Ok(graph_document_from_snapshot(snapshot)?.output_pages)
}

fn graph_subscriptions(
    snapshot: &CoreSnapshot,
) -> Result<BTreeMap<String, Vec<String>>, RuntimeError> {
    Ok(graph_document_from_snapshot(snapshot)?.subscriptions)
}

fn graph_authorized_namespaces(snapshot: &CoreSnapshot) -> Result<Vec<String>, RuntimeError> {
    Ok(graph_document_from_snapshot(snapshot)?.authorized_metadata_namespaces)
}

fn graph_authorized_actions(snapshot: &CoreSnapshot) -> Result<Vec<String>, RuntimeError> {
    Ok(graph_document_from_snapshot(snapshot)?.authorized_action_names)
}

fn validate_config(
    snapshot: &CoreSnapshot,
    manifest: &ActivationManifest,
) -> Result<(), RuntimeError> {
    let config: ConfigEnvelope =
        serde_json::from_value(snapshot.config.clone()).map_err(|error| {
            RuntimeError::ConfigInvalid {
                detail: format!("persisted configuration authority is malformed: {error}"),
            }
        })?;
    if config.revision <= 0 {
        return Err(RuntimeError::ConfigInvalid {
            detail: "persisted configuration revision must be positive".into(),
        });
    }
    verify_digest(
        &config.effective_config,
        &config.digest,
        "persisted config digest",
    )
    .map_err(|_| RuntimeError::ConfigInvalid {
        detail: "persisted configuration digest mismatch".into(),
    })?;
    let manifest_config = value_of(&manifest.effective_config, "manifest effective_config")?;
    if manifest.config_revision.value() as i64 != config.revision
        || !canonical_equal(&manifest_config, &config.effective_config)?
        || manifest.effective_config_digest.to_string() != config.digest
    {
        return Err(invalid_revision(
            "manifest configuration revision or value is not the persisted authority",
        ));
    }
    verify_digest(
        &manifest_config,
        &manifest.effective_config_digest.to_string(),
        "manifest effective_config_digest",
    )?;
    let schema_digest = config
        .schema_digest
        .as_ref()
        .or(config.effective_config_schema_digest.as_ref());
    if let Some(schema_digest) = schema_digest {
        if schema_digest != &manifest.effective_config_schema_digest.to_string() {
            return Err(invalid_digest(
                "manifest effective_config_schema_digest disagrees with persisted configuration",
            ));
        }
    }
    Ok(())
}

pub(crate) fn validate_manifest_shape(
    value: &Value,
) -> Result<(ActivationManifest, ExecutionOrder), RuntimeError> {
    validate_schema(value, ACTIVATION_MANIFEST_SCHEMA_ID, "Activation Manifest")?;
    let manifest: ActivationManifest = serde_json::from_value(value.clone())
        .map_err(|error| invalid_manifest(format!("Activation Manifest is malformed: {error}")))?;
    if manifest.activation_id.to_string().is_empty() || manifest.module_id.as_str().is_empty() {
        return Err(invalid_manifest("Activation Manifest identity is empty"));
    }
    verify_digest_without_field(
        value,
        "manifest_digest",
        &manifest.manifest_digest.to_string(),
        "manifest_digest",
    )?;
    let effective_config = value_of(&manifest.effective_config, "manifest effective_config")?;
    verify_digest(
        &effective_config,
        &manifest.effective_config_digest.to_string(),
        "manifest effective_config_digest",
    )?;
    let _schema_digest: Sha256Digest = manifest
        .effective_config_schema_digest
        .to_string()
        .parse()
        .map_err(|_| invalid_digest("manifest effective_config_schema_digest is invalid"))?;
    let order = validate_manifest_order(&manifest)?;
    Ok((manifest, order))
}

pub(crate) fn validate_manifest_against_snapshot(
    value: &Value,
    snapshot: &CoreSnapshot,
    input: &EnvironmentInput,
    expected_graph_revision: Option<i64>,
    expected_descriptor_revision: Option<i64>,
) -> Result<ValidatedManifest, RuntimeError> {
    let (manifest, order) = validate_manifest_shape(value)?;
    if expected_graph_revision != Some(manifest.graph_revision.value() as i64)
        || input.graph_revision != Some(manifest.graph_revision.value() as i64)
    {
        return Err(invalid_revision(
            "graph revision fence is missing or disagrees with the manifest",
        ));
    }
    if expected_descriptor_revision != Some(manifest.descriptor_revision.value() as i64)
        || input.descriptor_revision != Some(manifest.descriptor_revision.value() as i64)
    {
        return Err(invalid_revision(
            "Descriptor revision fence is missing or disagrees with the manifest",
        ));
    }
    let graph = validate_graph_and_descriptor(snapshot, &manifest)?;
    validate_config(snapshot, &manifest)?;
    Ok(ValidatedManifest {
        manifest,
        order,
        graph_digest: graph.graph_digest,
        descriptor_digest: graph.descriptor_digest,
        replay_scope: graph.replay_scope,
    })
}

pub(crate) fn validate_manifest_for_replay(
    value: &Value,
) -> Result<(ActivationManifest, ExecutionOrder), RuntimeError> {
    validate_manifest_shape(value)
}

pub(crate) fn map_reducer_failure(transition: &dolly_core_reducer::Transition) -> RuntimeError {
    let code = transition
        .error
        .as_ref()
        .map(|error| error.code.clone())
        .unwrap_or_else(|| "CORE_TRANSACTION_REJECTED".into());
    if code.contains("IDEMPOTENCY") {
        RuntimeError::ReplayConflict { detail: code }
    } else {
        RuntimeError::TransactionRejected { code }
    }
}
