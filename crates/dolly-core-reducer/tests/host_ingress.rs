//! Focused pure tests for the Host ingress identity derivation: the ingress
//! key, the operation digest over the ordered target Pages, canonical target
//! equivalence, premise validation bounds, and command building.

use dolly_canonical_json::CanonicalJsonValue;
use dolly_core_domain::{
    ExtensionGeneration, HostIngressKind, HostIngressPremise, HostIngressSource, PageId,
};
use dolly_core_reducer::{
    CoreCommand, HostIngressPremiseError, build_ingress_command, canonical_target_page_ids,
    derive_ingress_identity,
};
use serde_json::{Value, json};

fn page(id: &str) -> PageId {
    id.parse().expect("test page id must be a valid PageId")
}

fn payload(value: Value) -> CanonicalJsonValue {
    serde_json::from_value(value).expect("test payload must be canonical JSON")
}

fn source(module: &str) -> HostIngressSource {
    HostIngressSource {
        extension_id: "org.dolly.channel".parse().unwrap(),
        module_id: module.parse().unwrap(),
        instance_id: "instance-a".parse().unwrap(),
        generation: ExtensionGeneration::new(7).unwrap(),
    }
}

fn premise(
    owner: &str,
    external: &str,
    kind: HostIngressKind,
    references: Option<&str>,
    pages: &[&str],
    content: Value,
    revision: i64,
) -> HostIngressPremise {
    HostIngressPremise {
        owner: owner.into(),
        source: source("receiver"),
        external_event_id: external.into(),
        kind,
        references_external_event_id: references.map(str::to_owned),
        target_page_ids: pages.iter().map(|id| page(id)).collect(),
        payload: payload(content),
        revision,
    }
}

fn identity(premise: &HostIngressPremise) -> dolly_core_reducer::IngressIdentity {
    derive_ingress_identity(premise).expect("test premise must derive")
}

// ---------------------------------------------------------------------------
// Ingress key: owner/source/external namespace
// ---------------------------------------------------------------------------

#[test]
fn key_binds_owner_source_and_external_identity() {
    let base = premise(
        "account-a",
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a"],
        json!({"text":"hello"}),
        1,
    );
    let base_key = identity(&base).key;

    let mut other_owner = base.clone();
    other_owner.owner = "account-b".into();
    assert_ne!(
        identity(&other_owner).key,
        base_key,
        "a different owner must be a different ingress key"
    );

    let mut other_source = base.clone();
    other_source.source = source("other-module");
    assert_ne!(
        identity(&other_source).key,
        base_key,
        "a different source Module must be a different ingress key"
    );

    let mut other_external = base.clone();
    other_external.external_event_id = "msg-2".into();
    assert_ne!(
        identity(&other_external).key,
        base_key,
        "a different external event identity must be a different ingress key"
    );

    // Content, kind, relation, and revision are NOT part of the key: the key
    // is only the deduplication namespace.
    let mut same_namespace = base.clone();
    same_namespace.revision = 9;
    assert_eq!(
        identity(&same_namespace).key,
        base_key,
        "the key must ignore content and revision"
    );
}

#[test]
fn key_text_is_a_sha256_digest() {
    let key = identity(&premise(
        "account-a",
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a"],
        json!({"text":"hello"}),
        1,
    ))
    .key;
    let text = key.as_str();
    assert!(text.starts_with("sha256:"));
    assert_eq!(text.len(), 71);
    let reparsed: dolly_core_domain::HostIngressKey = text.parse().unwrap();
    assert_eq!(reparsed, key);
    assert!("not-a-digest".parse::<dolly_core_domain::HostIngressKey>().is_err());
}

// ---------------------------------------------------------------------------
// Operation digest: ordered target Pages and canonical equivalence
// ---------------------------------------------------------------------------

#[test]
fn operation_digest_binds_ordered_target_pages() {
    let base = premise(
        "account-a",
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a", "page-b"],
        json!({"text":"hello"}),
        1,
    );
    let base_id = identity(&base);

    let mut reordered = base.clone();
    reordered.target_page_ids = vec![page("page-b"), page("page-a")];
    let reordered_id = identity(&reordered);

    assert_eq!(reordered_id.key, base_id.key, "same namespace under one key");
    assert_ne!(
        reordered_id.operation_digest,
        base_id.operation_digest,
        "reordering target Pages must change the operation digest and conflict"
    );

    let mut widened = base.clone();
    widened.target_page_ids = vec![page("page-a"), page("page-b"), page("page-c")];
    assert_ne!(
        identity(&widened).operation_digest,
        base_id.operation_digest,
        "adding a target Page must change the digest"
    );
}

#[test]
fn canonical_equivalent_targets_collapse_duplicates() {
    let base = premise(
        "account-a",
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a", "page-b"],
        json!({"text":"hello"}),
        1,
    );
    let mut duplicated = base.clone();
    duplicated.target_page_ids = vec![
        page("page-a"),
        page("page-a"),
        page("page-b"),
        page("page-a"),
    ];
    let base_id = identity(&base);
    let duplicated_id = identity(&duplicated);

    assert_eq!(
        duplicated_id.canonical_target_page_ids,
        vec!["page-a".to_string(), "page-b".to_string()],
        "duplicates collapse preserving first-occurrence order"
    );
    assert_eq!(
        duplicated_id.operation_digest, base_id.operation_digest,
        "canonical-equivalent target lists share one operation digest"
    );
}

#[test]
fn operation_digest_binds_content_kind_relation_generation_and_revision() {
    let base = premise(
        "account-a",
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a"],
        json!({"text":"hello"}),
        1,
    );
    let base_digest = identity(&base).operation_digest;

    let mut different_content = base.clone();
    different_content.payload = payload(json!({"text":"goodbye"}));
    assert_ne!(
        identity(&different_content).operation_digest,
        base_digest,
        "content must be bound into the digest"
    );

    let mut different_kind = base.clone();
    different_kind.kind = HostIngressKind::Edit;
    different_kind.references_external_event_id = Some("msg-0".into());
    assert_ne!(
        identity(&different_kind).operation_digest,
        base_digest,
        "lifecycle kind and edit/delete relation must be bound into the digest"
    );

    let mut different_reference = different_kind.clone();
    different_reference.references_external_event_id = Some("msg-000".into());
    assert_ne!(
        identity(&different_reference).operation_digest,
        identity(&different_kind).operation_digest,
        "the referenced original must be bound into the digest"
    );

    let mut different_generation = base.clone();
    different_generation.source.generation = ExtensionGeneration::new(8).unwrap();
    assert_ne!(
        identity(&different_generation).operation_digest,
        base_digest,
        "the source generation must be bound into the digest"
    );

    let mut different_revision = base.clone();
    different_revision.revision = 2;
    assert_ne!(
        identity(&different_revision).operation_digest,
        base_digest,
        "the revision fence must be bound into the digest"
    );
}

// ---------------------------------------------------------------------------
// Premise validation
// ---------------------------------------------------------------------------

#[test]
fn edit_and_delete_must_name_the_original_and_message_forbids_it() {
    let base = premise(
        "account-a",
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a"],
        json!({"text":"hello"}),
        1,
    );

    let mut orphaned_edit = base.clone();
    orphaned_edit.kind = HostIngressKind::Edit;
    assert_eq!(
        derive_ingress_identity(&orphaned_edit),
        Err(HostIngressPremiseError::InvalidRelation(
            "edit/delete premises must name references_external_event_id".into()
        ))
    );

    let mut orphaned_delete = base.clone();
    orphaned_delete.kind = HostIngressKind::Delete;
    assert!(matches!(
        derive_ingress_identity(&orphaned_delete),
        Err(HostIngressPremiseError::InvalidRelation(_))
    ));

    let mut message_with_reference = base.clone();
    message_with_reference.references_external_event_id = Some("msg-0".into());
    assert!(matches!(
        derive_ingress_identity(&message_with_reference),
        Err(HostIngressPremiseError::InvalidRelation(_))
    ));

    let mut valid_edit = base.clone();
    valid_edit.kind = HostIngressKind::Edit;
    valid_edit.references_external_event_id = Some("msg-0".into());
    assert!(derive_ingress_identity(&valid_edit).is_ok());
}

#[test]
fn target_pages_must_be_nonempty_and_bounded() {
    let base = premise(
        "account-a",
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a"],
        json!({"text":"hello"}),
        1,
    );
    let mut empty = base.clone();
    empty.target_page_ids.clear();
    assert!(matches!(
        derive_ingress_identity(&empty),
        Err(HostIngressPremiseError::InvalidTargetPages(_))
    ));

    let mut oversized = base.clone();
    oversized.target_page_ids = (0..65)
        .map(|index| page(&format!("page-{index:02}")))
        .collect();
    assert!(matches!(
        derive_ingress_identity(&oversized),
        Err(HostIngressPremiseError::InvalidTargetPages(_))
    ));
}

#[test]
fn oversized_payload_is_rejected_before_identity() {
    let base = premise(
        "account-a",
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a"],
        json!({"data": "x".repeat(520 * 1024)}),
        1,
    );
    assert!(matches!(
        derive_ingress_identity(&base),
        Err(HostIngressPremiseError::PayloadTooLarge(_))
    ));
}

#[test]
fn owner_and_external_id_bounds_are_enforced() {
    let base = premise(
        "account-a",
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a"],
        json!({"text":"hello"}),
        1,
    );

    let mut long_owner = base.clone();
    long_owner.owner = "x".repeat(257);
    assert!(matches!(
        derive_ingress_identity(&long_owner),
        Err(HostIngressPremiseError::InvalidOwner(_))
    ));
    let mut empty_owner = base.clone();
    empty_owner.owner.clear();
    assert!(matches!(
        derive_ingress_identity(&empty_owner),
        Err(HostIngressPremiseError::InvalidOwner(_))
    ));

    let mut long_external = base.clone();
    long_external.external_event_id = "x".repeat(513);
    assert!(matches!(
        derive_ingress_identity(&long_external),
        Err(HostIngressPremiseError::InvalidExternalId(_))
    ));
    let mut controlling = base.clone();
    controlling.external_event_id = "msg\u{1}a".into();
    assert!(matches!(
        derive_ingress_identity(&controlling),
        Err(HostIngressPremiseError::InvalidExternalId(_))
    ));
}

#[test]
fn revision_bounds_are_enforced() {
    let base = premise(
        "account-a",
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a"],
        json!({"text":"hello"}),
        1,
    );
    let mut zero = base.clone();
    zero.revision = 0;
    assert_eq!(
        derive_ingress_identity(&zero),
        Err(HostIngressPremiseError::InvalidRevision(0))
    );
}

// ---------------------------------------------------------------------------
// Command building
// ---------------------------------------------------------------------------

#[test]
fn build_ingress_command_uses_minted_block_id_and_canonical_pages() {
    let base = premise(
        "account-a",
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-b", "page-a", "page-b"],
        json!({"text":"hello"}),
        1,
    );
    let base_id = identity(&base);
    let block_id: dolly_core_domain::BlockId =
        "0198ab31-6c44-7e8a-b2bb-000000000001".parse().unwrap();
    let command = build_ingress_command(&base_id, &block_id, &base);

    let CoreCommand::Ingress(ingress) = &command else {
        panic!("expected an Ingress command");
    };
    assert_eq!(ingress.block_id, block_id.to_string());
    assert_eq!(ingress.pages, vec!["page-b".to_string(), "page-a".to_string()]);
    assert_eq!(ingress.ingress_key, base_id.key.to_string());
    assert_eq!(ingress.operation_digest, base_id.operation_digest);
    assert_eq!(ingress.runtime_source, "org.dolly.channel#receiver#instance-a");
    assert_eq!(ingress.command_id, format!("host-ingress-{}", base_id.key));
    assert_eq!(
        ingress.block,
        json!({"text":"hello"}),
        "the payload must round-trip into the Core block"
    );
}

#[test]
fn canonical_target_pages_are_order_preserving_and_deduped() {
    let pages = [page("c"), page("a"), page("c"), page("b"), page("a")];
    assert_eq!(
        canonical_target_page_ids(&pages),
        vec!["c".to_string(), "a".to_string(), "b".to_string()]
    );
}
