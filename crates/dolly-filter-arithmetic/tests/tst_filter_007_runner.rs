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
                actual,
                &assertion["value"],
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

/// The runner-supplied conforming fixture. The vector is data-free, so every
/// concrete byte here is first-party and in spec bounds; the oracle must
/// accept exactly the v1 projection of this fixture and reject every
/// deviation enumerated by the vector.
struct Fixture<'a> {
    instance_id: &'a str,
    module_id: &'a str,
    block_id: &'a str,
    frozen_envelope_digest: [u8; 32],
    description: &'a str,
    text: &'a str,
    asset_reference: &'a str,
    asset_bytes: &'a str,
    block_ref_reference: &'a str,
    json_schema_uri: &'a str,
    json_bytes: &'a str,
    signal_channel: &'a str,
    signal_bytes: &'a str,
    other_channel: &'a str,
    normalized_channel: &'a str,
    normalized_score: u64,
    asset_references: [&'a str; 1],
    block_ref_references: [&'a str; 1],
    max_part_bytes: u64,
    max_canonical_jcs_bytes: u64,
}

impl<'a> Fixture<'a> {
    fn build() -> Self {
        Self {
            instance_id: "0198ab31-6c44-7e8a-b2bb-000000000450",
            module_id: "expert-a",
            block_id: "0198ab31-6c44-7e8a-b2bb-000000000401",
            frozen_envelope_digest: [0x41; 32],
            description: "expert-a review of the two-thirds mean",
            text: "signal-affecting analysis",
            asset_reference: "asset-1",
            asset_bytes: "asset payload",
            block_ref_reference: "br-1",
            json_schema_uri: "https://dolly.example/spec/0.1/schemas/filter-signal.schema.json",
            json_bytes: "{\"schema\":\"dolly.filter-signal/v1\",\"channel\":\"other\",\"score\":100}",
            signal_channel: "default",
            signal_bytes: "{\"schema\":\"dolly.filter-signal/v1\",\"channel\":\"default\",\"score\":640}",
            other_channel: "other",
            normalized_channel: "default",
            normalized_score: 640,
            asset_references: ["asset-1"],
            block_ref_references: ["br-1"],
            max_part_bytes: 2_048,
            max_canonical_jcs_bytes: 4_096,
        }
    }

    /// The exact trusted selected Block: full parts in canonical delivery
    /// order, the frozen manifest envelope digest, and the bounded
    /// description. `block_ref` and both Filter signals are present in the
    /// source but must not reach the projection under the honest authority
    /// (BlockRef not enabled, JSON Parts never copied in v1).
    fn trusted_block(&self, envelope: [u8; 32]) -> TrustedBlock<'a> {
        TrustedBlock {
            producer: (self.instance_id, self.module_id),
            block_id: self.block_id,
            envelope_digest: &envelope,
            description: Some(self.description),
            parts: &[
                BlockSourcePart::Text(self.text),
                BlockSourcePart::Asset {
                    reference: self.asset_reference,
                    bytes: self.asset_bytes,
                },
                BlockSourcePart::BlockRef {
                    reference: self.block_ref_reference,
                },
                BlockSourcePart::Json {
                    schema_uri: self.json_schema_uri,
                    bytes: self.json_bytes,
                },
                BlockSourcePart::Signal {
                    channel: self.signal_channel,
                    bytes: self.signal_bytes,
                },
                BlockSourcePart::Signal {
                    channel: self.other_channel,
                    bytes: self.json_bytes,
                },
            ],
        }
    }

    /// The honest ReconstructionAuthorities: frozen envelope digest, binding, full
    /// selected Block, copy policy, exact grants, normalized signal, and
    /// budgets given to the validator by Host authority.
    fn authorities(&self) -> ReconstructionAuthorities<'a> {
        ReconstructionAuthorities {
            frozen_envelope_digest: &self.frozen_envelope_digest,
            selected_binding: SelectionBinding {
                instance_id: self.instance_id,
                module_id: self.module_id,
                block_id: self.block_id,
            },
            selected_block: self.trusted_block(self.frozen_envelope_digest),
            copy_description: true,
            enable_block_ref: false,
            asset_references: &self.asset_references,
            block_ref_references: &self.block_ref_references,
            normalized_signal: ProjectedSignal {
                channel: self.normalized_channel,
                score: self.normalized_score,
            },
            budgets: PayloadBudgets {
                max_part_bytes: self.max_part_bytes,
                max_canonical_jcs_bytes: self.max_canonical_jcs_bytes,
            },
        }
    }

    /// The independent witness for the exact v1 projection of the fixture
    /// (spec §4): description copied, Text and the authorized Asset in
    /// original order, the one appended normalized signal, and empty Actions,
    /// metadata, and hints. The oracle must reconstruct byte-for-byte the
    /// canonical form of this witness.
    fn witness(&self) -> ProjectedPayload<'a> {
        ProjectedPayload {
            description: Some(self.description),
            parts: vec![
                ProjectedPart::Text { bytes: self.text },
                ProjectedPart::Asset {
                    reference: self.asset_reference,
                    bytes: self.asset_bytes,
                },
            ],
            signal: ProjectedSignal {
                channel: self.normalized_channel,
                score: self.normalized_score,
            },
            actions: Vec::new(),
            metadata: Default::default(),
            hints: Default::default(),
        }
    }

    /// Canonical bytes plus the (self-consistent, resealed) output digest for
    /// the projection given as `serde_json::Value`. The digest is always
    /// recomputed over the exact supplied bytes, exactly as an attacker would
    /// reseal it; the oracle must still reject whenever the bytes deviate.
    fn reseal(&self, value: &Value) -> (CanonicalBytes, Sha256Digest) {
        canonicalize(value).unwrap()
    }

    /// One forged candidate from the vector's enumerations: for claim
    /// forgeries, the honest authorities with a canonically mutated claim;
    /// for authority forgeries, forged authorities with the honest claim;
    /// for reseals, a forged claim whose digest (and optionally archival
    /// `preparedOutput`) is recomputed over the forged bytes. Every returned
    /// candidate must be rejected by the oracle.
    fn forgery(
        &self,
        class: &str,
        honest_claim: &Value,
    ) -> (
        ReconstructionAuthorities<'a>,
        CanonicalBytes,
        Sha256Digest,
        Option<CanonicalBytes>,
    ) {
        let honest = |a: ReconstructionAuthorities<'a>| {
            let (bytes, digest) = self.reseal(honest_claim);
            (a, bytes, digest, None)
        };
        let mutated = |a: ReconstructionAuthorities<'a>, mutate: &dyn Fn(&mut Value)| {
            let mut value = honest_claim.clone();
            mutate(&mut value);
            let (bytes, digest) = self.reseal(&value);
            (a, bytes, digest, None)
        };
        match class {
            "action" => mutated(self.authorities(), &|v| {
                v["actions"] = json!(["forged_action"]);
            }),
            "text" => mutated(self.authorities(), &|v| {
                v["parts"][0]["bytes"] = json!("changed analysis");
            }),
            "description" => mutated(self.authorities(), &|v| {
                v["description"] = json!("forged description");
            }),
            "asset" => mutated(self.authorities(), &|v| {
                v["parts"].as_array_mut().unwrap().push(json!({
                    "kind": "asset",
                    "reference": "asset-forged",
                    "bytes": "forged asset"
                }));
            }),
            "block_ref" => mutated(self.authorities(), &|v| {
                v["parts"].as_array_mut().unwrap().push(json!({
                    "kind": "block_ref",
                    "reference": "br-forged"
                }));
            }),
            "extra_json" => mutated(self.authorities(), &|v| {
                v["parts"].as_array_mut().unwrap().push(json!({
                    "kind": "json",
                    "schema_uri": self.json_schema_uri,
                    "bytes": self.json_bytes
                }));
            }),
            "metadata" => mutated(self.authorities(), &|v| {
                v["metadata"] = json!({"owner": "attacker"});
            }),
            "hint" => mutated(self.authorities(), &|v| {
                v["hints"] = json!({"experimental": true});
            }),
            "manifest_block_substitution" => {
                // A different trusted Block with a different envelope digest
                // is substituted for the frozen selected Block.
                let mut forged_auth = self.authorities();
                forged_auth.selected_block = self.trusted_block([0x42; 32]);
                honest(forged_auth)
            }
            "asset_authorization" => {
                // The exact Asset grant is changed: asset-1 is no longer
                // authorized, so an honest claim that projects it deviates.
                let mut forged_auth = self.authorities();
                forged_auth.asset_references = &[];
                honest(forged_auth)
            }
            "block_ref_authorization" => {
                // The BlockRef relation is changed: BlockRef is enabled and
                // br-1 granted, so the honest claim (which lacks it) deviates.
                let mut forged_auth = self.authorities();
                forged_auth.enable_block_ref = true;
                honest(forged_auth)
            }
            "output_budget" => {
                // The frozen Part budget is enforced: the reconstruction of
                // the honest claim cannot fit a 4-byte budget.
                let mut forged_auth = self.authorities();
                forged_auth.budgets = PayloadBudgets {
                    max_part_bytes: 4,
                    max_canonical_jcs_bytes: 4_096,
                };
                honest(forged_auth)
            }
            "output_digest" => {
                // The attacker reseals the output digest over forged bytes.
                mutated(self.authorities(), &|v| {
                    v["metadata"] = json!({"owner": "attacker"});
                })
            }
            "prepared_output" => {
                // The attacker re-supplies the forged bytes as archival
                // preparedOutput evidence.
                let (authorities, bytes, digest, _) = mutated(self.authorities(), &|v| {
                    v["hints"] = json!({"experimental": true});
                });
                let prepared = bytes.clone();
                (authorities, bytes, digest, Some(prepared))
            }
            other => panic!("unknown forgery class {other}"),
        }
    }
}

fn evaluate_tst_filter_007(vector: &Value) -> Evaluated {
    let fixture = Fixture::build();

    // Deterministic honest claim: canonical bytes of the witness projection,
    // its digest, and no archival preparedOutput.
    let witness = fixture.witness();
    let (claim_bytes, claim_digest) = canonicalize(&witness).unwrap();
    let honest_claim = serde_json::to_value(&witness).unwrap();

    // The exact v1 projection MUST be accepted, and the reported result of
    // the accepted projection must match the vector assertions.
    let receipt = match reconstruct_complete_activation_payload(
        &fixture.authorities(),
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
        receipt.payload, witness,
        "the oracle must reconstruct byte-for-byte the exact v1 projection"
    );
    assert_eq!(receipt.input_json_parts_copied, 0, "v1 copies no input JSON Parts");

    // Every forgery and reseal class enumerated by the vector must be
    // rejected; any acceptance poisons the count.
    let mut accepted_forgery_count: u64 = 0;
    for class in vector["initial"]["forgeries"]
        .as_array()
        .expect("initial.forgeries must be an array")
    {
        let class = class.as_str().expect("forgery class");
        let (authorities, bytes, digest, prepared) = fixture.forgery(class, &honest_claim);
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
        let (authorities, bytes, digest, prepared) = fixture.forgery(class, &honest_claim);
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
    result.insert("accepted_forgery_count".to_string(), json!(accepted_forgery_count));
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