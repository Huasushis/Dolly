//! Two-phase decision oracle for the Two-Thirds Mean Filter (spec
//! `dolly-spec/docs/spec/extensions/filter-two-thirds.md` §2, §4, §5): the
//! pure per-source cohort classification and the pure prepared-decision
//! lifecycle exercised by the authoritative `TST-FILTER-002` vector.
//!
//! This module models the DECISION state at the projection scale the
//! Activation commits (held `corrected_score` in normalized `0..=1000` plus
//! an observation count) together with the Manifest's Block records for one
//! configured channel. It reuses the checked selection arithmetic, the
//! explicit `BlockSignal` classification, and the `ProjectedSignal` output
//! type from the crate. EMA deltas of a fresh valid signal are NOT computable
//! from projection-scale committed state: a fresh valid signal from a trusted
//! non-self source is rejected with a closed error and deferred to the
//! accumulator-level replay oracle (`replay_decision_state`, TST-FILTER-006).
//!
//! It is a pure oracle only: no codec, file, storage, ledger, runtime, or
//! durability boundary. The [`DecisionLifecycle`] models the durable
//! exactly-once promotion contract (spec §5) as a pure state machine; the
//! caller retains the frozen [`PreparedDecision`] and returns it verbatim on
//! any redispatch.

use crate::{
    BlockSignal, Candidate, FilterArithmeticError, FilterConfig, MAX_SCORE, ProjectedSignal, SCALE,
    Selection, normalized_score, select_winner,
};

/// Committed decision state for one trusted source (spec §2, §4) at the
/// projection scale the Activation commits: the held normalized corrected
/// score and the observation count. The raw EMA internals `A`/`Z` belong to
/// the accumulator-level replay oracle (`replay_decision_state`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TrackedSource<'a> {
    /// Trusted source identity (`producer.module_id`). A signal value cannot
    /// name, replace, or forge its source (REQ-FILTER-002).
    pub source: &'a str,
    /// Held normalized corrected score in `0..=MAX_SCORE`; `None` when the
    /// source has never supplied a valid signal (ineligible).
    pub corrected_score: Option<u64>,
    /// Number of valid observations ever applied for this source.
    pub observation_count: u64,
}

/// One distinct Block record from the trusted Activation Manifest in
/// canonical Delivery order (spec §2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ManifestBlock<'a> {
    /// Trusted source identity.
    pub source: &'a str,
    /// Block identifier, the durable observation identity component: the
    /// same Block delivered through several Pages, or seen again in a later
    /// Activation, is one observation and never updates twice.
    pub block_id: &'a str,
    /// Signal disposition for the configured channel: `None` is an absent
    /// signal (holds an existing value; never-seen sources stay ineligible);
    /// `Some(Malformed)` is an invalid Block that neither updates state nor
    /// becomes content-eligible and is NOT treated as omission (spec §2).
    pub signal: Option<BlockSignal>,
    /// Input Actions carried by the Block; never copied to the output
    /// BlockDraft (REQ-FILTER-003).
    pub actions: u64,
    /// Input ActionResults carried by the Block; never copied (REQ-FILTER-003).
    pub action_results: u64,
}

/// The single newly created BlockDraft of a decision (REQ-FILTER-001): at
/// most one, produced only when a candidate won and only by the lone
/// promotion of the prepared decision; a redispatch re-emits nothing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockDraft<'a> {
    /// The winning trusted source.
    pub source_module_id: &'a str,
    /// The winning source's content Block in this Manifest.
    pub selected_block_id: &'a str,
    /// `round_half_even(q / R)`, in `0..=1000`.
    pub normalized_score: u64,
}

/// The v1 safe-copy projection surface (spec §4, REQ-FILTER-003): every
/// non-portable carrier is structurally empty, and exactly one normalized
/// signal for the configured channel is appended when a candidate won.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SafeCopyOutput<'a> {
    /// No Action is ever copied.
    pub actions: Vec<()>,
    /// No ActionResult is ever copied.
    pub action_results: Vec<()>,
    /// No input JsonPart is copied in v1.
    pub copied_json_parts: Vec<()>,
    /// No metadata namespace is reproduced; the output Block has empty
    /// metadata in v1.
    pub copied_metadata_namespaces: Vec<()>,
    /// No Filter signal on any channel is copied (other-channel signals are
    /// inert and removed, never forwarded).
    pub foreign_filter_signals: Vec<()>,
    /// Exactly one normalized signal for the configured channel.
    pub filter_signals_for_default: Vec<ProjectedSignal<'a>>,
}

/// The frozen result of one two-phase decision (spec §5): computed once,
/// durably recorded, and returned verbatim on any redispatch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedDecision<'a> {
    /// Per-source decision state after this cohort, in canonical ascending
    /// bytewise source order.
    pub after_state: Vec<TrackedSource<'a>>,
    /// Unique cohort candidates in canonical ascending bytewise order; empty
    /// when no source is eligible (zero candidates returns no BlockDraft).
    pub candidates: Vec<&'a str>,
    /// Valid observations newly applied by this decision (always zero here):
    /// fresh signals are the accumulator-level replay oracle's domain, so the
    /// decision oracle only holds state.
    pub observation_updates: u64,
    /// The safe-copy projection surface.
    pub output: SafeCopyOutput<'a>,
    /// The single newly created BlockDraft, when a candidate won.
    pub draft: Option<BlockDraft<'a>>,
}

/// Errors produced by the two-phase decision oracle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecisionError {
    /// A committed corrected score outside `0..=MAX_SCORE` (corrupt input).
    InvalidTrackedScore,
    /// A fresh valid signal from a trusted non-self source cannot be applied
    /// from projection-scale committed state: EMA deltas belong to the
    /// accumulator-level replay oracle (`replay_decision_state`,
    /// TST-FILTER-006).
    FreshSignalRequiresAccumulatorState,
    /// A checked arithmetic failure surfaced from the reused selection or
    /// normalization arithmetic.
    Arithmetic(FilterArithmeticError),
}

impl From<FilterArithmeticError> for DecisionError {
    fn from(error: FilterArithmeticError) -> Self {
        DecisionError::Arithmetic(error)
    }
}

/// Host-reported disposition of the Activation after an ambiguous
/// interruption (spec §5 step 4): `host.activation.status`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostActivationStatus {
    /// Core committed the Activation: the prepared decision MUST be promoted
    /// exactly once.
    Committed,
    /// Core authoritatively did not apply the Activation: the prepared
    /// decision is discarded.
    NotApplied,
    /// No authoritative disposition yet; promotion is withheld until an
    /// authoritative status is queried.
    Ambiguous,
}

/// Resolution of a prepared decision against the Host's disposition.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Promotion {
    /// Core committed and the state was promoted exactly once; the retained
    /// result and its BlockDraft are returned.
    Applied,
    /// Redispatch of an already-resolved Activation: the retained result is
    /// returned without reapplying observations or re-emitting the BlockDraft.
    Retained,
    /// Core authoritatively did not apply the Activation; the prepared
    /// decision is discarded and stays discarded.
    Discarded,
    /// No authoritative disposition yet; promotion is withheld.
    Withheld,
}

/// Pure two-phase decision lifecycle (spec §5): durably record the prepared
/// decision, then resolve it against `host.activation.status`. A `Committed`
/// Activation is promoted exactly once — `apply_count` never exceeds 1 — and
/// every later redispatch of the same Activation returns `Retained` and never
/// reapplies observations or re-emits the BlockDraft. A `NotApplied`
/// Activation is discarded once and stays discarded even if a later query
/// reports `Committed`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DecisionLifecycle {
    promoted: bool,
    discarded: bool,
}

impl DecisionLifecycle {
    /// A fresh lifecycle with no promotion and nothing discarded.
    pub fn new() -> Self {
        Self::default()
    }

    /// Resolve the prepared decision against the Host's authoritative
    /// Activation disposition.
    pub fn promote(&mut self, status: HostActivationStatus) -> Promotion {
        match status {
            HostActivationStatus::Committed => {
                if self.discarded {
                    Promotion::Discarded
                } else if self.promoted {
                    Promotion::Retained
                } else {
                    self.promoted = true;
                    Promotion::Applied
                }
            }
            HostActivationStatus::NotApplied => {
                self.discarded = true;
                Promotion::Discarded
            }
            HostActivationStatus::Ambiguous => Promotion::Withheld,
        }
    }

    /// The exact number of state promotions applied for this Activation: at
    /// most one, unconditionally.
    pub fn apply_count(&self) -> u64 {
        u64::from(self.promoted)
    }
}

/// Per-source working record during cohort classification.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SourceEval<'a> {
    source: &'a str,
    corrected_score: Option<u64>,
    observation_count: u64,
    /// Whether the source has a content-eligible Block in this Manifest
    /// (a Block whose configured-channel signal is absent or exactly one
    /// valid value; a malformed Block is never eligible).
    has_eligible_block: bool,
    /// The latest content-eligible Block for this source in Delivery order.
    source_block: Option<&'a str>,
}

/// Process one frozen Manifest cohort as one two-phase decision (spec §2,
/// §4, §5). Classification is per trusted source key with the explicit
/// dispositions: an absent signal holds the prior value and keeps a
/// prior-valid source a candidate; a never-seen source is ineligible; a
/// malformed signal invalidates that Block for selection, leaves prior state
/// unchanged, and is NOT treated as omission (a malformed-only source is not
/// a candidate even when prior-valid, because it has no eligible content
/// Block in this Manifest); Blocks produced by the self Module are ignored by
/// default; and a repeated `(source, block_id)` identity is one observation.
/// A fresh valid signal from a trusted non-self source is rejected with
/// [`DecisionError::FreshSignalRequiresAccumulatorState`]: the
/// projection-scale committed state cannot delta EMA, which is the
/// accumulator-level replay oracle's authority.
///
/// The cohort winner reuses [`select_winner`] over candidates whose corrected
/// internal value is the held normalized score at internal scale
/// (`score * R`, saturated by construction because `score <= MAX_SCORE`). The
/// output is the v1 safe copy: no Actions, ActionResults, JsonParts, metadata
/// namespaces, foreign signals, or Block envelope identity, plus exactly one
/// normalized signal for the configured channel when a candidate won. State
/// application and BlockDraft emission are NOT performed here; they belong to
/// the lifecycle's single promotion.
pub fn prepare_decision<'a>(
    config: &FilterConfig,
    instance_id: &'a str,
    channel: &'a str,
    self_module_id: &'a str,
    tracked: &[TrackedSource<'a>],
    manifest: &[ManifestBlock<'a>],
) -> Result<PreparedDecision<'a>, DecisionError> {
    // Validate the committed state before any classification; every entry is
    // carried forward (holds never decay, never-seen entries stay ineligible,
    // and classification adds no new source state).
    let mut state: Vec<SourceEval<'a>> = tracked
        .iter()
        .map(|entry| {
            if let Some(score) = entry.corrected_score {
                if score > MAX_SCORE {
                    return Err(DecisionError::InvalidTrackedScore);
                }
            }
            Ok(SourceEval {
                source: entry.source,
                corrected_score: entry.corrected_score,
                observation_count: entry.observation_count,
                has_eligible_block: false,
                source_block: None,
            })
        })
        .collect::<Result<_, _>>()?;

    // Distinct Blocks in canonical Delivery order: one observation per
    // (source, block_id); a repeated identity never updates twice.
    let mut seen: Vec<(&'a str, &'a str)> = Vec::new();
    for block in manifest {
        if seen
            .iter()
            .any(|&(source, block_id)| source == block.source && block_id == block.block_id)
        {
            continue;
        }
        seen.push((block.source, block.block_id));

        // Default self-source exclusion: a Block produced by this same Filter
        // Module is ignored entirely — its signal never votes and never
        // updates (no Page self-loop).
        if block.source == self_module_id {
            continue;
        }

        let entry = state.iter_mut().find(|entry| entry.source == block.source);
        match block.signal {
            // Absent signal: content-eligible Block; the prior value holds.
            None => {
                if let Some(entry) = entry {
                    entry.has_eligible_block = true;
                    entry.source_block = Some(block.block_id);
                }
            }
            // Malformed: Block invalid for selection; prior state unchanged;
            // never content-eligible, and never treated as omission.
            Some(BlockSignal::Malformed) => {}
            // Fresh valid signal from a trusted non-self source: cannot be
            // delta-applied from projection-scale committed state.
            Some(BlockSignal::WellFormed(score)) => {
                if score > MAX_SCORE {
                    return Err(DecisionError::Arithmetic(
                        FilterArithmeticError::InvalidScore,
                    ));
                }
                return Err(DecisionError::FreshSignalRequiresAccumulatorState);
            }
        }
    }

    // Canonical server-wide order: ascending bytewise source key.
    state.sort_by_key(|entry| entry.source);
    let after_state: Vec<TrackedSource<'a>> = state
        .iter()
        .map(|entry| TrackedSource {
            source: entry.source,
            corrected_score: entry.corrected_score,
            observation_count: entry.observation_count,
        })
        .collect();

    // Candidates: a source with a committed valid value AND an eligible
    // content Block in this Manifest. The internal corrected value is the
    // held normalized score at internal scale (`score * R`); validation above
    // guarantees `score <= MAX_SCORE`, so it is saturated by construction.
    let mut cohort: Vec<(&'a str, u64, &'a str)> = Vec::new();
    for entry in &state {
        if let Some(score) = entry.corrected_score {
            if entry.has_eligible_block {
                let q = score
                    .checked_mul(SCALE)
                    .ok_or(DecisionError::Arithmetic(FilterArithmeticError::Overflow))?;
                cohort.push((
                    entry.source,
                    q,
                    entry.source_block.expect("eligible block is recorded"),
                ));
            }
        }
    }
    let candidates: Vec<&'a str> = cohort.iter().map(|&(source, _, _)| source).collect();

    // The cohort winner reuses the checked division-free two-thirds selection
    // (spec §3); at most the 16-module cohort bound applies (one per source).
    let selection: Option<Selection> = if cohort.is_empty() {
        None
    } else {
        let selection_candidates: Vec<Candidate> = cohort
            .iter()
            .map(|&(source, corrected_score_q, _)| Candidate {
                module_id: source.to_string(),
                corrected_score_q,
            })
            .collect();
        select_winner(instance_id, channel, &selection_candidates)?
    };

    // The v1 safe-copy projection: only the description bound is copied in
    // addition to the one normalized signal; everything non-portable stays
    // empty and `envelope_identity` is never present (REQ-FILTER-003).
    let mut filter_signals_for_default = Vec::new();
    let mut draft = None;
    if let Some(selection) = selection {
        if let Some(winner) = selection.winner {
            let (source, corrected_score_q, source_block) = cohort[winner];
            let score = normalized_score(config, corrected_score_q)?;
            draft = Some(BlockDraft {
                source_module_id: source,
                selected_block_id: source_block,
                normalized_score: score,
            });
            filter_signals_for_default.push(ProjectedSignal { channel, score });
        }
    }

    Ok(PreparedDecision {
        after_state,
        candidates,
        observation_updates: 0,
        output: SafeCopyOutput {
            actions: Vec::new(),
            action_results: Vec::new(),
            copied_json_parts: Vec::new(),
            copied_metadata_namespaces: Vec::new(),
            foreign_filter_signals: Vec::new(),
            filter_signals_for_default,
        },
        draft,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> FilterConfig {
        FilterConfig::new(SCALE, true, SCALE).expect("normative config")
    }

    #[test]
    fn missing_signal_holds_prior_valid_source_as_candidate() {
        let cfg = config();
        let tracked = vec![TrackedSource {
            source: "expert-a",
            corrected_score: Some(640),
            observation_count: 4,
        }];
        let manifest = vec![ManifestBlock {
            source: "expert-a",
            block_id: "b1",
            signal: None,
            actions: 1,
            action_results: 1,
        }];
        let decision = prepare_decision(
            &cfg,
            "instance",
            "default",
            "filter-main",
            &tracked,
            &manifest,
        )
        .expect("vector stays in bounds");
        assert_eq!(decision.candidates, vec!["expert-a"]);
        assert_eq!(decision.observation_updates, 0);
        assert_eq!(decision.after_state[0].corrected_score, Some(640));
        assert_eq!(decision.after_state[0].observation_count, 4);
        let draft = decision.draft.expect("single candidate drafts");
        assert_eq!(draft.source_module_id, "expert-a");
        assert_eq!(draft.selected_block_id, "b1");
        assert_eq!(draft.normalized_score, 640);
        assert_eq!(decision.output.filter_signals_for_default.len(), 1);
        assert_eq!(decision.output.filter_signals_for_default[0].score, 640);
        assert!(decision.output.actions.is_empty());
        assert!(decision.output.action_results.is_empty());
        assert!(decision.output.copied_json_parts.is_empty());
        assert!(decision.output.copied_metadata_namespaces.is_empty());
        assert!(decision.output.foreign_filter_signals.is_empty());
    }

    #[test]
    fn never_seen_source_is_ineligible() {
        let cfg = config();
        let tracked = vec![TrackedSource {
            source: "expert-b",
            corrected_score: None,
            observation_count: 0,
        }];
        let manifest = vec![ManifestBlock {
            source: "expert-b",
            block_id: "b2",
            signal: None,
            actions: 0,
            action_results: 0,
        }];
        let decision = prepare_decision(
            &cfg,
            "instance",
            "default",
            "filter-main",
            &tracked,
            &manifest,
        )
        .expect("vector stays in bounds");
        assert!(decision.candidates.is_empty());
        assert!(decision.draft.is_none());
        assert!(decision.output.filter_signals_for_default.is_empty());
        assert_eq!(decision.after_state[0].corrected_score, None);
        assert_eq!(decision.after_state[0].observation_count, 0);
    }

    #[test]
    fn malformed_block_is_not_omission() {
        let cfg = config();
        // A prior-valid source whose only Manifest Block is malformed holds
        // its state but has no eligible content Block in this cohort: it is
        // NOT a candidate, whereas an absent signal would have kept it one.
        let tracked = vec![TrackedSource {
            source: "expert-a",
            corrected_score: Some(640),
            observation_count: 4,
        }];
        let manifest = vec![ManifestBlock {
            source: "expert-a",
            block_id: "b1",
            signal: Some(BlockSignal::Malformed),
            actions: 0,
            action_results: 0,
        }];
        let decision = prepare_decision(
            &cfg,
            "instance",
            "default",
            "filter-main",
            &tracked,
            &manifest,
        )
        .expect("vector stays in bounds");
        assert_eq!(
            decision.after_state[0].corrected_score,
            Some(640),
            "prior state holds"
        );
        assert_eq!(decision.after_state[0].observation_count, 4);
        assert!(
            decision.candidates.is_empty(),
            "malformed is not omission: no eligible content Block, no candidate"
        );
        assert!(decision.draft.is_none());
    }

    #[test]
    fn self_source_is_ignored_by_default() {
        let cfg = config();
        let manifest = vec![ManifestBlock {
            source: "filter-main",
            block_id: "b3",
            signal: Some(BlockSignal::WellFormed(500)),
            actions: 0,
            action_results: 0,
        }];
        let decision = prepare_decision(&cfg, "instance", "default", "filter-main", &[], &manifest)
            .expect("vector stays in bounds");
        assert!(decision.candidates.is_empty());
        assert_eq!(decision.observation_updates, 0);
        assert!(decision.after_state.is_empty());
        assert!(decision.draft.is_none());
    }

    #[test]
    fn fresh_valid_signal_from_trusted_source_is_deferred_to_replay() {
        let cfg = config();
        let tracked = vec![TrackedSource {
            source: "expert-a",
            corrected_score: Some(640),
            observation_count: 4,
        }];
        let manifest = vec![ManifestBlock {
            source: "expert-a",
            block_id: "b1",
            signal: Some(BlockSignal::WellFormed(500)),
            actions: 0,
            action_results: 0,
        }];
        assert_eq!(
            prepare_decision(
                &cfg,
                "instance",
                "default",
                "filter-main",
                &tracked,
                &manifest
            ),
            Err(DecisionError::FreshSignalRequiresAccumulatorState)
        );
    }

    #[test]
    fn tracked_score_out_of_range_is_rejected() {
        let cfg = config();
        let tracked = vec![TrackedSource {
            source: "expert-a",
            corrected_score: Some(MAX_SCORE + 1),
            observation_count: 4,
        }];
        let manifest = vec![ManifestBlock {
            source: "expert-a",
            block_id: "b1",
            signal: None,
            actions: 0,
            action_results: 0,
        }];
        assert_eq!(
            prepare_decision(
                &cfg,
                "instance",
                "default",
                "filter-main",
                &tracked,
                &manifest
            ),
            Err(DecisionError::InvalidTrackedScore)
        );
    }

    #[test]
    fn repeated_block_identity_is_one_observation() {
        let cfg = config();
        let tracked = vec![TrackedSource {
            source: "expert-a",
            corrected_score: Some(640),
            observation_count: 4,
        }];
        let block = ManifestBlock {
            source: "expert-a",
            block_id: "b1",
            signal: None,
            actions: 1,
            action_results: 1,
        };
        let once = prepare_decision(
            &cfg,
            "instance",
            "default",
            "filter-main",
            &tracked,
            &[block],
        )
        .expect("vector stays in bounds");
        let twice = prepare_decision(
            &cfg,
            "instance",
            "default",
            "filter-main",
            &tracked,
            &[block, block],
        )
        .expect("vector stays in bounds");
        assert_eq!(once, twice);
    }

    #[test]
    fn lifecycle_promotes_exactly_once_and_retains_redispatch() {
        let mut lifecycle = DecisionLifecycle::new();
        assert_eq!(lifecycle.apply_count(), 0);
        assert_eq!(
            lifecycle.promote(HostActivationStatus::Committed),
            Promotion::Applied
        );
        assert_eq!(lifecycle.apply_count(), 1);
        // Redispatch of the same Activation never reapplies or re-emits.
        assert_eq!(
            lifecycle.promote(HostActivationStatus::Committed),
            Promotion::Retained
        );
        assert_eq!(lifecycle.apply_count(), 1);
        assert_eq!(
            lifecycle.promote(HostActivationStatus::Committed),
            Promotion::Retained
        );
        assert_eq!(lifecycle.apply_count(), 1);
    }

    #[test]
    fn lifecycle_discards_when_not_applied_and_stays_discarded() {
        let mut lifecycle = DecisionLifecycle::new();
        assert_eq!(
            lifecycle.promote(HostActivationStatus::Ambiguous),
            Promotion::Withheld
        );
        assert_eq!(lifecycle.apply_count(), 0);
        assert_eq!(
            lifecycle.promote(HostActivationStatus::NotApplied),
            Promotion::Discarded
        );
        assert_eq!(lifecycle.apply_count(), 0);
        // A stray later "committed" query cannot resurrect a discarded
        // decision.
        assert_eq!(
            lifecycle.promote(HostActivationStatus::Committed),
            Promotion::Discarded
        );
        assert_eq!(lifecycle.apply_count(), 0);
    }
}
