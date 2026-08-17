//! Dolly Extension wire-protocol slice: bounded framing, JSON-RPC 2.0 envelope,
//! initialize-first ordering.
//!
//! Scope is bounded to `dolly-spec/docs/spec/extension-protocol/01-wire-protocol.md`
//! framing plus envelope, exercised by `TST-PROTO-001/002/003` vectors in
//! `crates/dolly-protocol/tests/protocol_vectors.rs`.

pub mod connection;
pub mod frame;
pub mod message;

pub use connection::{
    Connection, ConnectionEvent, ConnectionState, ProtocolViolation, ViolationKind,
};
pub use frame::{
    FrameError, FrameLimits, FrameLimitsError, FrameReader, encode_frame, frame_bounds_compatible,
};
pub use message::{DecodedMessage, MessageError, MessageKind};
