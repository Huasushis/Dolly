//! Vector runner for the bounded WP-021A complete ActivationPayload
//! reconstruction oracle.
//!
//! Loads the authoritative `TST-FILTER-007-output-reachability` vector from
//! the read-only imported `dolly-spec` tree and checks every `expected`
//! assertion (`equals`, path form `/a/b`) and the empty `emitted` list.
//!
//! The vector fixes the contract: reconstruction is authorized by the
//! Host-trusted manifest Block bytes, the frozen manifest envelope digest,
//! and the exact Asset-view and BlockRef-relation grants, and the prepared
//! output is archival byte evidence only (spec `filter-two-thirds.md` §4-§5).
//! Of the twelve enumerated forgery classes plus the two attacker-reseal
//! channels, ONLY the exact v1 projection of the trusted selected Block is
//! accepted: a bounded description when enabled; Text and authorized Asset
//! and enabled authorized BlockRef Parts in original order; no input JSON
//! Parts; one appended normalized signal; and empty Actions, metadata, and
//! hints. Recomputing the output digest or re-supplying the forged bytes as
//! archival `preparedOutput` cannot authorize a deviation.
//!
//! The vector is data-free (its `initial` block fixes the authority role and
//! the forgery/reseal surfaces, not concrete bytes), so the runner supplies
//! one first-party conforming fixture and derives every forgery by canonical
//! mutation of that fixture, preserving the vector bytes unchanged. This is
//! not a storage, codec, ledger, or crash runner: `crash_label` is null and
//! `emitted` is empty because the oracle is pure reconstruction/rejection
//! with no durable side effect.

use std::{
    fs,
    path::{Path, PathBuf},
};

use dolly_canonical_json::{CanonicalBytes, Sha256Digest, canonicalize};
use dolly_filter_arithmetic::{
    BlockSourcePart, ClaimedPayload, PayloadBudgets, ProjectedPart, ProjectedPayload,
    ProjectedSignal, ReconstructionAuthorities, SelectionBinding, TrustedBlock,
    reconstruct_complete_activation_payload,
};
use serde_json::{Map, Value, json};

fn spec_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("dolly-spec")
}

fn read(path: impl AsRef<Path>) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

fn read_vector(name: &str) -> Value {
    let vector = read(
        spec_root()
            .join("test-vectors/extensions")
            .join(format!("{name}.json")),
    );
    assert_eq!(vector["schema"], "dolly.test-vector/v1");
    assert_eq!(vector["kind"], "extension");
    vector
}

fn navigate<'a>(value: &'a Value, path: &str) -> &'a Value {
    let mut current = value;
    for segment in path.trim_start_matches('/').split('/') {
        current = match current {
            Value::Array(array) => match segment.parse::<usize>() {
                Ok(index) => array
                    .get(index)
                    .unwrap_or_else(|| panic!("array index {index} out of bounds at {path}")),
                Err(_) => panic!("non-numeric segment {segment} on array at {path}"),
            },
            _ => &current[segment],
        };
    }
    current
}

fn check_assertions(result: &Value, vector: &Value) {
    for assertion in vector["expected"]["assertions"]
        .as_array()
        .expect("expected.assertions must be an array")
    {
        let path = assertion["path"].as_str().expect("assertion path");
        let actual = navigate(result, path);
        match assertion["op"].as_str().expect("assertion op") {
            "equals" => assert_eq!(
                actual, &assertion["value"],
                "TST-FILTER assertion failed at {path}"
            ),
            other => panic!("unsupported assertion op {other}"),
        }
    }
}

fn check_emitted(actual: &[Value], vector: &Value) {
    let expected = vector["expected"]["emitted"]
        .as_array()
        .expect("expected.emitted must be an array");
    assert_eq!(actual.len(), expected.len(), "emitted entry count");
    for (actual_entry, expected_entry) in actual.iter().zip(expected.iter()) {
        assert_eq!(actual_entry, expected_entry, "emitted entry mismatch");
    }
}

/// One evaluated vector: the assertion-addressable result tree plus the
/// emitted entries.
struct Evaluated {
    result: Value,
    emitted: Vec<Value>,
}

// ---- Runner-supplied conforming fixture -----------------------------------
//
// The vector is data-free, so every concrete byte below is first-party and in
// spec bounds; the oracle must accept exactly the v1 projection of this
// fixture and reject every deviation enumerated by the vector.

const INSTANCE_ID: &str = "0198ab31-6c44-7e8a-b2bb-000000000450";
const MODULE_ID: &str = "expert-a";
const BLOCK_ID: &str = "0198ab31-6c44-7e8a-b2bb-000000000401";
const FROZEN_ENVELOPE: [u8; 32] = [0x41; 32];
const SUBSTITUTE_ENVELOPE: [u8; 32] = [0x42; 32];
const DESCRIPTION: &str = "expert-a review of the two-thirds mean";
const TEXT: &str = "signal-affecting analysis";
const ASSET_REFERENCE: &str = "asset-1";
const ASSET_BYTES: &str = "asset payload";
const BLOCK_REF_REFERENCE: &str = "br-1";
const JSON_SCHEMA_URI: &str = "https://dolly.example/spec/0.1/schemas/filter-signal.schema.json";
const JSON_BYTES: &str =
    "{\"schema\":\"dolly.filter-signal/v1\",\"channel\":\"other\",\"score\":100}";
const SIGNAL_CHANNEL: &str = "default";
const SIGNAL_BYTES: &str =
    "{\"schema\":\"dolly.filter-signal/v1\",\"channel\":\"default\",\"score\":640}";
const OTHER_CHANNEL: &str = "other";
const NORMALIZED_CHANNEL: &str = "default";
const NORMALIZED_SCORE: u64 = 640;
const ASSET_REFERENCES: [&str; 1] = [ASSET_REFERENCE];
const BLOCK_REF_REFERENCES: [&str; 1] = [BLOCK_REF_REFERENCE];

/// The trusted selected Block: full parts in canonical delivery order, the
/// frozen manifest envelope digest, and the bounded description. The
/// `block_ref` and both Filter signals are present in the source but must
/// not reach the projection under the honest authority (BlockRef not
/// enabled, JSON Parts never copied in v1).
static SOURCE_PARTS: [BlockSourcePart<'static>; 6] = [
    BlockSourcePart::Text(TEXT),
    BlockSourcePart::Asset {
        reference: ASSET_REFERENCE,
        bytes: ASSET_BYTES,
    },
    BlockSourcePart::BlockRef {
        reference: BLOCK_REF_REFERENCE,
    },
    BlockSourcePart::Json {
        schema_uri: JSON_SCHEMA_URI,
        bytes: JSON_BYTES,
    },
    BlockSourcePart::Signal {
        channel: SIGNAL_CHANNEL,
        bytes: SIGNAL_BYTES,
    },
    BlockSourcePart::Signal {
        channel: OTHER_CHANNEL,
        bytes: JSON_BYTES,
    },
];

/// The independent witness for the exact v1 projection of the fixture (spec
/// §4): description copied, Text and the authorized Asset in original order,
/// the one appended normalized signal, and empty Actions, metadata, and
/// hints. The oracle must reconstruct byte-for-byte the canonical form of
/// this witness.
fn witness_payload() -> ProjectedPayload<'static> {
    ProjectedPayload {
        description: Some(DESCRIPTION),
        parts: vec![
            ProjectedPart::Text { bytes: TEXT },
            ProjectedPart::Asset {
                reference: ASSET_REFERENCE,
                bytes: ASSET_BYTES,
            },
        ],
        signal: ProjectedSignal {
            channel: NORMALIZED_CHANNEL,
            score: NORMALIZED_SCORE,
        },
        actions: Vec::new(),
        metadata: Default::default(),
        hints: Default::default(),
    }
}

/// The honest AuthorityContext: frozen envelope digest, binding, full
/// selected Block, copy policy, exact grants, normalized signal, and budgets
/// given to the validator by Host authority.
fn honest_authorities() -> ReconstructionAuthorities<'static> {
    ReconstructionAuthorities {
        frozen_envelope_digest: &FROZEN_ENVELOPE,
        selected_binding: SelectionBinding {
            instance_id: INSTANCE_ID,
            module_id: MODULE_ID,
            block_id: BLOCK_ID,
        },
        selected_block: TrustedBlock {
            producer: (INSTANCE_ID, MODULE_ID),
            block_id: BLOCK_ID,
            envelope_digest: &FROZEN_ENVELOPE,
            description: Some(DESCRIPTION),
            parts: &SOURCE_PARTS,
        },
        copy_description: true,
        enable_block_ref: false,
        asset_references: &ASSET_REFERENCES,
        block_ref_references: &BLOCK_REF_REFERENCES,
        normalized_signal: ProjectedSignal {
            channel: NORMALIZED_CHANNEL,
            score: NORMALIZED_SCORE,
        },
        budgets: PayloadBudgets {
            max_part_bytes: 2_048,
            max_canonical_jcs_bytes: 4_096,
        },
    }
}

/// Canonical bytes plus the (self-consistent, resealed) output digest for
/// the payload given as `serde_json::Value`. The digest is always recomputed
/// over the exact supplied bytes, exactly as an attacker would reseal it; the
/// oracle must still reject whenever the bytes deviate.
fn reseal(value: &Value) -> (CanonicalBytes, Sha256Digest) {
    canonicalize(value).unwrap()
}

/// One forged candidate from the vector's enumerations: for claim forgeries,
/// the honest authorities with a canonically mutated claim; for authority
/// forgeries, forged authorities with the honest claim; for reseals, a
/// forged claim whose digest (and optionally archival `preparedOutput`) is
/// recomputed over the forged bytes. Every returned candidate must be
/// rejected by the oracle.
fn forgery(
    class: &str,
    honest_claim: &Value,
    forged_claim: &Value,
) -> (
    ReconstructionAuthorities<'static>,
    CanonicalBytes,
    Sha256Digest,
    Option<CanonicalBytes>,
) {
    let honest = |a: ReconstructionAuthorities<'static>| {
        let (bytes, digest) = reseal(honest_claim);
        (a, bytes, digest, None)
    };
    match class {
        "action" => {
            let (bytes, digest) = reseal(forged_claim);
            (honest_authorities(), bytes, digest, None)
        }
        "text" => {
            let (bytes, digest) = reseal(forged_claim);
            (honest_authorities(), bytes, digest, None)
        }
        "description" => {
            let (bytes, digest) = reseal(forged_claim);
            (honest_authorities(), bytes, digest, None)
        }
        "asset" => {
            let (bytes, digest) = reseal(forged_claim);
            (honest_authorities(), bytes, digest, None)
        }
        "block_ref" => {
            let (bytes, digest) = reseal(forged_claim);
            (honest_authorities(), bytes, digest, None)
        }
        "extra_json" => {
            let (bytes, digest) = reseal(forged_claim);
            (honest_authorities(), bytes, digest, None)
        }
        "metadata" => {
            let (bytes, digest) = reseal(forged_claim);
            (honest_authorities(), bytes, digest, None)
        }
        "hint" => {
            let (bytes, digest) = reseal(forged_claim);
            (honest_authorities(), bytes, digest, None)
        }
        "manifest_block_substitution" => {
            // A different trusted Block with a different envelope digest is
            // substituted for the frozen selected Block.
            let mut forged_auth = honest_authorities();
            forged_auth.selected_block.envelope_digest = &SUBSTITUTE_ENVELOPE;
            honest(forged_auth)
        }
        "asset_authorization" => {
            // The exact Asset grant is changed: asset-1 is no longer
            // authorized, so an honest claim that projects it deviates.
            let mut forged_auth = honest_authorities();
            forged_auth.asset_references = &[];
            honest(forged_auth)
        }
        "block_ref_authorization" => {
            // The BlockRef relation is changed: BlockRef is enabled and
            // br-1 granted, so the honest claim (which lacks it) deviates.
            let mut forged_auth = honest_authorities();
            forged_auth.enable_block_ref = true;
            honest(forged_auth)
        }
        "output_budget" => {
            // The frozen Part budget is enforced: the reconstruction of the
            // honest claim cannot fit a 4-byte budget.
            let mut forged_auth = honest_authorities();
            forged_auth.budgets.max_part_bytes = 4;
            honest(forged_auth)
        }
        "output_digest" => {
            // The attacker reseals the output digest over forged bytes.
            let (bytes, digest) = reseal(forged_claim);
            (honest_authorities(), bytes, digest, None)
        }
        "prepared_output" => {
            // The attacker re-supplies the forged bytes as archival
            // preparedOutput evidence.
            let (bytes, digest) = reseal(forged_claim);
            let prepared = bytes.clone();
            (honest_authorities(), bytes, digest, Some(prepared))
        }
        other => panic!("unknown forgery class {other}"),
    }
}

/// Build each vector-enumerated forged claim as canonical JSON bytes plus
/// its resealed digest, so the per-class loop below compares a single
/// (authorities, claim) shape.
fn forged_claims() -> Vec<(String, Value)> {
    let base = serde_json::to_value(witness_payload()).unwrap();
    let mut claims: Vec<(String, Value)> = Vec::new();
    let mut push = |class: &str, mutate: &dyn Fn(&mut Value)| {
        let mut value = base.clone();
        mutate(&mut value);
        claims.push((class.to_string(), value));
    };
    push("action", &|v| {
        v["actions"] = json!(["forged_action"]);
    });
    push("text", &|v| {
        v["parts"][0]["bytes"] = json!("changed analysis");
    });
    push("description", &|v| {
        v["description"] = json!("forged description");
    });
    push("asset", &|v| {
        v["parts"].as_array_mut().unwrap().push(json!({
            "kind": "asset",
            "reference": "asset-forged",
            "bytes": "forged asset"
        }));
    });
    push("block_ref", &|v| {
        v["parts"].as_array_mut().unwrap().push(json!({
            "kind": "block_ref",
            "reference": "br-forged"
        }));
    });
    push("extra_json", &|v| {
        v["parts"].as_array_mut().unwrap().push(json!({
            "kind": "json",
            "schema_uri": JSON_SCHEMA_URI,
            "bytes": JSON_BYTES
        }));
    });
    push("metadata", &|v| {
        v["metadata"] = json!({"owner": "attacker"});
    });
    push("hint", &|v| {
        v["hints"] = json!({"experimental": true});
    });
    push("output_digest", &|v| {
        v["metadata"] = json!({"owner": "attacker"});
    });
    push("prepared_output", &|v| {
        v["hints"] = json!({"experimental": true});
    });
    claims
}

fn evaluate_tst_filter_007(vector: &Value) -> Evaluated {
    // Deterministic honest claim: canonical bytes of the witness projection,
    // its digest, and no archival preparedOutput.
    let witness = witness_payload();
    let (claim_bytes, claim_digest) = canonicalize(&witness).unwrap();
    let honest_claim = serde_json::to_value(&witness).unwrap();

    // The exact v1 projection MUST be accepted, and the reported result of
    // the accepted projection must match the vector assertions.
    let authorities = honest_authorities();
    let receipt = match reconstruct_complete_activation_payload(
        &authorities,
        &ClaimedPayload {
            canonical_bytes: claim_bytes.as_bytes(),
            output_digest: &claim_digest,
            prepared_output: None,
        },
    ) {
        Ok(receipt) => receipt,
        Err(error) => panic!("the exact v1 projection must be accepted: {error:?}"),
    };
    assert_eq!(
        receipt.payload,
        witness_payload(),
        "the oracle must reconstruct byte-for-byte the exact v1 projection"
    );
    assert_eq!(
        receipt.input_json_parts_copied, 0,
        "v1 copies no input JSON Parts"
    );

    // Every forgery and reseal class enumerated by the vector must be
    // rejected; any acceptance poisons the count.
    let forged_claims = forged_claims();
    let mut accepted_forgery_count: u64 = 0;
    for class in vector["initial"]["forgeries"]
        .as_array()
        .expect("initial.forgeries must be an array")
    {
        let class = class.as_str().expect("forgery class");
        // Authority forgeries reuse the honest claim; claim forgeries use
        // their canonically mutated claim.
        let class_value = forged_claims
            .iter()
            .find(|(name, _)| name == class)
            .map(|(_, value)| value)
            .unwrap_or(&honest_claim);
        let (authorities, bytes, digest, prepared) = forgery(class, &honest_claim, class_value);
        let claim = ClaimedPayload {
            canonical_bytes: bytes.as_bytes(),
            output_digest: &digest,
            prepared_output: prepared.as_ref().map(|p| p.as_bytes()),
        };
        if reconstruct_complete_activation_payload(&authorities, &claim).is_ok() {
            accepted_forgery_count += 1;
        }
    }
    for class in vector["initial"]["attacker_reseals"]
        .as_array()
        .expect("initial.attacker_reseals must be an array")
    {
        let class = class.as_str().expect("attacker reseal class");
        let class_value = forged_claims
            .iter()
            .find(|(name, _)| name == class)
            .map(|(_, value)| value)
            .unwrap_or(&honest_claim);
        let (authorities, bytes, digest, prepared) = forgery(class, &honest_claim, class_value);
        let claim = ClaimedPayload {
            canonical_bytes: bytes.as_bytes(),
            output_digest: &digest,
            prepared_output: prepared.as_ref().map(|p| p.as_bytes()),
        };
        if reconstruct_complete_activation_payload(&authorities, &claim).is_ok() {
            accepted_forgery_count += 1;
        }
    }

    let mut output = Map::new();
    output.insert(
        "actions".to_string(),
        serde_json::to_value(&receipt.payload.actions).unwrap(),
    );
    output.insert(
        "metadata".to_string(),
        serde_json::to_value(&receipt.payload.metadata).unwrap(),
    );
    output.insert(
        "hints".to_string(),
        serde_json::to_value(&receipt.payload.hints).unwrap(),
    );

    let mut input = Map::new();
    input.insert(
        "json_parts_copied".to_string(),
        json!(receipt.input_json_parts_copied),
    );

    let mut result = Map::new();
    result.insert(
        "accepted_forgery_count".to_string(),
        json!(accepted_forgery_count),
    );
    result.insert("output".to_string(), Value::Object(output));
    result.insert("input".to_string(), Value::Object(input));
    Evaluated {
        result: Value::Object(result),
        emitted: Vec::new(),
    }
}

#[test]
fn tst_filter_007_output_reachability() {
    let vector = read_vector("TST-FILTER-007-output-reachability");
    assert_eq!(vector["test_id"], "TST-FILTER-007");
    assert_eq!(
        vector["stimulus"]["command"],
        "reconstruct_complete_activation_payload_from_trusted_selected_block"
    );
    let evaluated = evaluate_tst_filter_007(&vector);
    check_assertions(&evaluated.result, &vector);
    check_emitted(&evaluated.emitted, &vector);
}
