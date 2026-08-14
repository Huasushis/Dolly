//! Complete ActivationPayload reconstruction and rejection oracle
//! (spec `filter-two-thirds.md` §4-§5, vector `TST-FILTER-007`).
//!
//! From caller-supplied Host-trusted inputs — the manifest Block bytes, the
//! frozen manifest envelope digest, the Block selection binding, the exact
//! Asset-view and BlockRef-relation authorization grants, the copy policy,
//! the normalized signal, and the frozen byte budgets — this oracle
//! deterministically reconstructs the complete v1 projection of the selected
//! Block and accepts a claimed output only when that claim is the exact
//! canonical JCS byte form of the reconstruction.
//!
//! V1 projection rules (§4): a bounded description is copied only when
//! enabled; Text and authorized Asset and enabled authorized BlockRef Parts
//! are copied in original order; input JSON Parts are never copied
//! (`input_json_parts_copied` is always zero); the source Filter Signal Parts
//! are replaced by one appended normalized signal; and Actions, metadata, and
//! hints are always empty.
//!
//! The claimed `output_digest` is recomputed by the oracle and compared only
//! after the claimed bytes match; the archival `preparedOutput` bytes, when
//! supplied, are compared only after the bytes and digest pass. Neither is
//! ever used to authorize a deviation: matching the digest or re-supplying
//! archival evidence cannot make a different projection acceptable.
//!
//! This module is a pure reconstruction/rejection oracle: it performs no
//! storage, codec, file, or reopen work, manages no activation ledger, and
//! carries no runtime, module, or asset state. All inputs are caller-owned
//! borrows and every check is deterministic and side-effect free.

use std::collections::BTreeMap;

use dolly_canonical_json::{Sha256Digest, canonicalize};
use serde::Serialize;

/// The selection binding naming the exact Block the decision selected, as
/// recorded in the decision envelope. The oracle treats any Block that was
/// not bound by this selection as unauthorized.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SelectionBinding<'a> {
    pub instance_id: &'a str,
    pub module_id: &'a str,
    pub block_id: &'a str,
}

/// A manifest Block in the state of delivery inside the frozen manifest
/// envelope: the source parts in canonical delivery order, the bounded
/// description, and the envelope digest covering this exact Block.
///
/// The envelope digest covers the Block body as manifest-recorded; the
/// Host-side manifest envelope layer is the boundary that establishes it (no
/// manifest codec/reopen authority lives here).
#[derive(Clone, Copy, Debug)]
pub struct TrustedBlock<'a> {
    /// Producer identity tuple `(instance_id, module_id)` proven by the
    /// manifest Block.
    pub producer: (&'a str, &'a str),
    pub block_id: &'a str,
    pub envelope_digest: &'a [u8; 32],
    pub description: Option<&'a str>,
    pub parts: &'a [BlockSourcePart<'a>],
}

/// A source Part as delivered by a manifest Block.
#[derive(Clone, Copy, Debug)]
pub enum BlockSourcePart<'a> {
    Text(&'a str),
    Asset { reference: &'a str, bytes: &'a str },
    BlockRef { reference: &'a str },
    Json { schema_uri: &'a str, bytes: &'a str },
    Signal { channel: &'a str, bytes: &'a str },
}

/// The normalized Filter signal appended by the projection, replacing the
/// source Filter Signal Parts. The score is a raw score in `0..=1000`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ProjectedSignal<'a> {
    pub channel: &'a str,
    pub score: u64,
}

/// A Part of the reconstructed complete ActivationPayload.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind")]
pub enum ProjectedPart<'a> {
    Text { bytes: &'a str },
    Asset { reference: &'a str, bytes: &'a str },
    BlockRef { reference: &'a str },
}

/// The complete v1 projection of the selected Block: the copied description
/// (when enabled), the copied Parts in original order, the one appended
/// normalized signal, and the always-empty Actions, metadata, and hints.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct ProjectedPayload<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<&'a str>,
    pub parts: Vec<ProjectedPart<'a>>,
    pub signal: ProjectedSignal<'a>,
    pub actions: Vec<&'a str>,
    pub metadata: BTreeMap<&'a str, &'a str>,
    pub hints: BTreeMap<&'a str, &'a str>,
}

/// The frozen byte budgets the reconstruction (and the canonical JCS form of
/// the reconstruction) must fit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PayloadBudgets {
    /// Maximum byte length of the reconstructed Part surface: the copied
    /// description plus each copied Part payload plus the appended
    /// normalized signal's canonical JSON value.
    pub max_part_bytes: u64,
    /// Maximum byte length of the canonical JCS form of the complete
    /// reconstructed payload.
    pub max_canonical_jcs_bytes: u64,
}

/// The Host-trusted inputs that authorize a reconstruction. These are the
/// exact manifest bytes, the frozen manifest envelope digest, the binding,
/// the copy policy, the grants, the normalized signal, and the budgets that
/// applied when the decision was bound.
#[derive(Debug)]
pub struct ReconstructionAuthorities<'a> {
    pub frozen_envelope_digest: &'a [u8; 32],
    pub selected_binding: SelectionBinding<'a>,
    pub selected_block: TrustedBlock<'a>,
    pub copy_description: bool,
    pub enable_block_ref: bool,
    /// The exact authorized Asset-view: the asset references the projection
    /// may copy.
    pub asset_references: &'a [&'a str],
    /// The exact authorized BlockRef relations; effective only when
    /// `enable_block_ref` is set.
    pub block_ref_references: &'a [&'a str],
    pub normalized_signal: ProjectedSignal<'a>,
    pub budgets: PayloadBudgets,
}

/// The claimed complete ActivationPayload of a decision: the embedded
/// canonical payload bytes together with the archival output digest and,
/// when present, the archival prepared-output bytes.
///
/// Both pieces of archival evidence are compared only after the claimed
/// bytes pass; neither can authorize a deviation from the reconstruction.
#[derive(Debug)]
pub struct ClaimedPayload<'a> {
    pub canonical_bytes: &'a [u8],
    pub output_digest: &'a Sha256Digest,
    pub prepared_output: Option<&'a [u8]>,
}

/// The outcome of an accepted reconstruction.
#[derive(Debug, PartialEq, Eq)]
pub struct ProjectionReceipt<'a> {
    pub payload: ProjectedPayload<'a>,
    /// v1 never copies input JSON Parts, so this is always zero.
    pub input_json_parts_copied: u64,
}

/// Closed, copyable errors of the reconstruction oracle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayloadReconstructionError {
    /// The trusted Block is not the Block bound by the decision's selection.
    SelectionBindingMismatch,
    /// The trusted Block's envelope digest does not equal the frozen
    /// manifest envelope digest.
    EnvelopeDigestMismatch,
    /// The normalized signal score is outside the allowed `0..=1000`.
    InvalidNormalizedScore,
    /// The reconstructed Part surface does not fit the frozen Part budget.
    PartBudgetExceeded,
    /// The canonical JCS form does not fit the frozen canonical byte budget.
    CanonicalJcsBudgetExceeded,
    /// The claimed canonical payload bytes differ from the exact v1
    /// projection of the selected Block.
    PayloadBytesMismatch,
    /// The claimed output digest does not equal the digest of the claimed
    /// canonical payload bytes.
    OutputDigestMismatch,
    /// The archival prepared-output bytes differ from the accepted canonical
    /// payload bytes; re-supplying them cannot authorize a deviation.
    PreparedOutputMismatch,
    /// Canonical serialization of a closed reconstructed value failed. The
    /// covered types are always serializable in practice; this variant exists
    /// so a failure is never silently coerced.
    UnserializablePayload,
}

/// Reconstruct the complete v1 projection of the trusted selected Block and
/// accept the claimed output only if it is exactly that reconstruction.
///
/// Checks run in this documented order: selection binding, envelope digest,
/// normalized score validity, Part budget, canonical JCS budget, claimed
/// bytes, claimed digest, then archival prepared-output bytes.
pub fn reconstruct_complete_activation_payload<'a>(
    authorities: &ReconstructionAuthorities<'a>,
    claim: &ClaimedPayload<'_>,
) -> Result<ProjectionReceipt<'a>, PayloadReconstructionError> {
    let block = &authorities.selected_block;

    if block.producer
        != (
            authorities.selected_binding.instance_id,
            authorities.selected_binding.module_id,
        )
        || block.block_id != authorities.selected_binding.block_id
    {
        return Err(PayloadReconstructionError::SelectionBindingMismatch);
    }
    if block.envelope_digest != authorities.frozen_envelope_digest {
        return Err(PayloadReconstructionError::EnvelopeDigestMismatch);
    }
    if authorities.normalized_signal.score > crate::MAX_SCORE {
        return Err(PayloadReconstructionError::InvalidNormalizedScore);
    }

    let mut part_bytes: u64 = 0;
    let mut parts: Vec<ProjectedPart<'a>> = Vec::with_capacity(block.parts.len());
    let mut description: Option<&'a str> = None;

    if authorities.copy_description {
        if let Some(copied) = block.description {
            part_bytes += utf8_len(copied.as_bytes());
            description = Some(copied);
        }
    }
    for source_part in block.parts {
        match source_part {
            BlockSourcePart::Text(bytes) => {
                part_bytes += utf8_len(bytes.as_bytes());
                parts.push(ProjectedPart::Text { bytes });
            }
            BlockSourcePart::Asset { reference, bytes } => {
                if authorities.asset_references.contains(reference) {
                    part_bytes += utf8_len(bytes.as_bytes());
                    parts.push(ProjectedPart::Asset { reference, bytes });
                }
            }
            BlockSourcePart::BlockRef { reference } => {
                if authorities.enable_block_ref
                    && authorities.block_ref_references.contains(reference)
                {
                    part_bytes += utf8_len(reference.as_bytes());
                    parts.push(ProjectedPart::BlockRef { reference });
                }
            }
            // v1 never copies input JSON Parts.
            BlockSourcePart::Json { .. } => {}
            // Source Filter Signal Parts are replaced by the appended
            // normalized signal and are never copied.
            BlockSourcePart::Signal { .. } => {}
        }
    }

    let (signal_bytes, _) = canonicalize(&authorities.normalized_signal)
        .map_err(|_| PayloadReconstructionError::UnserializablePayload)?;
    part_bytes += utf8_len(signal_bytes.as_bytes());
    if part_bytes > authorities.budgets.max_part_bytes {
        return Err(PayloadReconstructionError::PartBudgetExceeded);
    }

    let payload = ProjectedPayload {
        description,
        parts,
        signal: authorities.normalized_signal,
        actions: Vec::new(),
        metadata: BTreeMap::new(),
        hints: BTreeMap::new(),
    };
    let (payload_bytes, computed_digest) =
        canonicalize(&payload).map_err(|_| PayloadReconstructionError::UnserializablePayload)?;
    if payload_bytes.as_bytes().len() as u64 > authorities.budgets.max_canonical_jcs_bytes {
        return Err(PayloadReconstructionError::CanonicalJcsBudgetExceeded);
    }

    if payload_bytes.as_bytes() != claim.canonical_bytes {
        return Err(PayloadReconstructionError::PayloadBytesMismatch);
    }
    if computed_digest != *claim.output_digest {
        return Err(PayloadReconstructionError::OutputDigestMismatch);
    }
    if let Some(prepared) = claim.prepared_output {
        if prepared != payload_bytes.as_bytes() {
            return Err(PayloadReconstructionError::PreparedOutputMismatch);
        }
    }

    Ok(ProjectionReceipt {
        payload,
        input_json_parts_copied: 0,
    })
}

fn utf8_len(bytes: &[u8]) -> u64 {
    bytes.len() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use dolly_canonical_json::canonicalize;

    const INSTANCE_ID: &str = "inst-a";
    const MODULE_ID: &str = "expert-a";
    const BLOCK_ID: &str = "block-1";
    const FROZEN: [u8; 32] = [0x41; 32];
    const DESCRIPTION: &str = "bounded description";
    const TEXT: &str = "analysis";
    const ASSET: &str = "asset-1";
    const ASSET_BYTES: &str = "asset payload";
    const BLOCK_REF: &str = "br-1";
    const CHANNEL: &str = "default";

    fn block(envelope: &'static [u8; 32]) -> TrustedBlock<'static> {
        TrustedBlock {
            producer: (INSTANCE_ID, MODULE_ID),
            block_id: BLOCK_ID,
            envelope_digest: envelope,
            description: Some(DESCRIPTION),
            parts: &[
                BlockSourcePart::Text(TEXT),
                BlockSourcePart::Asset {
                    reference: ASSET,
                    bytes: ASSET_BYTES,
                },
                BlockSourcePart::BlockRef {
                    reference: BLOCK_REF,
                },
                BlockSourcePart::Json {
                    schema_uri: "https://dolly.example/spec/0.1/schemas/filter-signal.schema.json",
                    bytes: "{}",
                },
                BlockSourcePart::Signal {
                    channel: "other",
                    bytes: "{}",
                },
            ],
        }
    }

    fn authorities() -> ReconstructionAuthorities<'static> {
        ReconstructionAuthorities {
            frozen_envelope_digest: &FROZEN,
            selected_binding: SelectionBinding {
                instance_id: INSTANCE_ID,
                module_id: MODULE_ID,
                block_id: BLOCK_ID,
            },
            selected_block: block(&FROZEN),
            copy_description: true,
            enable_block_ref: false,
            asset_references: &[ASSET],
            block_ref_references: &[BLOCK_REF],
            normalized_signal: ProjectedSignal {
                channel: CHANNEL,
                score: 640,
            },
            budgets: PayloadBudgets {
                max_part_bytes: 1_024,
                max_canonical_jcs_bytes: 2_048,
            },
        }
    }

    fn honest_claim() -> (dolly_canonical_json::CanonicalBytes, Sha256Digest) {
        let witness = ProjectedPayload {
            description: Some(DESCRIPTION),
            parts: vec![
                ProjectedPart::Text { bytes: TEXT },
                ProjectedPart::Asset {
                    reference: ASSET,
                    bytes: ASSET_BYTES,
                },
            ],
            signal: ProjectedSignal {
                channel: CHANNEL,
                score: 640,
            },
            actions: Vec::new(),
            metadata: BTreeMap::new(),
            hints: BTreeMap::new(),
        };
        canonicalize(&witness).unwrap()
    }

    fn verify_claim<'a>(
        authorities: &'a ReconstructionAuthorities<'a>,
        bytes: &dolly_canonical_json::CanonicalBytes,
        digest: &Sha256Digest,
        prepared: Option<&dolly_canonical_json::CanonicalBytes>,
    ) -> Result<ProjectionReceipt<'a>, PayloadReconstructionError> {
        reconstruct_complete_activation_payload(
            authorities,
            &ClaimedPayload {
                canonical_bytes: bytes.as_bytes(),
                output_digest: digest,
                prepared_output: prepared.as_ref().map(|p| p.as_bytes()),
            },
        )
    }

    #[test]
    fn accepts_the_exact_v1_projection() {
        let (bytes, digest) = honest_claim();
        let authorities = authorities();
        let receipt = verify_claim(&authorities, &bytes, &digest, None).unwrap();
        assert_eq!(receipt.input_json_parts_copied, 0);
        assert_eq!(receipt.payload.actions, Vec::<&str>::new());
        assert!(receipt.payload.metadata.is_empty());
        assert!(receipt.payload.hints.is_empty());
        assert_eq!(
            receipt.payload.signal,
            ProjectedSignal {
                channel: "default",
                score: 640
            }
        );
    }

    #[test]
    fn rejects_a_different_selection_binding() {
        let mut forged = authorities();
        forged.selected_binding.block_id = "block-2";
        let (bytes, digest) = honest_claim();
        assert_eq!(
            verify_claim(&forged, &bytes, &digest, None),
            Err(PayloadReconstructionError::SelectionBindingMismatch)
        );
    }

    #[test]
    fn rejects_a_different_envelope_digest() {
        const OTHER: [u8; 32] = [0x42; 32];
        let mut forged = authorities();
        forged.selected_block = block(&OTHER);
        let (bytes, digest) = honest_claim();
        assert_eq!(
            verify_claim(&forged, &bytes, &digest, None),
            Err(PayloadReconstructionError::EnvelopeDigestMismatch)
        );
    }

    #[test]
    fn rejects_an_invalid_normalized_score() {
        let mut forged = authorities();
        forged.normalized_signal.score = 1_001;
        let (bytes, digest) = honest_claim();
        assert_eq!(
            verify_claim(&forged, &bytes, &digest, None),
            Err(PayloadReconstructionError::InvalidNormalizedScore)
        );
    }

    #[test]
    fn rejects_when_the_part_budget_is_exceeded() {
        let mut forged = authorities();
        forged.budgets.max_part_bytes = 4;
        let (bytes, digest) = honest_claim();
        assert_eq!(
            verify_claim(&forged, &bytes, &digest, None),
            Err(PayloadReconstructionError::PartBudgetExceeded)
        );
    }

    #[test]
    fn rejects_when_the_canonical_jcs_budget_is_exceeded() {
        let mut forged = authorities();
        forged.budgets.max_canonical_jcs_bytes = 8;
        let (bytes, digest) = honest_claim();
        assert_eq!(
            verify_claim(&forged, &bytes, &digest, None),
            Err(PayloadReconstructionError::CanonicalJcsBudgetExceeded)
        );
    }

    #[test]
    fn rejects_when_the_claimed_bytes_deviate() {
        let (_, honest_digest) = honest_claim();
        // Forged bytes with a self-consistent resealed digest: a different
        // canonical value that is NOT the reconstruction.
        let (forged, forged_digest) = canonicalize(&"an unrelated value").unwrap();
        assert_eq!(
            verify_claim(&authorities(), &forged, &forged_digest, None),
            Err(PayloadReconstructionError::PayloadBytesMismatch)
        );
        let _ = honest_digest;
    }

    #[test]
    fn rejects_a_wrong_output_digest_even_over_honest_bytes() {
        let (bytes, _) = honest_claim();
        let wrong = Sha256Digest::from_bytes([0x11; 32]);
        assert_eq!(
            verify_claim(&authorities(), &bytes, &wrong, None),
            Err(PayloadReconstructionError::OutputDigestMismatch)
        );
    }

    #[test]
    fn rejects_mismatched_archival_prepared_output() {
        let (bytes, digest) = honest_claim();
        let (other, _) = canonicalize(&"other archival bytes").unwrap();
        assert_eq!(
            verify_claim(&authorities(), &bytes, &digest, Some(&other)),
            Err(PayloadReconstructionError::PreparedOutputMismatch)
        );
    }

    #[test]
    fn omits_description_when_copying_is_disabled() {
        let mut forged = authorities();
        forged.copy_description = false;
        let (bytes, digest) = honest_claim(); // honest claim copies the description
        assert_eq!(
            verify_claim(&forged, &bytes, &digest, None),
            Err(PayloadReconstructionError::PayloadBytesMismatch)
        );
    }
}
