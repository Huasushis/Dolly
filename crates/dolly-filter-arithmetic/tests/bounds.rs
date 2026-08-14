//! Boundary tests for the bounded WP-021A arithmetic oracle.
//!
//! These tests pin the hardened input contract: the normative fixed internal
//! scale `R = SCALE`, the maximum selection cohort of 16, pre-clamped
//! corrected values, and the mandatory clamp/output bound. Every test asserts
//! errors or results; none panics in the library path.

use dolly_filter_arithmetic::{
    Accumulator, Candidate, FilterArithmeticError, FilterConfig, MAX_Q, MAX_SCORE, SCALE,
    corrected_score_q, normalized_score, select_winner, update,
};

#[test]
fn filter_config_rejects_non_fixed_scale() {
    // R is fixed at 1_000_000 by the normative spec; every other scale must be
    // rejected rather than silently accepted (and never silently saturated).
    assert!(FilterConfig::new(7, true, SCALE).is_ok());
    assert!(FilterConfig::new(7, true, SCALE - 1).is_err());
    assert!(FilterConfig::new(7, true, SCALE + 1).is_err());
    assert!(FilterConfig::new(7, true, 0).is_err());
    assert!(FilterConfig::new(7, true, 1).is_err());
    assert_eq!(
        FilterConfig::new(7, true, 999_999),
        Err(FilterArithmeticError::InvalidScale)
    );
}

#[test]
fn select_winner_rejects_cohort_beyond_16() {
    // The normative maximum cohort is 16 active modules; the aggregate math
    // is only defined inside that bound.
    let candidates: Vec<Candidate> = (0..17)
        .map(|i| Candidate {
            module_id: format!("m{i}"),
            corrected_score_q: MAX_Q,
        })
        .collect();
    assert!(select_winner("inst", "default", &candidates).is_err());
}

#[test]
fn select_winner_accepts_max_cohort_of_16() {
    let candidates: Vec<Candidate> = (0..16)
        .map(|i| Candidate {
            module_id: format!("m{i}"),
            corrected_score_q: MAX_Q,
        })
        .collect();
    let selection = select_winner("inst", "default", &candidates)
        .expect("cohort of exactly 16 must be accepted")
        .expect("selection");
    assert_eq!(selection.distances.len(), 16);
    assert!(selection.winner.is_some());
}

#[test]
fn select_winner_rejects_unclamped_candidate() {
    // Corrected values enter selection only after the mandatory clamp.
    let candidates = vec![Candidate {
        module_id: "m0".into(),
        corrected_score_q: MAX_Q + 1,
    }];
    assert!(select_winner("inst", "default", &candidates).is_err());
}

#[test]
fn normalized_score_rejects_unclamped_output() {
    let cfg = FilterConfig::new(7, true, SCALE).unwrap();
    assert_eq!(normalized_score(&cfg, MAX_Q).unwrap(), MAX_SCORE);
    assert!(normalized_score(&cfg, MAX_Q + 1).is_err());
}

#[test]
fn clamp_q_saturates_at_ceiling_without_saturation_arithmetic() {
    let cfg = FilterConfig::new(7, true, SCALE).unwrap();
    assert_eq!(cfg.clamp_q(0), 0);
    assert_eq!(cfg.clamp_q(MAX_Q), MAX_Q);
    // Raw corrected values may overshoot the ceiling (e.g. the 003 boundary):
    // the clamp must cut them off exactly at MAX_Q, not silently wrap/multiply.
    assert_eq!(cfg.clamp_q(MAX_Q + 1), MAX_Q);
    assert_eq!(cfg.clamp_q(1_000_501_064), MAX_Q);
    assert_eq!(cfg.clamp_q(u64::MAX), MAX_Q);
}

#[test]
fn update_rejects_score_above_max() {
    let mut acc = Accumulator::default();
    let cfg = FilterConfig::new(7, true, SCALE).unwrap();
    assert!(update(&cfg, &mut acc, MAX_SCORE + 1).is_err());
    assert_eq!(acc.observation_count, 0);
}

#[test]
fn corrected_score_q_errors_before_first_observation() {
    let cfg = FilterConfig::new(7, true, SCALE).unwrap();
    assert_eq!(
        corrected_score_q(&cfg, &Accumulator::default()),
        Err(FilterArithmeticError::ZeroWeight)
    );
}
