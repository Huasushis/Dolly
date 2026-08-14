//! Generated closed representations for the three public stable roots:
//! `BlockEnvelope`, `ActivationManifest`, and `ModuleDescriptor`.
//!
//! These are checked-in Rust types that mirror the JSON Schema definitions.
//! They are validated against the embedded catalog at test time.

use dolly_canonical_json::{CanonicalJsonObject, CanonicalJsonValue, Sha256Digest};
use dolly_core_domain::{
    ActivationId, BlockId, CommitSeq, ConfigRevision, DescriptorRevision, GraphRevision,
    InstanceId, ModuleId, PageId, PageSeq, RuntimeEventId, Timestamp, TraceId, UuidV7,
};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// BlockEnvelope (dolly.block/v1)
// ---------------------------------------------------------------------------

/// The `dolly.block/v1` document.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlockEnvelope {
    pub schema: BlockEnvelopeSchemaTag,
    pub id: BlockId,
    pub created_at: Timestamp,
    pub creation_commit_seq: CommitSeq,
    pub producer: BlockProducer,
    pub trace: BlockTrace,
    pub body: BlockBody,
    pub body_digest: Sha256Digest,
    pub envelope_digest: Sha256Digest,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockEnvelopeSchemaTag;

impl Serialize for BlockEnvelopeSchemaTag {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str("dolly.block/v1")
    }
}

impl<'de> Deserialize<'de> for BlockEnvelopeSchemaTag {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let s = String::deserialize(de)?;
        if s == "dolly.block/v1" {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom(format!(
                "expected 'dolly.block/v1', got '{s}'"
            )))
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlockProducer {
    pub kind: BlockProducerKind,
    pub instance_id: InstanceId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module_id: Option<ModuleId>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BlockProducerKind {
    Module,
    External,
    Runtime,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlockTrace {
    pub trace_id: TraceId,
    pub root_trace_ids: Vec<UuidV7>,
    pub causal_parents: Vec<UuidV7>,
    pub hop_count: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlockBody {
    pub description: String,
    pub parts: Vec<Part>,
    pub actions: Vec<CommittedAction>,
    pub metadata: CanonicalJsonObject,
    pub hints: CanonicalJsonObject,
}

/// A `Part` — one of text, json, asset, or block_ref.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Part {
    Text {
        text: String,
        format: TextFormat,
        #[serde(skip_serializing_if = "Option::is_none")]
        language: Option<String>,
    },
    Json {
        value: CanonicalJsonValue,
        #[serde(skip_serializing_if = "Option::is_none")]
        schema_uri: Option<String>,
    },
    Asset {
        asset_id: String,
        media_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        view: Option<CanonicalJsonObject>,
    },
    BlockRef {
        block_id: UuidV7,
        relation: BlockRefRelation,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TextFormat {
    Plain,
    Markdown,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BlockRefRelation {
    Forward,
    ReplyTo,
    Evidence,
    DerivedFrom,
}

/// A `CommittedAction`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommittedAction {
    pub action_id: RuntimeEventId,
    pub name: String,
    pub arguments: CanonicalJsonObject,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<ActionTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contract_binding: Option<ActionContractBinding>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionTarget {
    pub module_id: ModuleId,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionContractBinding {
    pub module_id: ModuleId,
    pub descriptor_revision: DescriptorRevision,
    pub action_contract_digest: Sha256Digest,
    pub action_contract: FrozenActionContract,
}

// ---------------------------------------------------------------------------
// ModuleDescriptor (dolly.module-descriptor/v1)
// ---------------------------------------------------------------------------

/// The `dolly.module-descriptor/v1` document.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModuleDescriptor {
    pub schema: ModuleDescriptorSchemaTag,
    pub module_id: ModuleId,
    pub descriptor_revision: DescriptorRevision,
    pub display_name: String,
    pub accepts: Contract,
    pub emits: Contract,
    pub actions: Vec<FrozenActionContract>,
    pub activation_replay_contract: ActivationReplayContract,
    pub trust: Trust,
    pub metadata: CanonicalJsonObject,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModuleDescriptorSchemaTag;

impl Serialize for ModuleDescriptorSchemaTag {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str("dolly.module-descriptor/v1")
    }
}

impl<'de> Deserialize<'de> for ModuleDescriptorSchemaTag {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let s = String::deserialize(de)?;
        if s == "dolly.module-descriptor/v1" {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom(format!(
                "expected 'dolly.module-descriptor/v1', got '{s}'"
            )))
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Trust {
    System,
    Trusted,
    Untrusted,
}

/// A `Contract`: summary, part_kinds, action_names.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Contract {
    pub summary: String,
    pub part_kinds: Vec<PartKind>,
    pub action_names: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PartKind {
    Text,
    Json,
    Asset,
    BlockRef,
}

/// A `FrozenActionContract`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrozenActionContract {
    pub name: String,
    pub arguments_schema: ActionSchemaBinding,
    pub result_schema: ActionSchemaBinding,
    pub description: String,
    pub side_effect_class: SideEffectClass,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SideEffectClass {
    ReadOnly,
    IdempotentWrite,
    NonIdempotentWrite,
    Unknown,
}

/// An `ActionSchemaBinding`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionSchemaBinding {
    pub uri: String,
    pub schema_digest: Sha256Digest,
    pub semantic_validator: Option<ActionSemanticValidatorBinding>,
}

/// An `ActionSemanticValidatorBinding`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionSemanticValidatorBinding {
    pub id: String,
    pub revision: DescriptorRevision,
}

/// An `ActivationReplayContract`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivationReplayContract {
    pub mode: ActivationReplayMode,
    pub evidence: ActivationReplayEvidence,
    pub ledger: Option<ActivationLedgerDescriptor>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActivationReplayMode {
    NeverAutoRetry,
    FencedReplay,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActivationReplayEvidence {
    None,
    PureCompute,
    ActivationLedger,
}

/// An `ActivationLedgerDescriptor`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivationLedgerDescriptor {
    pub namespace: String,
    pub schema_version: String,
    pub location: ActivationLedgerLocation,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActivationLedgerLocation;

impl Serialize for ActivationLedgerLocation {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str("module_state_directory")
    }
}

impl<'de> Deserialize<'de> for ActivationLedgerLocation {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let s = String::deserialize(de)?;
        if s == "module_state_directory" {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom(format!(
                "expected 'module_state_directory', got '{s}'"
            )))
        }
    }
}

// ---------------------------------------------------------------------------
// ActivationManifest (dolly.activation-manifest/v1)
// ---------------------------------------------------------------------------

/// The `dolly.activation-manifest/v1` document.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivationManifest {
    pub schema: ActivationManifestSchemaTag,
    pub activation_id: ActivationId,
    pub module_id: ModuleId,
    pub reason: ActivationReason,
    pub created_at: Timestamp,
    pub graph_revision: GraphRevision,
    pub config_revision: ConfigRevision,
    pub descriptor_revision: DescriptorRevision,
    pub effective_config: CanonicalJsonObject,
    pub effective_config_digest: Sha256Digest,
    pub effective_config_schema_digest: Sha256Digest,
    pub input_items: Vec<InputItem>,
    pub cursor_spans: Vec<CursorSpanEntry>,
    pub lossy_gaps: Vec<LossyGap>,
    pub output_page_ids: Vec<PageId>,
    pub neighbor_descriptors: Vec<NeighborDescriptor>,
    pub required_frame_bytes: u64,
    pub required_frame_nesting_depth: u16,
    pub deadline: Timestamp,
    pub manifest_digest: Sha256Digest,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActivationManifestSchemaTag;

impl Serialize for ActivationManifestSchemaTag {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str("dolly.activation-manifest/v1")
    }
}

impl<'de> Deserialize<'de> for ActivationManifestSchemaTag {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let s = String::deserialize(de)?;
        if s == "dolly.activation-manifest/v1" {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom(format!(
                "expected 'dolly.activation-manifest/v1', got '{s}'"
            )))
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActivationReason {
    Input,
    Timer,
    BackgroundReady,
    Manual,
}

/// An input item: block, occurrences, occurrence_count.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InputItem {
    pub block: CanonicalJsonObject,
    pub occurrences: Vec<Occurrence>,
    pub occurrence_count: u64,
}

/// An occurrence: page_id, page_seq, commit_seq.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Occurrence {
    pub page_id: PageId,
    pub page_seq: PageSeq,
    pub commit_seq: CommitSeq,
}

/// A cursor span entry: page_id, from_page_seq, to_page_seq.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CursorSpanEntry {
    pub page_id: PageId,
    pub from_page_seq: PageSeq,
    pub to_page_seq: PageSeq,
}

/// A lossy gap: page_id, from_page_seq (nullable), to_page_seq, reason.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LossyGap {
    pub page_id: PageId,
    pub from_page_seq: Option<PageSeq>,
    pub to_page_seq: PageSeq,
    pub reason: LossyGapReason,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LossyGapReason {
    Overflow,
    Restart,
}

/// A neighbor descriptor.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NeighborDescriptor {
    pub module_id: ModuleId,
    pub descriptor_revision: DescriptorRevision,
    pub source_descriptor_digest: Sha256Digest,
    pub relationships: Vec<NeighborRelationship>,
    pub projection: CanonicalJsonObject,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NeighborRelationship {
    InputProducer,
    OutputConsumer,
}
