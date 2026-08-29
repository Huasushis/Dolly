//! Deterministic identity derivation for the Channel.
//!
//! The Channel never invents a Block or Asset ID (those are minted by Core).
//! What it derives are the stable *keys* it must own:
//!
//! - the principal-derived Channel account (the deduplication namespace of
//!   one sealed Host authority/grant),
//! - the account-scoped inbound ingress key,
//! - the operation digest of a byte-identical draft,
//! - the outbound transport idempotency key derived from `action_id`,
//! - deterministic per-operation request IDs, and
//! - deterministic Dolly session IDs for the Channel-owned SessionMap.
//!
//! Every derivation is a pure SHA-256 of a fixed domain-separated input so
//! replays across restarts produce byte-identical keys.

use dolly_canonical_json::Sha256Digest;

const INGRESS_KEY_PREFIX: &[u8] = b"org.dolly.channel\0ingress\0";
const OPERATION_PREFIX: &[u8] = b"org.dolly.channel\0operation\0";
const OUTBOUND_IDEMPOTENCY_PREFIX: &[u8] = b"org.dolly.channel\0send\0";

fn domain_hash(prefix: &[u8], parts: &[&[u8]]) -> String {
    let mut input = Vec::with_capacity(prefix.len() + parts.iter().map(|p| p.len() + 1).sum::<usize>());
    input.extend_from_slice(prefix);
    for part in parts {
        input.extend_from_slice(part);
        input.push(0);
    }
    Sha256Digest::compute(&input).to_string()
}

fn domain_hash_raw(prefix: &[u8], parts: &[&[u8]]) -> String {
    let mut input = Vec::with_capacity(prefix.len() + parts.iter().map(|p| p.len() + 1).sum::<usize>());
    input.extend_from_slice(prefix);
    for part in parts {
        input.extend_from_slice(part);
        input.push(0);
    }
    hex_lower(Sha256Digest::compute(&input).as_bytes())
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// The stable ingress key for one (`transport_account`, `external_message_id`)
/// pair. The account is part of the key, so reusing an external message ID in
/// another transport account can never collide, and a configured account
/// change creates a fresh deduplication namespace.
pub fn inbound_ingress_key(transport_account: &str, external_message_id: &str) -> String {
    domain_hash(
        INGRESS_KEY_PREFIX,
        &[transport_account.as_bytes(), external_message_id.as_bytes()],
    )
}

/// The operation digest of one byte-identical draft request. Two submissions
/// replay idempotently in Core exactly when this digest matches.
pub fn operation_digest(canonical_draft_bytes: &[u8]) -> String {
    domain_hash(OPERATION_PREFIX, &[canonical_draft_bytes])
}

/// The deterministic Channel account handle of one sealed principal: a
/// domain-separated digest over the authority-bound owner (Host connection
/// identity), granted Extension, granted Module, and worker epoch (instance).
///
/// The account is a pure function of the sealed current Host authority and
/// capability grant, so a transport event carries no account claim a caller
/// could forge, and two principals can never collide in the Channel
/// deduplication namespace.
pub fn channel_account(
    owner: &str,
    extension_id: &str,
    module_id: &str,
    instance_id: &str,
) -> String {
    let digest = domain_hash_raw(
        b"org.dolly.channel\0account\0",
        &[
            owner.as_bytes(),
            extension_id.as_bytes(),
            module_id.as_bytes(),
            instance_id.as_bytes(),
        ],
    );
    format!("dolly-account-{}", &digest[..16])
}

/// The stable transport idempotency key derived from an `action_id`. Supplied
/// to transports that support idempotency keys so provider-side duplicate
/// suppression is deterministic across retries.
pub fn outbound_idempotency_key(action_id: &str) -> String {
    domain_hash(OUTBOUND_IDEMPOTENCY_PREFIX, &[action_id.as_bytes()])
}

/// A deterministic Dolly session ID for one account+conversation pair. The
/// SessionMap is Channel-owned state; this ID is stable across restarts so
/// `CreateOnFirstMessage` mapping is idempotent.
pub fn dolly_session_id(transport_account: &str, external_conversation_id: &str) -> String {
    let digest = domain_hash_raw(
        b"org.dolly.channel\0session\0",
        &[
            transport_account.as_bytes(),
            external_conversation_id.as_bytes(),
        ],
    );
    format!("dolly-session-{}", &digest[..16])
}

/// A deterministic RFC-9562-shaped UUIDv7 request identity for one logical
/// ingress submission attempt (operation_id). It is the Extension's own RPC
/// request identity — never a Core Block/Asset ID — and it is stable for the
/// same (`transport_account`, `external_message_id`, `attempt`) so a lost
/// response can be reconciled through `host.ingress.status` with the same
/// identity.
pub fn operation_id(transport_account: &str, external_message_id: &str, attempt: u64) -> String {
    let digest = domain_hash_raw(
        b"org.dolly.channel\0operation-id\0",
        &[
            transport_account.as_bytes(),
            external_message_id.as_bytes(),
            attempt.to_string().as_bytes(),
        ],
    );
    uuid_v7_shape(&digest)
}

/// Reformat a 64-hex-char SHA-256 digest into a lowercase UUIDv7-shaped
/// string: `xxxxxxxx-xxxx-7xxx-8xxx-xxxxxxxxxxxx`, forcing the version nibble
/// to `7` and the variant nibble to `8`.
fn uuid_v7_shape(hex: &str) -> String {
    // Use the first 32 hex digits (16 bytes) so the formatted result is a
    // canonical 36-character UUIDv7-shaped string.
    let b: Vec<u8> = hex.as_bytes().to_vec();
    let mut out: Vec<u8> = Vec::with_capacity(36);
    for (i, &c) in b.iter().take(32).enumerate() {
        out.push(c);
        if matches!(i, 7 | 11 | 15 | 19) {
            out.push(b'-');
        }
    }
    // Force the RFC-9562 version and variant nibbles at their UUID output
    // positions (14 and 19), independent of the input hex layout.
    out[14] = b'7';
    out[19] = b'8';
    String::from_utf8(out).expect("uuid shape is ASCII")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_scopes_ingress_keys() {
        let a = inbound_ingress_key("account-a", "msg-1");
        let b = inbound_ingress_key("account-b", "msg-1");
        assert_ne!(a, b);
        // Deterministic across calls.
        assert_eq!(a, inbound_ingress_key("account-a", "msg-1"));
    }

    #[test]
    fn operation_digest_binds_exact_bytes() {
        let d1 = operation_digest(b"{\"x\":1}");
        let d2 = operation_digest(b"{\"x\":1}");
        let d3 = operation_digest(b"{\"x\": 1}");
        assert_eq!(d1, d2);
        assert_ne!(d1, d3);
    }

    #[test]
    fn channel_account_is_principal_bound_and_deterministic() {
        let a = channel_account("owner-1", "org.dolly.channel", "receiver", "worker-1");
        assert!(a.starts_with("dolly-account-"));
        assert_eq!(a, channel_account("owner-1", "org.dolly.channel", "receiver", "worker-1"));
        assert_ne!(a, channel_account("owner-2", "org.dolly.channel", "receiver", "worker-1"));
        assert_ne!(a, channel_account("owner-1", "org.dolly.channel", "receiver", "worker-2"));
    }

    #[test]
    fn outbound_idempotency_key_is_stable_per_action() {
        assert_eq!(
            outbound_idempotency_key("0198ab31-6c44-7e8a-b2bb-000000000091"),
            outbound_idempotency_key("0198ab31-6c44-7e8a-b2bb-000000000091")
        );
        assert_ne!(
            outbound_idempotency_key("0198ab31-6c44-7e8a-b2bb-000000000091"),
            outbound_idempotency_key("0198ab31-6c44-7e8a-b2bb-000000000092")
        );
    }

    #[test]
    fn operation_id_is_uuidv7_shaped_and_attempt_scoped() {
        let a1 = operation_id("account-a", "msg-1", 1);
        let b = a1.as_bytes();
        assert_eq!(b.len(), 36);
        assert_eq!(b[8], b'-');
        assert_eq!(b[13], b'-');
        assert_eq!(b[18], b'-');
        assert_eq!(b[23], b'-');
        assert_eq!(b[14], b'7');
        assert!(matches!(b[19], b'8' | b'9' | b'a' | b'b'));
        assert!(a1.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
        assert_eq!(operation_id("account-a", "msg-1", 1), a1);
        assert_ne!(operation_id("account-a", "msg-1", 2), a1);
    }

    #[test]
    fn session_id_is_stable_and_bound_to_account() {
        assert_eq!(
            dolly_session_id("account-a", "conv-1"),
            dolly_session_id("account-a", "conv-1")
        );
        assert_ne!(
            dolly_session_id("account-a", "conv-1"),
            dolly_session_id("account-b", "conv-1")
        );
        assert!(dolly_session_id("account-a", "conv-1").starts_with("dolly-session-"));
    }
}
