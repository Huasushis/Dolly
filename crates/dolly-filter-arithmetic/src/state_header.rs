//! Pure state-header transitions for the Two-Thirds Mean Filter
//! (spec `dolly-spec/docs/spec/extensions/filter-two-thirds.md` §6).
//!
//! A [`FilterStateHeader`] is the frozen, version-pinned configuration
//! surface of one Filter channel's state: it freezes the algorithm revision,
//! the internal scale, and `bias_correction`, and it carries the channel's
//! current `observation_count`. This module implements ONLY the pure
//! `prepare_config` and `restart` transitions exercised by the authoritative
//! `TST-FILTER-005-state-header-config-fence` vector. It is NOT durable:
//! there is no JSON codec, no file or storage boundary, no reopen-from-disk
//! semantics, and the `state_epoch` is an opaque identifier supplied by the
//! caller — this module grants no authority to generate, validate, or
//! persist epochs.

use crate::SCALE;

/// Normative algorithm revision frozen into every valid state header
/// (spec §6; `filter-decision.schema.json`: `const
/// "two-thirds-mean-filter-v1"`).
const ALGORITHM_REVISION: &str = "two-thirds-mean-filter-v1";

/// Errors from the pure state-header transitions. This is the exact closed
/// error set; there is no silent fallback and no other failure path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilterStateHeaderError {
    /// A populated channel was asked to change `bias_correction` without a
    /// fresh `state_epoch` (wire code `FILTER_STATE_HEADER_CONFLICT`);
    /// zero state mutations are applied.
    Conflict,
    /// `algorithm_revision` is not the normative
    /// `two-thirds-mean-filter-v1`.
    InvalidAlgorithmRevision,
    /// `internal_scale` is not exactly `SCALE`.
    InvalidScale,
}

impl FilterStateHeaderError {
    /// Wire error code for a [`FilterStateHeaderError::Conflict`] transition.
    pub const CONFLICT_WIRE_CODE: &'static str = "FILTER_STATE_HEADER_CONFLICT";

    /// The wire code for this error, when it has one. The construction
    /// rejections (`InvalidAlgorithmRevision`, `InvalidScale`) are caller
    /// mistakes and carry no wire code.
    pub fn wire_code(self) -> Option<&'static str> {
        match self {
            FilterStateHeaderError::Conflict => Some(Self::CONFLICT_WIRE_CODE),
            FilterStateHeaderError::InvalidAlgorithmRevision
            | FilterStateHeaderError::InvalidScale => None,
        }
    }
}

/// Frozen state header of a Filter channel's state (spec §6). Every field is
/// private and only reachable through [`FilterStateHeader::new`], which
/// enforces the normative values, plus read accessors; a constructed header
/// is immutable and `Copy`.
///
/// `state_epoch` is an opaque, caller-supplied identifier (wire `StableId`):
/// this type neither generates nor validates it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FilterStateHeader<'a> {
    /// Module storage scope of the channel (wire `ModuleStorageScopeId`).
    storage_scope_id: &'a str,
    /// Filter channel identifier (wire `signal_channel`).
    channel: &'a str,
    /// Frozen algorithm revision, always the normative
    /// `two-thirds-mean-filter-v1`.
    algorithm_revision: &'a str,
    /// Frozen internal scale, always exactly `SCALE`.
    internal_scale: u64,
    /// Frozen bias-correction flag.
    bias_correction: bool,
    /// Number of observations applied in the channel's current state; a
    /// value greater than zero is "populated" state.
    observation_count: u64,
    /// Caller-supplied opaque state epoch.
    state_epoch: &'a str,
}

impl<'a> FilterStateHeader<'a> {
    /// Validate and construct a frozen state header. `algorithm_revision`
    /// must be `two-thirds-mean-filter-v1` and `internal_scale` must be
    /// exactly `SCALE`; any other value is rejected so the frozen surface is
    /// always the normative one.
    pub fn new(
        storage_scope_id: &'a str,
        channel: &'a str,
        algorithm_revision: &'a str,
        internal_scale: u64,
        bias_correction: bool,
        observation_count: u64,
        state_epoch: &'a str,
    ) -> Result<Self, FilterStateHeaderError> {
        if algorithm_revision != ALGORITHM_REVISION {
            return Err(FilterStateHeaderError::InvalidAlgorithmRevision);
        }
        if internal_scale != SCALE {
            return Err(FilterStateHeaderError::InvalidScale);
        }
        Ok(Self {
            storage_scope_id,
            channel,
            algorithm_revision,
            internal_scale,
            bias_correction,
            observation_count,
            state_epoch,
        })
    }

    /// Module storage scope of the channel.
    pub fn storage_scope_id(&self) -> &'a str {
        self.storage_scope_id
    }

    /// Filter channel identifier.
    pub fn channel(&self) -> &'a str {
        self.channel
    }

    /// Frozen algorithm revision.
    pub fn algorithm_revision(&self) -> &'a str {
        self.algorithm_revision
    }

    /// Frozen internal scale (always exactly `SCALE`).
    pub fn internal_scale(&self) -> u64 {
        self.internal_scale
    }

    /// Frozen bias-correction flag.
    pub fn bias_correction(&self) -> bool {
        self.bias_correction
    }

    /// Number of observations applied; greater than zero is populated state.
    pub fn observation_count(&self) -> u64 {
        self.observation_count
    }

    /// Caller-supplied opaque state epoch.
    pub fn state_epoch(&self) -> &'a str {
        self.state_epoch
    }
}

/// Whether a `prepare_config` operation acts on the current state epoch or
/// starts a fresh one (spec §6). Only `Fresh` may reinterpret a populated
/// channel. `Fresh` carries the caller-supplied new epoch identifier; this
/// module grants no authority to generate epochs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EpochMode<'a> {
    /// Keep the current state epoch; a populated channel is frozen.
    Unchanged,
    /// Start a fresh state epoch with the caller-supplied identifier.
    Fresh(&'a str),
}

/// `prepare_config`: freeze a new `bias_correction` for the channel's state.
///
/// Populated state (`observation_count > 0`) cannot be reinterpreted by a
/// bias toggle over the unchanged epoch (spec §6): that returns
/// [`FilterStateHeaderError::Conflict`] and applies zero mutations. With
/// `EpochMode::Fresh` the operation starts new state: the returned header
/// carries the caller-supplied new `state_epoch` and `observation_count = 0`
/// (nothing is inherited).
pub fn prepare_config<'a>(
    header: &FilterStateHeader<'a>,
    new_bias_correction: bool,
    epoch: EpochMode<'a>,
) -> Result<FilterStateHeader<'a>, FilterStateHeaderError> {
    match epoch {
        EpochMode::Unchanged => {
            if header.observation_count > 0 && new_bias_correction != header.bias_correction {
                return Err(FilterStateHeaderError::Conflict);
            }
            // Zero mutations over the unchanged epoch: every field is
            // preserved, and the bias adopts the (matching, or unpopulated
            // channel's) requested value.
            let mut next = *header;
            next.bias_correction = new_bias_correction;
            Ok(next)
        }
        EpochMode::Fresh(new_epoch) => {
            let mut next = *header;
            next.bias_correction = new_bias_correction;
            next.observation_count = 0;
            next.state_epoch = new_epoch;
            Ok(next)
        }
    }
}

/// `restart`: pure preserve transition.
///
/// A restart re-freezes the same configuration over the existing state
/// (spec §6). When the header is populated and the frozen
/// `bias_correction` differs, the state cannot be reopened and
/// [`FilterStateHeaderError::Conflict`] is returned with zero mutations.
/// Otherwise the header is preserved unchanged — every field, including
/// `observation_count`, is returned as-is. This is NOT a durable reopen: the
/// header is supplied by the caller and no storage boundary is involved.
pub fn restart<'a>(
    header: &FilterStateHeader<'a>,
    frozen_bias_correction: bool,
) -> Result<FilterStateHeader<'a>, FilterStateHeaderError> {
    if header.observation_count > 0 && frozen_bias_correction != header.bias_correction {
        return Err(FilterStateHeaderError::Conflict);
    }
    Ok(*header)
}
