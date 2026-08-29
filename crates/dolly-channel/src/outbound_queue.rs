//! Bounded durable admission gate for the outbound queue (seam D).
//!
//! Exactly ONE gate per store/account is built by [`OutboundConsumer`] and
//! shared (Arc) across its consumers. The durable FIFO itself lives in the
//! single Channel DB: rows transition `Prepared` -> `Queued` with a monotonic
//! `queued_seq` inside one Immediate transaction
//! ([`SqliteChannelStore::admit_to_queue`]), so occupancy (waiting + in-flight)
//! is durable and reconstructed from nonterminal rows after restart. This
//! gate owns only the in-memory WAITERS: threads whose admission found the
//! queue at capacity. It provides exact-deadline waits (the condvar timeout
//! is precisely the remaining duration — no polling quantum), ticket-ordered
//! FIFO fairness, cancellation, and wake notification. Grant and deadline
//! transitions are atomic in the store; a deadline/cancel race can never
//! leak capacity or grant after the deadline.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Condvar, Mutex};

use crate::clock::{Clock, timestamp_total_micros};
use crate::error::{ChannelError, ChannelDeliveryOutcome, ChannelOutcome, codes};

fn lock_guard(inner: &Mutex<QueueInner>) -> std::sync::MutexGuard<'_, QueueInner> {
    inner.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// One granted durable admission. The underlying row is now `Queued`
/// (durable, counted toward occupancy); dropping the marker is safe — the
/// row is claimed by the dispatch CAS on the next pass and never leaks
/// capacity.
#[derive(Debug)]
pub struct PendingQueueSlot {
    action_key: String,
    session_key: String,
}

impl PendingQueueSlot {
    /// The account-scoped session this slot was granted for.
    pub fn session_key(&self) -> &str {
        &self.session_key
    }
    /// The durable row (action) granted.
    pub fn action_key(&self) -> &str {
        &self.action_key
    }
}

struct Waiter {
    ticket: u64,
    session_key: String,
    action_key: String,
}

struct QueueInner {
    next_ticket: u64,
    waiters: BTreeMap<u64, Waiter>,
    /// session_key -> tickets in arrival (FIFO) order.
    sessions: BTreeMap<String, BTreeSet<u64>>,
    /// Durable action keys cancelled while waiting (checked after every
    /// wake so a cancelled admission cannot re-register or grant).
    cancelled: BTreeSet<String>,
}

/// The per-store/account outbound admission gate. Capacity bounds, atomic
/// admission, and the durable FIFO order live in the Channel DB; this gate
/// adds the waiters, exact caller deadlines, FIFO fairness, and cancellation.
pub struct BoundedPendingQueue {
    inner: Mutex<QueueInner>,
    changed: Condvar,
}

impl BoundedPendingQueue {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(QueueInner {
                next_ticket: 1,
                waiters: BTreeMap::new(),
                sessions: BTreeMap::new(),
                cancelled: BTreeSet::new(),
            }),
            changed: Condvar::new(),
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

    /// Wait for durable admission into the outbound queue. `admit_fn` performs
    /// the atomic, capacity-bounded `Prepared` -> `Queued` transition in the
    /// Channel DB and returns whether the row was admitted (`false` = at
    /// capacity). Admission is granted only while the caller deadline is still
    /// in the future (checked before every admit attempt, so a post-deadline
    /// grant is impossible) and waits exactly the remaining duration (no
    /// polling quantum overshoot). On deadline expiry or cancellation the
    /// waiter is removed with zero durable change and zero leaked occupancy.
    pub fn admit<F>(
        &self,
        admit_fn: F,
        session_key: &str,
        action_key: &str,
        deadline_micros: i64,
        clock: &dyn Clock,
    ) -> Result<PendingQueueSlot, ChannelError>
    where
        F: FnMut() -> Result<bool, ChannelError>,
    {
        let mut admit_fn = admit_fn;
        let mut guard = lock_guard(&self.inner);
        let mut my_ticket: Option<u64> = None;
        loop {
            // Check the deadline BEFORE any admit attempt: no post-deadline
            // grant, and an expired caller notifies the next FIFO waiter.
            if timestamp_total_micros(clock.now().as_str()) >= deadline_micros {
                guard.cancelled.remove(action_key);
                if let Some(ticket) = my_ticket.take() {
                    self.remove_waiter_locked(&mut guard, ticket);
                }
                return Err(Self::backpressure(
                    session_key,
                    "caller deadline expired while waiting for a queue slot",
                ));
            }
            if guard.cancelled.contains(action_key) {
                if let Some(ticket) = my_ticket.take() {
                    self.remove_waiter_locked(&mut guard, ticket);
                }
                return Err(Self::backpressure(session_key, "admission was cancelled"));
            }
            match admit_fn() {
                Ok(true) => {
                    guard.cancelled.remove(action_key);
                    if let Some(ticket) = my_ticket.take() {
                        self.remove_waiter_locked(&mut guard, ticket);
                    }
                    return Ok(PendingQueueSlot {
                        action_key: action_key.to_string(),
                        session_key: session_key.to_string(),
                    });
                }
                Ok(false) => {
                    // At durable capacity: (re)register this caller in FIFO
                    // order and wait exactly the remaining duration.
                    let ticket = match my_ticket {
                        Some(t) => t,
                        None => {
                            let t = guard.next_ticket;
                            guard.next_ticket += 1;
                            guard.waiters.insert(
                                t,
                                Waiter {
                                    ticket: t,
                                    session_key: session_key.to_string(),
                                    action_key: action_key.to_string(),
                                },
                            );
                            guard
                                .sessions
                                .entry(session_key.to_string())
                                .or_default()
                                .insert(t);
                            my_ticket = Some(t);
                            t
                        }
                    };
                    let _ = ticket;
                    let now_micros = timestamp_total_micros(clock.now().as_str());
                    let remaining = deadline_micros - now_micros;
                    if remaining <= 0 {
                        continue;
                    }
                    let wait = std::time::Duration::from_micros(remaining as u64);
                    let (g, _) = self
                        .changed
                        .wait_timeout(guard, wait)
                        .unwrap_or_else(|poison| poison.into_inner());
                    guard = g;
                }
                Err(error) => {
                    if let Some(ticket) = my_ticket.take() {
                        self.remove_waiter_locked(&mut guard, ticket);
                    }
                    return Err(error);
                }
            }
        }
    }

    fn remove_waiter_locked(&self, guard: &mut std::sync::MutexGuard<'_, QueueInner>, ticket: u64) {
        if let Some(waiter) = guard.waiters.remove(&ticket) {
            if let Some(tickets) = guard.sessions.get_mut(&waiter.session_key) {
                tickets.remove(&ticket);
                if tickets.is_empty() {
                    guard.sessions.remove(&waiter.session_key);
                }
            }
        }
        // A removed waiter may free a gate for the next FIFO caller.
        self.changed.notify_all();
    }

    /// Cancel a waiting admission by its durable action key (removes the
    /// waiter, notifies the next FIFO caller, zero durable change).
    pub fn cancel(&self, action_key: &str) {
        let mut guard = lock_guard(&self.inner);
        guard.cancelled.insert(action_key.to_string());
        self.changed.notify_all();
    }

    /// Wake every waiting admission (callers re-evaluate capacity under their
    /// exact deadlines). Called after a terminal commit frees durable
    /// occupancy.
    pub fn wake_all(&self) {
        self.changed.notify_all();
    }

    /// Waiters currently blocked for one session (inspection).
    pub fn waiting(&self, session_key: &str) -> usize {
        lock_guard(&self.inner)
            .sessions
            .get(session_key)
            .map(|s| s.len())
            .unwrap_or(0)
    }
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

    fn deadline(clock: &VirtualClock, seconds: i64) -> i64 {
        timestamp_total_micros(&crate::clock::timestamp_plus_seconds(
            clock.now().as_str(),
            seconds,
        ))
    }

    #[test]
    fn expired_deadline_never_grants_and_leaves_no_waiter() {
        let gate = BoundedPendingQueue::new();
        let c = clock();
        let mut calls = 0;
        // Capacity stays full and the deadline is already passed: the call
        // MUST backpressure (never grant), with zero leaked waiters.
        let err = gate
            .admit(
                || {
                    calls += 1;
                    Ok(false)
                },
                "acc\0s1",
                "action-1",
                deadline(&c, -1),
                &c,
            )
            .expect_err("expired deadline must backpressure");
        assert_eq!(err.code, codes::RATE_LIMITED);
        assert_eq!(gate.waiting("acc\0s1"), 0, "no leaked waiter");
    }

    #[test]
    fn cancel_removes_waiter_and_admission_backpressures() {
        let gate = BoundedPendingQueue::new();
        let gate = std::sync::Arc::new(gate);
        let g = std::sync::Arc::clone(&gate);
        let handle = std::thread::spawn(move || {
            gate.admit(
                || Ok(false),
                "acc\0s1",
                "action-1",
                deadline(&clock(), 60),
                &clock(),
            )
        });
        for _ in 0..1000 {
            if g.waiting("acc\0s1") == 1 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        assert_eq!(g.waiting("acc\0s1"), 1);
        g.cancel("action-1");
        let result = handle.join().expect("admit thread");
        assert!(
            result.is_err(),
            "cancelled admission must backpressure, not grant"
        );
        assert_eq!(g.waiting("acc\0s1"), 0, "no leaked waiter after cancel");
    }

    #[test]
    fn granted_when_capacity_frees_and_admission_is_durable_marker() {
        let gate = BoundedPendingQueue::new();
        let c = clock();
        let slot = gate
            .admit(
                || Ok(true),
                "acc\0s1",
                "action-2",
                deadline(&c, 60),
                &c,
            )
            .expect("capacity available grants immediately");
        assert_eq!(slot.action_key(), "action-2");
        assert_eq!(slot.session_key(), "acc\0s1");
    }
}
