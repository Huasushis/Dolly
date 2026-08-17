//! Frozen `CoreTransaction` interface for the first storage slice.
//!
//! This is the transaction boundary required by INV-TXN-001: every durable
//! side effect of a Core transition (output commit, durable Page appends,
//! lossy Page sequence reservation, Activation terminal state, durable input
//! cursor advancement) is committed together by one `commit`. The trait is a
//! contract — this slice deliberately provides no SQLite-backed
//! implementation (the real one is provisioned separately against a reviewed
//! SQLite 3.51.3 amalgamation).

use crate::error::StorageResult;
use dolly_core_reducer::{CoreCommand, CoreEvent, CoreSnapshot, Transition};
#[cfg(test)]
use dolly_core_reducer::{TransitionOutcome, empty_core_snapshot};

/// One atomic Core transition plus its journal under a single storage commit.
///
/// Method ordering is the caller's responsibility and mirrors the reducer:
/// `load_command_snapshot` retains the pre-command snapshot, the runtime
/// evaluates the command, then `compare_and_apply` persists the resulting
/// `Transition` atomically — all journal events the transition produced are
/// written by the same `commit`.
///
/// No method may open, migrate, or checkpoint anything; those are startup and
/// recovery concerns outside a transaction.
pub trait CoreTransaction {
    /// Load the snapshot a command will be evaluated against.
    fn load_command_snapshot(&mut self, command: &CoreCommand) -> StorageResult<CoreSnapshot>;

    /// Persist a reducer-produced transition, atomically with the journal.
    fn compare_and_apply(&mut self, transition: &Transition) -> StorageResult<()>;

    /// Append journal records inside the current transaction.
    fn append_journal(&mut self, events: &[CoreEvent]) -> StorageResult<()>;

    /// Commit the accumulated writes as one SQLite transaction.
    fn commit(self) -> StorageResult<()>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::StorageError;

    /// Minimal bookkeeping implementation; only proves the interface freezes.
    struct Counting {
        applied: usize,
        journal: usize,
    }

    impl CoreTransaction for Counting {
        fn load_command_snapshot(&mut self, _command: &CoreCommand) -> StorageResult<CoreSnapshot> {
            Err(StorageError::MigrationRequired)
        }
        fn compare_and_apply(&mut self, _transition: &Transition) -> StorageResult<()> {
            self.applied += 1;
            Ok(())
        }
        fn append_journal(&mut self, events: &[CoreEvent]) -> StorageResult<()> {
            self.journal += events.len();
            Ok(())
        }
        fn commit(self) -> StorageResult<()> {
            Ok(())
        }
    }

    #[test]
    fn trait_freeze_shapes() {
        let result = Counting {
            applied: 0,
            journal: 0,
        }
        .load_command_snapshot(&CoreCommand::SkipRange(
            dolly_core_reducer::SkipRangeCommand {
                command_id: "c1".into(),
                subscription_id: "s1".into(),
                start: 0,
                end_exclusive: 0,
            },
        ));
        assert!(result.is_err());
        let mut tx = Counting {
            applied: 0,
            journal: 0,
        };
        let _ = tx.compare_and_apply(&tmpl());
        let _ = tx.append_journal(&[]);
        assert!(tx.commit().is_ok());
    }

    fn tmpl() -> Transition {
        let state = empty_core_snapshot();
        Transition {
            outcome: TransitionOutcome::Committed,
            state: state.clone(),
            events: vec![],
            error: None,
            reply: None,
            projection: serde_json::Value::Null,
            state_hash: "".into(),
            safety_stop: None,
        }
    }
}
