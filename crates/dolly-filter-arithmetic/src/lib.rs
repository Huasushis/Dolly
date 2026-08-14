//! Bounded WP-021A arithmetic oracle: the Two-Thirds Mean Filter deterministic
//! smoothing and selection arithmetic from
//! `dolly-spec/docs/spec/extensions/filter-two-thirds.md` (§3).
//!
//! This crate implements ONLY the arithmetic exercised by the authoritative
//! `TST-FILTER-001`, `TST-FILTER-003`, `TST-FILTER-004`, `TST-FILTER-005`,
//! `TST-FILTER-006`, and `TST-FILTER-007` vectors: checked integer
//! half-even smoothing (`A`, `Z`), bias correction, the mandatory saturation
//! clamp, division-free two-thirds cohort selection with a JCS UTF-8
//! tie-break, ordered per-source block application with explicit
//! malformed-signal rejection and latest-eligible content selection for
//! projectable Blocks, the ordered decision-state replay that derives
//! `after_state` from `before_state` and the applied observations and
//! requires it to equal the claimed `after_state`, the pure state-header
//! prepare/restart transitions that freeze the algorithm revision, internal
//! scale, and bias correction of a populated channel (spec §6), and the pure
//! complete-ActivationPayload reconstruction/rejection oracle that rebuilds
//! the exact v1 projection of a trusted selected Block under the frozen
//! manifest envelope digest and the exact Asset-view and BlockRef-relation
//! grants and accepts only byte-identical canonical claims (spec §4-§5).
//! The state-header surface is transition-only and the activation surface is
//! reconstruction/rejection-only: no codec, file, storage, or reopen
//! boundary, no epoch authority, and no durability, so the archival
//! `preparedOutput` and output digest are evidence only and cannot authorize
//! a deviation. This crate contains no Extension scaffolding, durable state,
//! projection, activation ledger, provider, or runtime dependency; floating
//! point is non-conforming and is never used.

use dolly_canonical_json::canonicalize;

mod state_header;

pub use state_header::{
    EpochMode, FilterStateHeader, FilterStateHeaderError, prepare_config, restart,
};

mod activation_payload;

pub use activation_payload::{
    BlockSourcePart, ClaimedPayload, PayloadBudgets, PayloadReconstructionError, ProjectedPart,
    ProjectedPayload, ProjectedSignal, ProjectionReceipt, ReconstructionAuthorities,
    SelectionBinding, TrustedBlock, reconstruct_complete_activation_payload,
};

/// The fixed internal scale `W = 1,000,000` (spec §3).
pub const SCALE: u64 = 1_000_000;

/// Maximum raw score admitted by the Filter signal schema (`0..=1000`).
pub const MAX_SCORE: u64 = 1_000;

/// The normative saturation ceiling `1000 * R` with the fixed scale
/// `R = SCALE`: compile-time exact, never saturated.
pub const MAX_Q: u64 = MAX_SCORE * SCALE;

/// Errors produced by the checked arithmetic; there is no silent overflow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilterArithmeticError {
    /// `new_sample_weight_ppm` outside `1..=SCALE`.
    InvalidWeight,
    /// `internal_scale` must be exactly `SCALE`: the spec fixes `R = 1_000_000`.
    InvalidScale,
    /// A raw score outside `0..=1000`.
    InvalidScore,
    /// Bias-corrected value requested before any observation (`Z == 0`).
    ZeroWeight,
    /// Division by a zero denominator that the spec excludes by construction.
    ZeroDivision,
    /// Selection cohort larger than the normative maximum of 16 modules.
    CohortTooLarge,
    /// A corrected value beyond `MAX_Q` was passed where the mandatory clamp
    /// is required first (selection candidate or normalized output).
    UnclampedValue,
    /// A checked intermediate exceeded the type range for the enforced bounds.
    Overflow,
}

/// Frozen configuration for the smoothing arithmetic (spec §3).
///
/// Every field is private and only reachable through [`FilterConfig::new`],
/// which enforces the invariant-bearing bounds, so no public operation can
/// receive an invalid configuration except through unsafe code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FilterConfig {
    /// `new_sample_weight_ppm`, in `1..=SCALE`.
    new_sample_weight_ppm: u64,
    /// Whether `q_raw = round_half_even(A' * W / Z')` is applied.
    bias_correction: bool,
    /// Internal scale `R`, always equal to the normative `SCALE`; the
    /// constructor rejects every other value, so every bound derived from it
    /// is exact and never silently saturated.
    internal_scale: u64,
}

impl FilterConfig {
    /// Validate the configuration against the spec bounds. `internal_scale`
    /// must be exactly `SCALE`: the normative spec fixes `R = 1_000_000`, and
    /// rejecting every other value is what keeps the checked arithmetic exact.
    pub fn new(
        new_sample_weight_ppm: u64,
        bias_correction: bool,
        internal_scale: u64,
    ) -> Result<Self, FilterArithmeticError> {
        if new_sample_weight_ppm == 0 || new_sample_weight_ppm > SCALE {
            return Err(FilterArithmeticError::InvalidWeight);
        }
        if internal_scale != SCALE {
            return Err(FilterArithmeticError::InvalidScale);
        }
        Ok(Self {
            new_sample_weight_ppm,
            bias_correction,
            internal_scale: SCALE,
        })
    }

    /// Saturation clamp `q = clamp(q_raw, 0, 1000 * R)` applied before the
    /// value enters candidate state, selection, a decision record, or the
    /// normalized signal (spec §3). `R` is the fixed normative scale, so the
    /// ceiling is the exact compile-time constant `MAX_Q`; nothing saturates.
    pub fn clamp_q(&self, q_raw: u64) -> u64 {
        q_raw.min(MAX_Q)
    }
}

/// EMA accumulator state for one trusted source (spec §3).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Accumulator {
    /// `A` — weighted accumulator in raw-score units.
    pub accumulator: u64,
    /// `Z` — total observation weight in ppm units.
    pub weight: u64,
    /// Number of distinct observations applied.
    pub observation_count: u64,
}

/// Apply exactly one valid observation at `score` (`0..=1000`), updating
/// `A` and `Z` with checked integer half-even arithmetic (spec §3):
/// `A' = round_half_even(((W - w) * A + w * xq) / W)` and the analogue for
/// `Z'`, where `xq = score * R`.
pub fn update(
    config: &FilterConfig,
    state: &mut Accumulator,
    score: u64,
) -> Result<(), FilterArithmeticError> {
    if score > MAX_SCORE {
        return Err(FilterArithmeticError::InvalidScore);
    }
    let w = config.new_sample_weight_ppm;
    let w_complement = SCALE - w;
    let xq = score
        .checked_mul(config.internal_scale)
        .ok_or(FilterArithmeticError::Overflow)?;

    let a_numerator = w_complement
        .checked_mul(state.accumulator)
        .and_then(|term| term.checked_add(w.checked_mul(xq)?))
        .ok_or(FilterArithmeticError::Overflow)?;
    let z_numerator = w_complement
        .checked_mul(state.weight)
        .and_then(|term| term.checked_add(w.checked_mul(SCALE)?))
        .ok_or(FilterArithmeticError::Overflow)?;

    state.accumulator = round_half_even_div(a_numerator, SCALE)?;
    state.weight = round_half_even_div(z_numerator, SCALE)?;
    state.observation_count = state
        .observation_count
        .checked_add(1)
        .ok_or(FilterArithmeticError::Overflow)?;
    Ok(())
}

/// Bias-corrected internal value `q_raw = round_half_even(A' * W / Z')`
/// (or `A'` when `bias_correction` is false), BEFORE the mandatory clamp
/// (spec §3). Errors with `ZeroWeight` before any observation.
pub fn corrected_score_q(
    config: &FilterConfig,
    state: &Accumulator,
) -> Result<u64, FilterArithmeticError> {
    if !config.bias_correction {
        return Ok(state.accumulator);
    }
    if state.weight == 0 {
        return Err(FilterArithmeticError::ZeroWeight);
    }
    let numerator = state
        .accumulator
        .checked_mul(SCALE)
        .ok_or(FilterArithmeticError::Overflow)?;
    round_half_even_div(numerator, state.weight)
}

/// Normalized output score `round_half_even(q / R)` in `0..=1000`
/// (spec §4 projection). The mandatory clamp is enforced: input beyond the
/// exact ceiling `MAX_Q` (`1000 * R`) is rejected, never silently coerced.
pub fn normalized_score(config: &FilterConfig, q: u64) -> Result<u64, FilterArithmeticError> {
    if q > MAX_Q {
        return Err(FilterArithmeticError::UnclampedValue);
    }
    round_half_even_div(q, config.internal_scale)
}

/// One selection candidate: a module plus its corrected internal value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    /// Configured non-reusable Module identity (tie-break key component).
    pub module_id: String,
    /// Corrected internal value `q` (already saturated).
    pub corrected_score_q: u64,
}

/// Division-free aggregate for a selection over one cohort.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Selection {
    /// Index into the input candidates of the winner, if any.
    pub winner: Option<usize>,
    /// Exact two-thirds of the cohort mean, `2S / (3n)` (floor when the
    /// division is not exact); informational only, never used for ranking.
    pub target_score_q: u64,
    /// `distance_i = |3n*q_i - 2S|` for every candidate, in input order.
    pub distances: Vec<u64>,
}

/// Select the cohort winner by the division-free distance
/// `|3n*q_i - 2S|`; equal distances are resolved by ascending bytewise
/// comparison of `UTF8(JCS([instance_id, module_id, signal_channel]))`
/// (spec §3). Zero candidates returns `Ok(None)` with no error.
///
/// Bounds are enforced: the cohort is at most the normative maximum of 16
/// modules, and every candidate carries a corrected value that has already
/// passed the mandatory clamp (`q <= MAX_Q`). All aggregates use checked or
/// wide arithmetic, and JCS tie-break keys are computed only for candidates
/// that actually tie at the minimum distance.
pub fn select_winner(
    instance_id: &str,
    channel: &str,
    candidates: &[Candidate],
) -> Result<Option<Selection>, FilterArithmeticError> {
    let n = candidates.len();
    if n == 0 {
        return Ok(None);
    }
    if n > 16 {
        return Err(FilterArithmeticError::CohortTooLarge);
    }
    let n_wide = n as i128;
    let mut sum: u64 = 0;
    for candidate in candidates {
        if candidate.corrected_score_q > MAX_Q {
            return Err(FilterArithmeticError::UnclampedValue);
        }
        sum = sum
            .checked_add(candidate.corrected_score_q)
            .ok_or(FilterArithmeticError::Overflow)?;
    }
    let twice_sum = 2_i128 * sum as i128;

    let mut distances = Vec::with_capacity(n);
    for candidate in candidates {
        let q_wide = candidate.corrected_score_q as i128;
        let distance = (3 * n_wide * q_wide - twice_sum).abs();
        distances.push(u64::try_from(distance).map_err(|_| FilterArithmeticError::Overflow)?);
    }

    // Minimum-distance winner in a single pass. Canonical JCS key bytes are
    // computed only when a candidate actually ties the running minimum
    // distance; the lexicographically smallest key wins, and an identical
    // key resolves to the earliest index (matching the previous stable
    // tie-break). No tie lists or sorts are built.
    let mut best = 0usize;
    let mut min_distance = distances[0];
    let mut best_key: Option<Vec<u8>> = None;
    for index in 1..n {
        let distance = distances[index];
        match distance.cmp(&min_distance) {
            std::cmp::Ordering::Less => {
                min_distance = distance;
                best = index;
                best_key = None;
            }
            std::cmp::Ordering::Equal => {
                let key = tie_break_key(instance_id, &candidates[index].module_id, channel)?;
                match best_key.as_ref() {
                    None => {
                        // First real tie: seed with the running best's own key.
                        let current_best_key =
                            tie_break_key(instance_id, &candidates[best].module_id, channel)?;
                        if key < current_best_key {
                            best_key = Some(key);
                            best = index;
                        } else {
                            best_key = Some(current_best_key);
                        }
                    }
                    Some(current_best_key) if key < *current_best_key => {
                        best_key = Some(key);
                        best = index;
                    }
                    Some(_) => {}
                }
            }
            std::cmp::Ordering::Greater => {}
        }
    }

    let scale_3n = (n as u64)
        .checked_mul(3)
        .ok_or(FilterArithmeticError::Overflow)?;
    let target_score_q = sum
        .checked_mul(2)
        .and_then(|numerator| numerator.checked_div(scale_3n))
        .ok_or(FilterArithmeticError::Overflow)?;
    Ok(Some(Selection {
        winner: Some(best),
        target_score_q,
        distances,
    }))
}

/// Canonical `UTF8(JCS([instance_id, module_id, signal_channel]))` bytes used
/// for the deterministic tie-break (spec §3). The key is serialized from
/// borrowed strings (no intermediate `String` allocations); only the canonical
/// output bytes themselves are produced. Exposed so the vector runner and
/// future ledger validators share one implementation.
pub fn tie_break_key(
    instance_id: &str,
    module_id: &str,
    channel: &str,
) -> Result<Vec<u8>, FilterArithmeticError> {
    let key = [instance_id, module_id, channel];
    canonicalize(&key)
        .map(|(bytes, _)| bytes.as_ref().to_vec())
        .map_err(|_| FilterArithmeticError::Overflow)
}

/// One block observation for a trusted source in canonical delivery order:
/// its opaque Block identifier, its explicit signal classification, and
/// whether its content is eligible for projection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BlockInput<'a> {
    /// Opaque Block identifier produced by the trusted source; used only to
    /// name the selected content, never to address storage.
    pub block_id: &'a str,
    /// Explicit signal disposition: a well-formed score is an observation;
    /// `Malformed` is an explicit input variant that neither updates state
    /// nor becomes content-eligible (not an exception fallback).
    pub signal: BlockSignal,
    /// Whether this Block's content may be projected downstream. An oversize
    /// (non-projectable) but well-formed Block still updates the accumulator.
    pub projectable: bool,
}

/// Explicit signal classification for a block.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockSignal {
    /// Well-formed score in `0..=1000`, validated by [`update`].
    WellFormed(u64),
    /// Malformed signal: rejected, neither a state update nor eligible
    /// content. This is an explicit input variant, not an exception path.
    Malformed,
}

/// Outcome of applying an ordered block sequence for one source
/// (spec `filter-two-thirds.md` §5 "A projection_eligible observation selects
/// the latest eligible Block for that source but does not bypass the ordered
/// EMA").
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockSequenceOutcome<'a> {
    /// Latest Block that is both well-formed and projectable; `None` when no
    /// block qualifies. Content falls back to it when a later well-formed
    /// Block is oversize/non-projectable.
    pub selected_block_id: Option<&'a str>,
    /// Number of well-formed signals applied to the accumulator; malformed
    /// signals contribute none.
    pub observation_updates: u64,
    /// Clamped corrected internal value after the final well-formed update.
    pub state_q: u64,
    /// Normalized output score in `0..=1000`, derived from ALL well-formed
    /// updates in delivery order, not from the selected block's score alone.
    pub normalized_score: u64,
}

/// Apply blocks in input (canonical delivery) order for one source: every
/// well-formed score updates the ordered EMA accumulator; the latest Block
/// that is well-formed AND projectable supplies the selected content (an
/// oversize later Block updates state but not content); malformed signals are
/// ignored entirely; the final normalized score comes from the complete
/// well-formed sequence. Borrows Block identifiers, so no String is allocated.
pub fn apply_block_sequence<'a>(
    config: &FilterConfig,
    blocks: &[BlockInput<'a>],
) -> Result<BlockSequenceOutcome<'a>, FilterArithmeticError> {
    let mut accumulator = Accumulator::default();
    let mut observation_updates = 0u64;
    let mut selected_block_id: Option<&'a str> = None;
    for block in blocks {
        match block.signal {
            BlockSignal::WellFormed(score) => {
                update(config, &mut accumulator, score)?;
                observation_updates += 1;
                if block.projectable {
                    selected_block_id = Some(block.block_id);
                }
            }
            BlockSignal::Malformed => {}
        }
    }
    let state_q = config.clamp_q(corrected_score_q(config, &accumulator)?);
    let normalized_score = normalized_score(config, state_q)?;
    Ok(BlockSequenceOutcome {
        selected_block_id,
        observation_updates,
        state_q,
        normalized_score,
    })
}

/// One trusted observation in the canonical ordered tape (spec §5).
///
/// The tape is the authoritative, ordered observation sequence derived from
/// the trusted Manifest in ascending `manifest_ordinal`. The replay oracle
/// applies it in that canonical order; it carries no disposition or
/// projection authority of its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReplayObservation<'a> {
    /// Ascending application order within the Manifest.
    pub manifest_ordinal: u64,
    /// Trusted source key (`instance_id`/`module_id`/`channel` together).
    pub source: &'a str,
    /// Valid score in `0..=1000`; validated by [`update`] on replay.
    pub score: u64,
}

/// Outcome of replaying a decision's ordered observations from `before_state`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayOutcome<'a> {
    /// Per-source accumulator state after every applied observation, in
    /// ascending bytewise source order. Sources present in `before_state`
    /// with no new observation are held unchanged.
    pub derived_after_state: Vec<(&'a str, Accumulator)>,
    /// Whether the claimed `after_state` exactly equals the replay-derived
    /// state for every source pair; `false` means the prepared decision must
    /// be rejected (`FILTER_ORDERED_STATE_REPLAY_MISMATCH`).
    pub claimed_matches: bool,
}

/// Replay the ordered decision tape from `before_state` under the frozen
/// configuration and require the result to equal the claimed `after_state`
/// (spec §5 "starts from `before_state`, applies only `applied` observations
/// in ascending `manifest_ordinal` with the frozen `new_sample_weight_ppm`,
/// and requires the result to equal `after_state`").
///
/// Every well-formed score updates the per-source accumulator exactly once;
/// a source absent from `before_state` starts from `A0 = 0, Z0 = 0`. Both
/// states are compared as (source, accumulator) sets sorted by bytewise
/// source key; equal sources with any differing accumulator, or a source
/// present in exactly one side, makes `claimed_matches` false. No digest,
/// manifest, or ledger authority is consulted: this is the fixed arithmetic
/// alone, and the caller decides rejection from `claimed_matches`.
pub fn replay_decision_state<'a>(
    config: &FilterConfig,
    before_state: &[(&'a str, Accumulator)],
    observations: &[ReplayObservation<'a>],
    claimed_after_state: &[(&'a str, Accumulator)],
) -> Result<ReplayOutcome<'a>, FilterArithmeticError> {
    // Seed the derived state with the committed before_state (bytes are
    // borrowed; only the accumulator copies are written in place).
    let mut derived_after_state: Vec<(&'a str, Accumulator)> = before_state.to_vec();

    for observation in observations {
        match derived_after_state
            .iter_mut()
            .find(|(source, _)| *source == observation.source)
        {
            Some((_, state)) => update(config, state, observation.score)?,
            None => {
                let mut state = Accumulator::default();
                update(config, &mut state, observation.score)?;
                derived_after_state.push((observation.source, state));
            }
        }
    }

    // Canonical server-wide order: ascending bytewise source key.
    derived_after_state.sort_by_key(|&(source, _)| source);

    let mut claimed: Vec<(&'a str, Accumulator)> = claimed_after_state.to_vec();
    claimed.sort_by_key(|&(source, _)| source);
    let claimed_matches = derived_after_state.len() == claimed.len()
        && derived_after_state
            .iter()
            .zip(claimed.iter())
            .all(|(left, right)| left == right);

    Ok(ReplayOutcome {
        derived_after_state,
        claimed_matches,
    })
}

/// Round `numerator / denominator` to the nearest integer, ties to even,
/// for non-negative operands (spec §3 requires half-even rounding).
fn round_half_even_div(numerator: u64, denominator: u64) -> Result<u64, FilterArithmeticError> {
    if denominator == 0 {
        return Err(FilterArithmeticError::ZeroDivision);
    }
    let quotient = numerator / denominator;
    let remainder = numerator % denominator;
    match (2_u128 * remainder as u128).cmp(&(denominator as u128)) {
        std::cmp::Ordering::Less => Ok(quotient),
        std::cmp::Ordering::Greater => Ok(quotient + 1),
        std::cmp::Ordering::Equal => {
            if quotient % 2 == 0 {
                Ok(quotient)
            } else {
                Ok(quotient + 1)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{FilterArithmeticError, round_half_even_div};

    #[test]
    fn round_half_even_ties_to_even() {
        // The half-even contract: exact ties round to the even quotient.
        assert_eq!(round_half_even_div(5, 2).unwrap(), 2); // 2.5 -> 2
        assert_eq!(round_half_even_div(7, 2).unwrap(), 4); // 3.5 -> 4
        assert_eq!(round_half_even_div(15, 2).unwrap(), 8); // 7.5 -> 8
        assert_eq!(round_half_even_div(1, 2).unwrap(), 0); // 0.5 -> 0
        assert_eq!(round_half_even_div(10, 2).unwrap(), 5); // exact
        assert_eq!(round_half_even_div(6, 2).unwrap(), 3); // exact
        assert_eq!(round_half_even_div(0, 2).unwrap(), 0);
    }

    #[test]
    fn round_half_even_rejects_zero_denominator() {
        assert_eq!(
            round_half_even_div(1, 0),
            Err(FilterArithmeticError::ZeroDivision)
        );
    }
}
