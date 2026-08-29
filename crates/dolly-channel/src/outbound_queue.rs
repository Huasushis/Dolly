//! Bounded per-account/session pending queue with caller deadlines (seam D).
//!
//! The committed targeted-Action pipeline persists its durable `Prepared`
//! record FIRST, then admits the send into this bounded queue. Admission is
//! fair (FIFO per session; global arrival order when the ledger-wide
//! capacity binds) and waits only until the caller-provided deadline; expiry
//! returns a retryable timeout/backpressure result with no transport call and
//! no leaked slot. Saturation (the per-session request bound) fails
//! deterministically the same way. Waiting is quiescent: waiters sleep on a
//! condition variable woken by slot release, cancellation, and
//! [`BoundedPendingQueue::wake_all`], never by busy-polling the clock.

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Condvar, Mutex, MutexGuard};

use crate::clock::{Clock, timestamp_total_micros};
use crate::error::{ChannelError, ChannelDeliveryOutcome, ChannelOutcome, codes};

/// Waiters re-check the injected clock at most this often after a wake; the
/// [`BoundedPendingQueue::wake_all`] hook plus slot releases make tests
/// deterministic and keep production wake frequency bounded.
const WAKE_QUANTUM: std::time::Duration = std::time::Duration::from_millis(20);

/// Lock the shared queue state, recovering from a poisoned lock (a panicking
/// holder does not corrupt the queue; the inner state stays consistent).
fn lock_guard(inner: &Mutex<QueueInner>) -> MutexGuard<'_, QueueInner> {
    inner.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// One granted queue slot. Dropping it releases the slot (RAII), so an error
/// path, cancellation, or worker teardown can never leak capacity.
pub struct PendingQueueSlot {
    inner: std::sync::Arc<Mutex<QueueInner>>,
    changed: std::sync::Arc<Condvar>,
    per_session_capacity: usize,
    session_key: String,
}

impl PendingQueueSlot {
    /// The account-scoped session this slot was granted for.
    pub fn session_key(&self) -> &str {
        &self.session_key
    }
}

impl std::fmt::Debug for PendingQueueSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PendingQueueSlot")
            .field("session_key", &self.session_key)
            .finish_non_exhaustive()
    }
}

impl Drop for PendingQueueSlot {
    fn drop(&mut self) {
        let mut guard = lock_guard(&self.inner);
        release_locked(
            &self.changed,
            &mut guard,
            self.per_session_capacity,
            &self.session_key,
        );
    }
}

struct SessionQueue {
    /// Granted (in-flight) sends for this session.
    inflight: usize,
    /// FIFO waiter ids in arrival order (fair, starvation-free).
    waiters: VecDeque<u64>,
}

impl Default for SessionQueue {
    fn default() -> Self {
        Self {
            inflight: 0,
            waiters: VecDeque::new(),
        }
    }
}

#[derive(Default)]
struct QueueInner {
    total_capacity: usize,
    total_inflight: usize,
    next_waiter_id: u64,
    sessions: BTreeMap<String, SessionQueue>,
    /// Waiter id -> session key of the waiting caller.
    waiters: BTreeMap<u64, String>,
}

/// A bounded per-account/session FIFO pending queue with an explicit
/// `max_pending` and caller-provided admission deadlines.
///
/// - Capacity: at most `max_pending_per_session` granted (in-flight) sends
///   per session AND at most that many waiters behind them before admission
///   fails as saturated; at most `max_pending_total` granted ledger-wide.
/// - Fairness: grants follow arrival order (session FIFO; global arrival
///   order when the ledger-wide capacity is the binding constraint), so a
///   caller can never starve a waiter behind it.
/// - Deadlines: [`BoundedPendingQueue::admit`] waits only until the caller
///   deadline, then returns a retryable `CHANNEL_RATE_LIMITED` backpressure
///   with no transport call and no leaked slot; a failed admission leaves the
///   queue unchanged.
pub struct BoundedPendingQueue {
    inner: std::sync::Arc<Mutex<QueueInner>>,
    changed: std::sync::Arc<Condvar>,
    per_session_capacity: usize,
}

impl BoundedPendingQueue {
    /// `max_pending_per_session` is the per-session in-flight AND waiter
    /// bound; `max_pending_total` is the ledger-wide in-flight bound.
    pub fn new(max_pending_per_session: usize, max_pending_total: usize) -> Self {
        Self {
            inner: std::sync::Arc::new(Mutex::new(QueueInner {
                total_capacity: max_pending_total,
                ..QueueInner::default()
            })),
            changed: std::sync::Arc::new(Condvar::new()),
            per_session_capacity: max_pending_per_session,
        }
    }

    fn backpressure(session_key: &str, reason: &str) -> ChannelError {
        ChannelError::new(
            codes::RATE_LIMITED,
            true,
            ChannelOutcome::NotApplied,
            format!("outbound queue backpressure for session {session_key}: {reason}"),
        )
        .with_delivery(ChannelDeliveryOutcome::NotSent)
    }

    /// Grant one slot for `session_key`, waiting fairly only until the
    /// caller-provided `caller_deadline` (injected clock). Returns the RAII
    /// slot on success; a retryable backpressure error on deadline expiry or
    /// saturation, with zero transport call and zero leaked slot.
    pub fn admit(
        &self,
        clock: &dyn Clock,
        session_key: &str,
        caller_deadline: &str,
    ) -> Result<PendingQueueSlot, ChannelError> {
        let deadline_micros = timestamp_total_micros(caller_deadline);
        let mut guard = lock_guard(&self.inner);
        if grant_new_locked(&mut guard, self.per_session_capacity, session_key) {
            return Ok(self.slot(session_key));
        }
        let waiters = guard
            .sessions
            .entry(session_key.to_string())
            .or_default()
            .waiters
            .len();
        if waiters >= self.per_session_capacity {
            return Err(Self::backpressure(
                session_key,
                "session queue is saturated at max_pending",
            ));
        }
        let id = guard.next_waiter_id;
        guard.next_waiter_id += 1;
        guard
            .sessions
            .get_mut(session_key)
            .expect("session queue exists")
            .waiters
            .push_back(id);
        guard.waiters.insert(id, session_key.to_string());
        loop {
            if timestamp_total_micros(clock.now().as_str()) >= deadline_micros {
                remove_waiter_locked(
                    &self.changed,
                    &mut guard,
                    self.per_session_capacity,
                    id,
                );
                return Err(Self::backpressure(
                    session_key,
                    "caller deadline expired while waiting for a queue slot",
                ));
            }
            if guard.waiters.get(&id).is_none() {
                // Granted: the grant path removed this waiter and counted it
                // in-flight.
                return Ok(self.slot(session_key));
            }
            let (next_guard, _timed_out) = self
                .changed
                .wait_timeout(guard, WAKE_QUANTUM)
                .unwrap_or_else(|poison| poison.into_inner());
            guard = next_guard;
        }
    }

    fn slot(&self, session_key: &str) -> PendingQueueSlot {
        PendingQueueSlot {
            inner: std::sync::Arc::clone(&self.inner),
            changed: std::sync::Arc::clone(&self.changed),
            per_session_capacity: self.per_session_capacity,
            session_key: session_key.to_string(),
        }
    }

    /// Wake every waiting admission so callers re-evaluate the injected
    /// clock (test/driver hook; slot release and cancellation also wake).
    pub fn wake_all(&self) {
        self.changed.notify_all();
    }

    /// Granted (in-flight) slots for one session.
    pub fn inflight(&self, session_key: &str) -> usize {
        lock_guard(&self.inner)
            .sessions
            .get(session_key)
            .map(|s| s.inflight)
            .unwrap_or(0)
    }

    /// Granted (in-flight) slots ledger-wide.
    pub fn total_inflight(&self) -> usize {
        lock_guard(&self.inner).total_inflight
    }

    /// Callers waiting (queued, not yet granted) for one session.
    pub fn waiting(&self, session_key: &str) -> usize {
        lock_guard(&self.inner)
            .sessions
            .get(session_key)
            .map(|s| s.waiters.len())
            .unwrap_or(0)
    }

    /// Waiters queued ledger-wide.
    pub fn total_waiting(&self) -> usize {
        lock_guard(&self.inner).waiters.len()
    }
}

/// Grant the earliest arrived waiter whose session has capacity, when the
/// ledger-wide bound still has room.
fn grant_earliest_locked(
    guard: &mut MutexGuard<'_, QueueInner>,
    per_session_capacity: usize,
) -> bool {
    let candidate = guard.waiters.iter().find(|(_, session_key)| {
        guard
            .sessions
            .get(*session_key)
            .map(|session| session.inflight < per_session_capacity)
            .unwrap_or(false)
    });
    let (&id, session_key) = match candidate {
        Some((id, session_key)) => (id, session_key.clone()),
        None => return false,
    };
    if guard.total_inflight >= guard.total_capacity {
        return false;
    }
    let session = guard
        .sessions
        .get_mut(&session_key)
        .expect("granted waiter's session exists");
    session.inflight += 1;
    session.waiters.retain(|w| *w != id);
    guard.total_inflight += 1;
    guard.waiters.remove(&id);
    true
}

/// Grant one in-flight slot to a brand-new caller whose session has no
/// waiters ahead and whose grant fits the ledger-wide bound.
fn grant_new_locked(
    guard: &mut MutexGuard<'_, QueueInner>,
    per_session_capacity: usize,
    session_key: &str,
) -> bool {
    if guard.total_inflight >= guard.total_capacity {
        return false;
    }
    let session = guard.sessions.entry(session_key.to_string()).or_default();
    if !session.waiters.is_empty() || session.inflight >= per_session_capacity {
        return false;
    }
    session.inflight += 1;
    guard.total_inflight += 1;
    true
}

fn release_locked(
    changed: &Condvar,
    guard: &mut MutexGuard<'_, QueueInner>,
    per_session_capacity: usize,
    session_key: &str,
) {
    if let Some(session) = guard.sessions.get_mut(session_key) {
        session.inflight = session.inflight.saturating_sub(1);
        if session.inflight == 0 && session.waiters.is_empty() {
            guard.sessions.remove(session_key);
        }
    }
    guard.total_inflight = guard.total_inflight.saturating_sub(1);
    grant_earliest_locked(guard, per_session_capacity);
    changed.notify_all();
}

fn remove_waiter_locked(
    changed: &Condvar,
    guard: &mut MutexGuard<'_, QueueInner>,
    per_session_capacity: usize,
    id: u64,
) {
    if let Some(session_key) = guard.waiters.remove(&id) {
        if let Some(session) = guard.sessions.get_mut(&session_key) {
            session.waiters.retain(|w| *w != id);
            if session.inflight == 0 && session.waiters.is_empty() {
                guard.sessions.remove(&session_key);
            }
        }
    }
    grant_earliest_locked(guard, per_session_capacity);
    changed.notify_all();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::VirtualClock;
    use dolly_core_domain::Timestamp;
    use std::str::FromStr;

    fn ts(s: &str) -> Timestamp {
        Timestamp::from_str(s).unwrap()
    }

    fn clock() -> VirtualClock {
        VirtualClock::at(ts("2026-08-09T15:00:00.000000Z"))
    }

    #[test]
    fn capacity_is_bounded_and_expired_deadline_leaks_no_slot() {
        let queue = BoundedPendingQueue::new(2, 8);
        let mut c = clock();
        let _a = queue.admit(&c, "acc\0s1", "2026-08-09T15:00:10.000000Z").unwrap();
        let _b = queue.admit(&c, "acc\0s1", "2026-08-09T15:00:10.000000Z").unwrap();
        assert_eq!(queue.inflight("acc\0s1"), 2);
        // A third request with an already-expired deadline is refused with
        // retryable backpressure and leaks no slot.
        c.advance_seconds(11);
        let err = queue
            .admit(&c, "acc\0s1", "2026-08-09T15:00:10.000000Z")
            .expect_err("expired caller deadline must backpressure");
        assert_eq!(err.code, codes::RATE_LIMITED);
        assert!(err.retryable);
        assert_eq!(queue.inflight("acc\0s1"), 2, "no slot leaked");
        assert_eq!(queue.total_inflight(), 2);
    }

    #[test]
    fn saturated_session_fails_deterministically() {
        let queue = BoundedPendingQueue::new(1, 8);
        let c = clock();
        let slot = queue.admit(&c, "acc\0s1", "2026-08-09T15:00:30.000000Z").unwrap();
        // A second admission enqueues (one waiter) behind the in-flight slot.
        let queue = std::sync::Arc::new(queue);
        let q = std::sync::Arc::clone(&queue);
        let c2 = clock();
        std::thread::spawn(move || {
            let _waiting_slot = q
                .admit(&c2, "acc\0s1", "2026-08-09T16:00:00.000000Z")
                .expect("far deadline must eventually grant");
        });
        // Wait until the waiter is queued; then the waiter bound is full and
        // a third admission fails deterministically with no slot leak.
        for _ in 0..1000 {
            if queue.waiting("acc\0s1") == 1 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        assert_eq!(queue.waiting("acc\0s1"), 1);
        let err = queue
            .admit(&c, "acc\0s1", "2026-08-09T15:00:30.000000Z")
            .expect_err("full session must backpressure");
        assert_eq!(err.code, codes::RATE_LIMITED);
        assert_eq!(queue.inflight("acc\0s1"), 1);
        drop(slot);
        // The waiting admission is granted once the in-flight slot frees and
        // released when its thread drops the slot. Drain before asserting.
        for _ in 0..1000 {
            if queue.total_inflight() == 0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        assert_eq!(queue.total_inflight(), 0, "waiting slot also released");
    }

    #[test]
    fn fifo_fairness_grants_in_arrival_order() {
        let queue = std::sync::Arc::new(BoundedPendingQueue::new(2, 8));
        let far = "2026-08-09T16:00:00.000000Z".to_string();
        let c0 = clock();
        // Fill the session's in-flight bound so both subsequent callers wait.
        let hold = queue.admit(&c0, "acc\0s1", &far).unwrap();
        let hold2 = queue.admit(&c0, "acc\0s1", &far).unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<(u8, PendingQueueSlot)>();
        let spawn_waiter = |tag: u8, queue: std::sync::Arc<BoundedPendingQueue>, tx: std::sync::mpsc::Sender<(u8, PendingQueueSlot)>| {
            let c = clock();
            let far = far.clone();
            std::thread::spawn(move || {
                let slot = queue
                    .admit(&c, "acc\0s1", &far)
                    .expect("far future deadline must eventually grant");
                tx.send((tag, slot)).unwrap();
            });
        };
        spawn_waiter(b'1', queue.clone(), tx.clone());
        // W1 must reach the queue before W2 spawns, so their arrival order
        // (and thus the FIFO grant order) is deterministic.
        for _ in 0..1000 {
            if queue.waiting("acc\0s1") == 1 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        assert_eq!(queue.waiting("acc\0s1"), 1, "W1 must queue first");
        spawn_waiter(b'2', queue.clone(), tx.clone());
        for _ in 0..1000 {
            if queue.waiting("acc\0s1") == 2 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        assert_eq!(queue.waiting("acc\0s1"), 2, "W2 must queue second");
        drop(tx);
        // Release the second hold: one slot frees; FIFO grants the EARLIEST
        // waiter (W1) first. The granted slot is kept held by the receiver.
        drop(hold2);
        let (first_tag, first_slot) =
            rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(first_tag, b'1', "earliest waiter must be granted before a later one");
        // Release the first hold: W2 is granted next.
        drop(hold);
        let (second_tag, second_slot) =
            rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(second_tag, b'2', "grants follow strict arrival order");
        drop(first_slot);
        drop(second_slot);
    }

    #[test]
    fn ledger_wide_capacity_is_enforced_across_sessions() {
        let queue = BoundedPendingQueue::new(4, 1);
        let mut c = clock();
        let a = queue.admit(&c, "acc\0a", "2026-08-09T15:00:60.000000Z").unwrap();
        assert_eq!(queue.total_inflight(), 1);
        // The ledger-wide bound (1) is spent; a second session's admission
        // enqueues then expires at its (already-passed) deadline.
        c.advance_seconds(1);
        let err = queue
            .admit(&c, "acc\0b", "2026-08-09T15:00:00.000000Z")
            .expect_err("ledger-wide capacity bound must backpressure");
        assert_eq!(err.code, codes::RATE_LIMITED);
        assert_eq!(queue.total_inflight(), 1);
        drop(a);
        assert_eq!(queue.total_inflight(), 0);
    }

    #[test]
    fn expiry_while_waiting_releases_waiter_and_leaks_no_slot() {
        let queue = BoundedPendingQueue::new(2, 8);
        let c = clock();
        let hold = queue.admit(&c, "acc\0s1", "2026-08-09T16:00:00.000000Z").unwrap();
        let hold2 = queue.admit(&c, "acc\0s1", "2026-08-09T16:00:00.000000Z").unwrap();
        let q = std::sync::Arc::new(queue);
        let expired = "2026-08-09T14:59:00.000000Z".to_string();
        let (tx, rx) = std::sync::mpsc::channel::<Result<PendingQueueSlot, ChannelError>>();
        for _ in 0..2 {
            let q = std::sync::Arc::clone(&q);
            let tx = tx.clone();
            let c = clock();
            let expired = expired.clone();
            std::thread::spawn(move || {
                tx.send(q.admit(&c, "acc\0s1", &expired)).unwrap();
            });
        }
        drop(tx);
        for _ in 0..2 {
            let result = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
            assert!(result.is_err(), "already-expired deadline must backpressure");
        }
        assert_eq!(q.inflight("acc\0s1"), 2, "the two granted holds are the only slots");
        assert_eq!(q.total_inflight(), 2);
        drop(hold);
        drop(hold2);
        assert_eq!(q.total_inflight(), 0);
    }
}
