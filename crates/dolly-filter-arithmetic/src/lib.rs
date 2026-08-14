//! Bounded WP-021A arithmetic oracle: the Two-Thirds Mean Filter deterministic
//! smoothing and selection arithmetic from
//! `dolly-spec/docs/spec/extensions/filter-two-thirds.md` (§3).
//!
//! This crate implements ONLY the arithmetic exercised by the authoritative
//! `TST-FILTER-001` and `TST-FILTER-003` vectors: checked integer half-even
//! smoothing (`A`, `Z`), bias correction, the mandatory saturation clamp, and
//! the division-free two-thirds cohort selection with a JCS UTF-8 tie-break.
//! It contains no Extension scaffolding, durable state, projection, activation
//! ledger, provider, or runtime dependency; floating point is non-conforming
//! and is never used.

use dolly_canonical_json::canonicalize;

/// The fixed internal scale `W = R = 1,000,000` (spec §3).
pub const SCALE: u64 = 1_000_000;

/// Maximum raw score admitted by the Filter signal schema (`0..=1000`).
pub const MAX_SCORE: u64 = 1_000;

/// The mandatory saturation ceiling for a corrected internal value: `1000 * R`.
pub const fn corrected_ceiling(scale: u64) -> u64 {
    MAX_SCORE.saturating_mul(scale)
}

/// Errors produced by the checked arithmetic; there is no silent overflow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilterArithmeticError {
    /// `new_sample_weight_ppm` outside `1..=SCALE`.
    InvalidWeight,
    /// `internal_scale` is zero.
    InvalidScale,
    /// A raw score outside `0..=1000`.
    InvalidScore,
    /// Bias-corrected value requested before any observation (`Z == 0`).
    ZeroWeight,
    /// A checked intermediate exceeded `u64` range for the configured bounds.
    Overflow,
}

/// Frozen configuration for the smoothing arithmetic (spec §3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FilterConfig {
    /// `new_sample_weight_ppm`, in `1..=SCALE`.
    pub new_sample_weight_ppm: u64,
    /// Whether `q_raw = round_half_even(A' * W / Z')` is applied.
    pub bias_correction: bool,
    /// Internal scale `R` (default `SCALE`).
    pub internal_scale: u64,
}

impl FilterConfig {
    /// Validate the configuration against the spec bounds.
    pub fn new(
        new_sample_weight_ppm: u64,
        bias_correction: bool,
        internal_scale: u64,
    ) -> Result<Self, FilterArithmeticError> {
        if new_sample_weight_ppm == 0 || new_sample_weight_ppm > SCALE {
            return Err(FilterArithmeticError::InvalidWeight);
        }
        if internal_scale == 0 {
            return Err(FilterArithmeticError::InvalidScale);
        }
        Ok(Self {
            new_sample_weight_ppm,
            bias_correction,
            internal_scale,
        })
    }

    /// Saturation clamp `q = clamp(q_raw, 0, 1000 * R)` applied before the
    /// value enters candidate state, selection, a decision record, or the
    /// normalized signal (spec §3).
    pub fn clamp_q(&self, q_raw: u64) -> u64 {
        q_raw.min(corrected_ceiling(self.internal_scale))
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
/// `A` and `Z` with checked integer half-even arithmetic (spec §3).
pub fn update(
    config: &FilterConfig,
    state: &mut Accumulator,
    score: u64,
) -> Result<(), FilterArithmeticError> {
    // INTENTIONAL STUB — wrong arithmetic so the authoritative vector
    // expectations fail red. Replaced by the real oracle in the next commit.
    let _ = (config, score);
    state.observation_count = state.observation_count.wrapping_add(1);
    Ok(())
}

/// Bias-corrected internal value `q_raw = round_half_even(A' * W / Z')`
/// (or `A'` when `bias_correction` is false), BEFORE the mandatory clamp
/// (spec §3). Errors with `ZeroWeight` before any observation.
pub fn corrected_score_q(
    config: &FilterConfig,
    state: &Accumulator,
) -> Result<u64, FilterArithmeticError> {
    // INTENTIONAL STUB — wrong arithmetic so the authoritative vector
    // expectations fail red. Replaced by the real oracle in the next commit.
    let _ = config;
    Ok(state.accumulator)
}

/// Normalized output score `round_half_even(q / R)` in `0..=1000`
/// (spec §4 projection).
pub fn normalized_score(
    config: &FilterConfig,
    q: u64,
) -> Result<u64, FilterArithmeticError> {
    // INTENTIONAL STUB — wrong arithmetic so the authoritative vector
    // expectations fail red. Replaced by the real oracle in the next commit.
    let _ = config;
    Ok(q / config.internal_scale)
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
pub fn select_winner(
    instance_id: &str,
    channel: &str,
    candidates: &[Candidate],
) -> Result<Option<Selection>, FilterArithmeticError> {
    // INTENTIONAL STUB — wrong arithmetic so the authoritative vector
    // expectations fail red. Replaced by the real oracle in the next commit.
    if candidates.is_empty() {
        return Ok(None);
    }
    let _ = (instance_id, channel);
    Ok(Some(Selection {
        winner: Some(0),
        target_score_q: 0,
        distances: vec![0; candidates.len()],
    }))
}

/// Canonical `UTF8(JCS([instance_id, module_id, signal_channel]))` bytes used
/// for the deterministic tie-break (spec §3). Exposed so the vector runner and
/// future ledger validators share one implementation.
pub fn tie_break_key(
    instance_id: &str,
    module_id: &str,
    channel: &str,
) -> Result<Vec<u8>, FilterArithmeticError> {
    canonicalize(&[
        instance_id.to_string(),
        module_id.to_string(),
        channel.to_string(),
    ])
    .map(|(bytes, _)| bytes.as_ref().to_vec())
    .map_err(|_| FilterArithmeticError::Overflow)
}