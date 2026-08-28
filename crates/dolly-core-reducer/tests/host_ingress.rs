//! Focused pure tests for the Host ingress identity derivation: the ingress
//! key over the authority-bound facts and external id, the operation digest
//! over the ordered target Pages and authority fences, canonical target
//! equivalence, request validation bounds, and command building.

use dolly_canonical_json::CanonicalJsonValue;
use dolly_core_domain::{HostIngressKind, HostIngressSubmitRequest, PageId};
use dolly_core_reducer::{
    CoreCommand, HostIngressPremiseError, build_ingress_command, canonical_target_page_ids,
    derive_ingress_identity, derive_ingress_key, validate_ingress_request,
};
use serde_json::{Value, json};

fn page(id: &str) -> PageId {
    id.parse().expect("test page id must be a valid PageId")
}

fn payload(value: Value) -> CanonicalJsonValue {
    serde_json::from_value(value).expect("test payload must be canonical JSON")
}

fn facts_owner() -> &'static str {
    "connection-a"
}
fn facts_extension() -> &'static str {
    "org.dolly.channel"
}
fn facts_module() -> &'static str {
    "receiver"
}
fn facts_instance() -> &'static str {
    "0198ab31-6c44-7e8a-b2bb-000000000110"
}
fn facts_generation() -> u64 {
    7
}
fn facts_revision() -> i64 {
    3
}
fn facts_graph_revision() -> i64 {
    1
}

fn request(
    external: &str,
    kind: HostIngressKind,
    references: Option<&str>,
    pages: &[&str],
    content: Value,
) -> HostIngressSubmitRequest {
    HostIngressSubmitRequest {
        external_event_id: external.into(),
        kind,
        references_external_event_id: references.map(str::to_owned),
        target_page_ids: pages.iter().map(|id| page(id)).collect(),
        payload: payload(content),
    }
}

fn identity(req: &HostIngressSubmitRequest) -> dolly_core_reducer::IngressIdentity {
    derive_ingress_identity(
        facts_owner(),
        facts_extension(),
        facts_module(),
        facts_instance(),
        facts_generation(),
        facts_revision(),
        facts_graph_revision(),
        req,
    )
    .expect("test request must derive")
}

// ---------------------------------------------------------------------------
// Ingress key: owner/source/instance/external namespace
// ---------------------------------------------------------------------------

#[test]
fn key_binds_owner_source_instance_and_external_identity() {
    let base = request(
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a"],
        json!({"text":"hello"}),
    );
    let base_key = identity(&base).key;

    assert_ne!(
        derive_ingress_key("connection-b", facts_extension(), facts_module(), facts_instance(), "msg-1"),
        base_key,
        "a different owner must be a different ingress key"
    );
    assert_ne!(
        derive_ingress_key(facts_owner(), "org.dolly.channel", "other-module", facts_instance(), "msg-1"),
        base_key,
        "a different source Module must be a different ingress key"
    );
    assert_ne!(
        derive_ingress_key(facts_owner(), facts_extension(), facts_module(), "0198ab31-6c44-7e8a-b2bb-000000000999", "msg-1"),
        base_key,
        "a different instance must be a different ingress key"
    );

    // Fences and content are NOT part of the key: only the deduplication
    // namespace.
    assert_eq!(
        derive_ingress_identity(
            facts_owner(), facts_extension(), facts_module(), facts_instance(),
            8, 4, facts_graph_revision(), &base,
        )
        .unwrap()
        .key,
        base_key,
        "the key must ignore fences"
    );

    assert_eq!(
        derive_ingress_key(facts_owner(), facts_extension(), facts_module(), facts_instance(), "msg-1"),
        base_key,
        "status derives the same key for the same principal and external id"
    );
    assert_ne!(
        derive_ingress_key(facts_owner(), facts_extension(), facts_module(), facts_instance(), "msg-2"),
        base_key,
        "a different external id is a different key"
    );
}

#[test]
fn key_text_is_a_sha256_digest() {
    let key = identity(&request(
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a"],
        json!({"text":"hello"}),
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
    let base = request(
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a", "page-b"],
        json!({"text":"hello"}),
    );
    let base_id = identity(&base);

    let reordered = request(
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-b", "page-a"],
        json!({"text":"hello"}),
    );
    let reordered_id = identity(&reordered);
    assert_eq!(reordered_id.key, base_id.key, "same namespace under one key");
    assert_ne!(
        reordered_id.operation_digest,
        base_id.operation_digest,
        "reordering target Pages must change the operation digest and conflict"
    );

    let widened = request(
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a", "page-b", "page-c"],
        json!({"text":"hello"}),
    );
    assert_ne!(
        identity(&widened).operation_digest,
        base_id.operation_digest,
        "adding a target Page must change the digest"
    );
}

#[test]
fn canonical_equivalent_targets_collapse_duplicates() {
    let base = request(
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a", "page-b"],
        json!({"text":"hello"}),
    );
    let duplicated = request(
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a", "page-a", "page-b", "page-a"],
        json!({"text":"hello"}),
    );
    let base_id = identity(&base);
    let duplicated_id = identity(&duplicated);
    assert_eq!(
        duplicated_id.canonical_target_page_ids,
        vec!["page-a".to_string(), "page-b".to_string()]
    );
    assert_eq!(
        duplicated_id.operation_digest, base_id.operation_digest,
        "canonical-equivalent target lists share one operation digest"
    );
}

#[test]
fn operation_digest_binds_content_kind_relation_generation_revision_and_graph_revision() {
    let base = request(
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a"],
        json!({"text":"hello"}),
    );
    let base_digest = identity(&base).operation_digest;

    let different_content = request(
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a"],
        json!({"text":"goodbye"}),
    );
    assert_ne!(identity(&different_content).operation_digest, base_digest);

    let different_kind = request(
        "msg-1",
        HostIngressKind::Edit,
        Some("msg-0"),
        &["page-a"],
        json!({"text":"hello edited"}),
    );
    let kind_digest = identity(&different_kind).operation_digest;
    assert_ne!(kind_digest, base_digest, "lifecycle kind must be bound");

    let different_reference = request(
        "msg-1",
        HostIngressKind::Edit,
        Some("msg-000"),
        &["page-a"],
        json!({"text":"hello edited"}),
    );
    assert_ne!(
        identity(&different_reference).operation_digest,
        kind_digest,
        "the referenced original must be bound"
    );

    assert_ne!(
        derive_ingress_identity(
            facts_owner(), facts_extension(), facts_module(), facts_instance(),
            8, facts_revision(), facts_graph_revision(), &base,
        )
        .unwrap()
        .operation_digest,
        base_digest,
        "the source generation must be bound"
    );
    assert_ne!(
        derive_ingress_identity(
            facts_owner(), facts_extension(), facts_module(), facts_instance(),
            facts_generation(), 4, facts_graph_revision(), &base,
        )
        .unwrap()
        .operation_digest,
        base_digest,
        "the revision fence must be bound"
    );
    assert_ne!(
        derive_ingress_identity(
            facts_owner(), facts_extension(), facts_module(), facts_instance(),
            facts_generation(), facts_revision(), 2, &base,
        )
        .unwrap()
        .operation_digest,
        base_digest,
        "the graph revision must be bound"
    );
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

#[test]
fn edit_and_delete_must_name_the_original_and_message_forbids_it() {
    let base = request(
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a"],
        json!({"text":"hello"}),
    );
    assert!(validate_ingress_request(&base).is_ok());

    let orphaned_edit = request("edit-1", HostIngressKind::Edit, None, &["page-a"], json!({}));
    assert!(matches!(
        validate_ingress_request(&orphaned_edit),
        Err(HostIngressPremiseError::InvalidRelation(_))
    ));

    let orphaned_delete = request("del-1", HostIngressKind::Delete, None, &["page-a"], json!({}));
    assert!(matches!(
        validate_ingress_request(&orphaned_delete),
        Err(HostIngressPremiseError::InvalidRelation(_))
    ));

    let message_with_reference =
        request("msg-1", HostIngressKind::Message, Some("msg-0"), &["page-a"], json!({}));
    assert!(matches!(
        validate_ingress_request(&message_with_reference),
        Err(HostIngressPremiseError::InvalidRelation(_))
    ));

    let valid_edit =
        request("edit-1", HostIngressKind::Edit, Some("msg-0"), &["page-a"], json!({}));
    assert!(validate_ingress_request(&valid_edit).is_ok());
}

#[test]
fn target_pages_must_be_nonempty_and_bounded() {
    let empty = request("msg-1", HostIngressKind::Message, None, &[], json!({}));
    assert!(matches!(
        validate_ingress_request(&empty),
        Err(HostIngressPremiseError::InvalidTargetPages(_))
    ));

    let oversized_ids: Vec<String> = (0..65).map(|index| format!("page-{index:02}")).collect();
    let oversized_pages: Vec<&str> = oversized_ids.iter().map(String::as_str).collect();
    let oversized = request("msg-1", HostIngressKind::Message, None, &oversized_pages, json!({}));
    assert!(matches!(
        validate_ingress_request(&oversized),
        Err(HostIngressPremiseError::InvalidTargetPages(_))
    ));
}

#[test]
fn oversized_payload_is_rejected_before_identity() {
    let incoming = request(
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-a"],
        json!({"data": "x".repeat(520 * 1024)}),
    );
    assert!(matches!(
        derive_ingress_identity(
            facts_owner(), facts_extension(), facts_module(), facts_instance(),
            facts_generation(), facts_revision(), facts_graph_revision(), &incoming,
        ),
        Err(HostIngressPremiseError::PayloadTooLarge(_))
    ));
}

#[test]
fn external_id_bounds_are_enforced() {
    let long_external = request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({}));
    validate_ingress_request(&long_external).unwrap();
    let too_long = "x".repeat(513);
    let long = request(&too_long, HostIngressKind::Message, None, &["page-a"], json!({}));
    assert!(matches!(
        validate_ingress_request(&long),
        Err(HostIngressPremiseError::InvalidExternalId(_))
    ));
    let controlling = request("msg\u{1}a", HostIngressKind::Message, None, &["page-a"], json!({}));
    assert!(matches!(
        validate_ingress_request(&controlling),
        Err(HostIngressPremiseError::InvalidExternalId(_))
    ));
}

#[test]
fn principal_fence_bounds_are_enforced() {
    let incoming = request("msg-1", HostIngressKind::Message, None, &["page-a"], json!({}));
    assert!(derive_ingress_identity(
        facts_owner(), facts_extension(), facts_module(), facts_instance(),
        0, facts_revision(), facts_graph_revision(), &incoming,
    ).is_err());
    assert!(derive_ingress_identity(
        facts_owner(), facts_extension(), facts_module(), facts_instance(),
        facts_generation(), 0, facts_graph_revision(), &incoming,
    ).is_err());
    assert!(derive_ingress_identity(
        facts_owner(), facts_extension(), facts_module(), facts_instance(),
        facts_generation(), facts_revision(), 0, &incoming,
    ).is_err());
    assert!(derive_ingress_identity(
        "", facts_extension(), facts_module(), facts_instance(),
        facts_generation(), facts_revision(), facts_graph_revision(), &incoming,
    ).is_err());
}

// ---------------------------------------------------------------------------
// Command building
// ---------------------------------------------------------------------------

#[test]
fn build_ingress_command_uses_minted_block_id_and_canonical_pages() {
    let incoming = request(
        "msg-1",
        HostIngressKind::Message,
        None,
        &["page-b", "page-a", "page-b"],
        json!({"text":"hello"}),
    );
    let base_id = identity(&incoming);
    let block_id: dolly_core_domain::BlockId =
        "0198ab31-6c44-7e8a-b2bb-000000000001".parse().unwrap();
    let command = build_ingress_command(
        &base_id,
        &block_id,
        "org.dolly.channel#receiver#0198ab31-6c44-7e8a-b2bb-000000000110",
        &incoming,
    );

    let CoreCommand::Ingress(ingress) = &command else {
        panic!("expected an Ingress command");
    };
    assert_eq!(ingress.block_id, block_id.to_string());
    assert_eq!(ingress.pages, vec!["page-b".to_string(), "page-a".to_string()]);
    assert_eq!(ingress.ingress_key, base_id.key.to_string());
    assert_eq!(ingress.operation_digest, base_id.operation_digest);
    assert_eq!(
        ingress.runtime_source,
        "org.dolly.channel#receiver#0198ab31-6c44-7e8a-b2bb-000000000110"
    );
    assert!(ingress.command_id.starts_with("host-ingress-"));
    assert_eq!(ingress.block, json!({"text":"hello"}));
}

#[test]
fn canonical_target_pages_are_order_preserving_and_deduped() {
    let pages = [page("c"), page("a"), page("c"), page("b"), page("a")];
    assert_eq!(
        canonical_target_page_ids(&pages),
        vec!["c".to_string(), "a".to_string(), "b".to_string()]
    );
}
