//! Focused WP-010 conformance tests: bounded import to a durable
//! `AVAILABLE`/`AssetRef`, refusal of invalid and over-limit sources with no
//! partial authority, idempotent replay, deterministic crash-recovery
//! controls, lease/GC ownership, and security-domain isolation.

use dolly_asset::clock::{Clock, ClockTime};
use dolly_asset::config::{ReplicaConfig, ResolvedAssetConfig};
use dolly_asset::error::{AssetErrorCode, ErrorPhase};
use dolly_asset::identity::{AssetId, AssetRef, ContentHash};
use dolly_asset::prepare::{MediaPrepareRequest, PrepareFailpoint};
use dolly_asset::record::{
    AssetRecord, ImportRequest, ImportState, Lifecycle, LocalState, MediaKind, Source,
};
use dolly_asset::remote::DeniedFetcher;
use dolly_asset::replica::{DisabledReplica, InMemoryReplica};
use dolly_asset::service::AssetService;
use dolly_asset::store::AssetStore;
use dolly_asset::{AssetCapability, ReplicaState};
use parking_lot::Mutex;
use std::fs;
use std::sync::Arc;

const T0: u64 = 1_800_000_000_000;

/// A shared, advanceable clock so tests drive expiry and grace deterministically.
#[derive(Clone)]
struct TestClock {
    millis: Arc<Mutex<u64>>,
}

impl TestClock {
    fn new(millis: u64) -> Self {
        Self {
            millis: Arc::new(Mutex::new(millis)),
        }
    }

    fn advance(&self, delta: u64) {
        *self.millis.lock() += delta;
    }
}

impl Clock for TestClock {
    fn now(&mut self) -> ClockTime {
        let millis = *self.millis.lock();
        ClockTime::new(millis)
    }
}

fn import_id(n: u64) -> String {
    // Valid UUIDv7 with the RFC variant bit set.
    format!("0198ab31-6c44-7e8a-b2bb-{n:012}")
}

fn deadline() -> String {
    "2026-08-09T15:00:00.000000Z".to_string()
}

/// A minimal byte sequence that sniffs as a WxH PNG (signature + IHDR + pad).
fn png_bytes(w: u32, h: u32) -> Vec<u8> {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    bytes.extend_from_slice(&[0, 0, 0, 13]);
    bytes.extend_from_slice(b"IHDR");
    bytes.extend_from_slice(&w.to_be_bytes());
    bytes.extend_from_slice(&h.to_be_bytes());
    bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
    bytes.extend_from_slice(&[0u8; 24]); // tail junk; the sniffer reads only the head
    bytes
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64(bytes: &[u8]) -> String {
    let mut out = String::new();
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &b in bytes {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= 6 {
            bits -= 6;
            out.push(B64[((acc >> bits) & 0x3f) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(B64[((acc << (6 - bits)) & 0x3f) as usize] as char);
    }
    while out.len() % 4 != 0 {
        out.push('=');
    }
    let _ = dolly_asset::source::strict_base64_decoded_len(&out)
        .expect("round-trip encoding is canonical");
    out
}

fn request(id: u64, kind: Source, declared: Option<&str>, remote_required: bool) -> ImportRequest {
    ImportRequest {
        import_id: import_id(id),
        instance_id: "instance-a".to_string(),
        module_id: "module-a".to_string(),
        activation_id: None,
        lease_token: None,
        media_kind: MediaKind::Image,
        source: kind,
        declared_media_type: declared.map(|m| m.parse().unwrap()),
        remote_required,
        expected_byte_length: None,
        deadline: deadline(),
    }
}

fn config_at(dir: &std::path::Path) -> ResolvedAssetConfig {
    let mut config = ResolvedAssetConfig::with_local_root(dir.to_path_buf());
    config.max_decoded_bytes = 64 * 1024;
    config.max_inline_base64_chars = 128 * 1024;
    config.max_image_pixels = 1_000_000;
    config.gc_grace_ms = 60_000;
    config
}

fn service_at(dir: &std::path::Path, clock: TestClock) -> (AssetService, TestClock) {
    let service = AssetService::open_with(
        config_at(dir),
        clock.clone(),
        DeniedFetcher,
        DisabledReplica::new("assets"),
    )
    .expect("service opens");
    (service, clock)
}

fn cap(service: &AssetService) -> AssetCapability {
    service.issue_capability("personal", "instance-a", "module-a")
}

// ---------------------------------------------------------------------------
// 1. Bounded import -> AVAILABLE / AssetRef
// ---------------------------------------------------------------------------

#[test]
fn bounded_inline_import_reaches_available_with_canonical_asset_ref() {
    let dir = tempfile::tempdir().unwrap();
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    let capability = cap(&service);

    let png = png_bytes(4, 2);
    let result = service
        .import(
            &capability,
            &request(
                401,
                Source::InlineBase64 {
                    base64: base64(&png),
                },
                Some("image/png"),
                false,
            ),
        )
        .expect("import succeeds");

    assert_eq!(result.state, "available");
    assert!(result.terminal);
    assert!(result.error.is_none());

    let asset = result.asset.as_ref().expect("AssetRef present");
    assert_eq!(asset.byte_length, png.len() as u64);
    assert_eq!(asset.media_type.as_str(), "image/png");
    assert_eq!(asset.encoded_width, Some(4));
    assert_eq!(asset.encoded_height, Some(2));

    // Canonical identity: ast_b3_ + lowercase unpadded base32 of blake3.
    let expected_hash = ContentHash::of_bytes(&png);
    let expected_id = AssetId::from_digest(expected_hash.digest);
    assert_eq!(asset.asset_id, expected_id);
    assert!(asset.asset_id.as_str().starts_with("ast_b3_"));

    // The downstream-safe read grant returns exactly the accepted bytes.
    let mut grant = service
        .read(&capability, asset.asset_id.as_str())
        .expect("domain read");
    assert_eq!(grant.byte_length(), png.len() as u64);
    let mut out = Vec::new();
    let mut buf = [0u8; 7];
    loop {
        let n = grant.read_bounded(&mut buf).unwrap();
        if n == 0 {
            break;
        }
        out.extend_from_slice(&buf[..n]);
    }
    assert_eq!(out, png);
}

#[test]
fn identical_bytes_deduplicate_to_one_asset_id_and_object() {
    let dir = tempfile::tempdir().unwrap();
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    let capability = cap(&service);
    let png = png_bytes(4, 2);
    let encoded = base64(&png);

    let first = service
        .import(
            &capability,
            &request(401, Source::InlineBase64 { base64: encoded.clone() }, Some("image/png"), false),
        )
        .unwrap();
    let second = service
        .import(
            &capability,
            &request(402, Source::InlineBase64 { base64: encoded }, Some("image/png"), false),
        )
        .unwrap();

    let id1 = first.asset.unwrap().asset_id;
    let id2 = second.asset.unwrap().asset_id;
    assert_eq!(id1, id2);
    assert!(dir.path().join("objects").join(id1.as_str()).exists());
}

#[test]
fn replay_of_identical_import_id_is_idempotent_and_conflict_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    let capability = cap(&service);
    let png = png_bytes(4, 2);

    let first = service
        .import(
            &capability,
            &request(410, Source::InlineBase64 { base64: base64(&png) }, Some("image/png"), false),
        )
        .unwrap();
    let replay = service
        .import(
            &capability,
            &request(410, Source::InlineBase64 { base64: base64(&png) }, Some("image/png"), false),
        )
        .unwrap();
    assert_eq!(replay.state, "available");
    assert_eq!(replay, first);

    let different = request(
        410,
        Source::InlineBase64 {
            base64: base64(&png_bytes(8, 8)),
        },
        Some("image/png"),
        false,
    );
    let err = service.import(&capability, &different).unwrap_err();
    assert_eq!(err.code, AssetErrorCode::ImportIdConflict);
    assert_eq!(err.phase, ErrorPhase::Validate);
}

// ---------------------------------------------------------------------------
// 2. Refusal of invalid / untrusted / over-limit sources
// ---------------------------------------------------------------------------

#[test]
fn invalid_base64_is_refused_before_any_durable_record() {
    let dir = tempfile::tempdir().unwrap();
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    let capability = cap(&service);

    for bad in [
        "aGVsbG8!",
        "aGVsbG8===",
        "aGVs=bG8=",
        "not base64 at all!!",
    ] {
        let err = service
            .import(
                &capability,
                &request(
                    411,
                    Source::InlineBase64 {
                        base64: bad.to_string(),
                    },
                    Some("image/png"),
                    false,
                ),
            )
            .unwrap_err();
        assert_eq!(err.code, AssetErrorCode::InvalidBase64, "for {bad}");
    }
    assert_eq!(service.store_import_count(), 0, "no partial authority left behind");
}

#[test]
fn over_limit_source_is_cut_off_and_rejected_without_an_asset() {
    let dir = tempfile::tempdir().unwrap();
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    let capability = cap(&service);
    let mut big = png_bytes(4, 2);
    big.resize(200 * 1024, 0); // exceeds the 64 KiB decoded/config bound

    let result = service
        .import(
            &capability,
            &request(412, Source::InlineBase64 { base64: base64(&big) }, Some("image/png"), false),
        )
        .unwrap();
    assert_eq!(result.state, "rejected");
    assert!(result.terminal);
    assert!(result.asset.is_none());
    let error = result.error.as_ref().expect("rejection carries the envelope");
    assert_eq!(error["code"], "SIZE_LIMIT");
    let staging = dir.path().join("staging");
    let leftovers: usize = std::fs::read_dir(&staging).map(|d| d.count()).unwrap_or(0);
    assert_eq!(leftovers, 0, "staging bytes are scheduled for deletion");
}

#[test]
fn declared_media_mismatch_is_rejected_and_active_content_is_not_relabeled() {
    let dir = tempfile::tempdir().unwrap();
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    let capability = cap(&service);

    let png = png_bytes(4, 2);
    let result = service
        .import(
            &capability,
            &request(413, Source::InlineBase64 { base64: base64(&png) }, Some("image/jpeg"), false),
        )
        .unwrap();
    assert_eq!(result.state, "rejected");
    assert_eq!(result.error.as_ref().unwrap()["code"], "MEDIA_TYPE_MISMATCH");

    let svg = b"<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\"/>";
    let result = service
        .import(
            &capability,
            &request(414, Source::InlineBase64 { base64: base64(svg) }, Some("image/png"), false),
        )
        .unwrap();
    assert_eq!(result.state, "rejected");
    assert_eq!(result.error.as_ref().unwrap()["code"], "MEDIA_TYPE_MISMATCH");
}

#[test]
fn remote_url_import_fails_closed_without_a_host_transport() {
    let dir = tempfile::tempdir().unwrap();
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    let capability = cap(&service);

    let result = service
        .import(
            &capability,
            &request(
                415,
                Source::RemoteUrl {
                    url: "https://example.com/a.png".to_string(),
                    max_bytes: 1024,
                },
                Some("image/png"),
                false,
            ),
        )
        .unwrap();
    assert_eq!(result.state, "rejected");
    assert_eq!(result.error.as_ref().unwrap()["code"], "SOURCE_UNAVAILABLE");

    let err = service
        .import(
            &capability,
            &request(
                416,
                Source::RemoteUrl {
                    url: "https://user:pass@example.com/a.png".to_string(),
                    max_bytes: 1024,
                },
                Some("image/png"),
                false,
            ),
        )
        .unwrap_err();
    assert_eq!(err.code, AssetErrorCode::SourceDenied);
    assert_eq!(err.phase, ErrorPhase::Validate);
}

#[test]
fn remote_required_without_replica_fails_before_acquisition() {
    let dir = tempfile::tempdir().unwrap();
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    let capability = cap(&service);
    let png = png_bytes(4, 2);

    let err = service
        .import(
            &capability,
            &request(
                417,
                Source::InlineBase64 {
                    base64: base64(&png),
                },
                Some("image/png"),
                true,
            ),
        )
        .unwrap_err();
    assert_eq!(err.code, AssetErrorCode::RemoteReplicaFailed);
    assert_eq!(err.phase, ErrorPhase::Validate);
    assert_eq!(service.store_import_count(), 0);
}

#[test]
fn remote_required_with_replica_never_exposes_unverified_replica() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = config_at(dir.path());
    config.replica = ReplicaConfig {
        enabled: true,
        endpoint: Some("https://oss.example".to_string()),
        bucket: Some("dolly".to_string()),
        prefix: Some("assets".to_string()),
        credential_ref: Some("k8s://dolly/oss".to_string()),
    };
    let mut replica = InMemoryReplica::new("assets", "dolly", "dolly-bucket");
    replica.fail_uploads = true;
    let mut service = AssetService::open_with(config, TestClock::new(T0), DeniedFetcher, replica)
        .unwrap();
    let capability = cap(&service);
    let png = png_bytes(4, 2);

    let result = service
        .import(
            &capability,
            &request(
                418,
                Source::InlineBase64 {
                    base64: base64(&png),
                },
                Some("image/png"),
                true,
            ),
        )
        .unwrap();
    assert_eq!(result.state, "replica_failed");
    assert!(!result.terminal);
    assert!(result.asset.is_none());
    let error = result.error.as_ref().expect("replica failure recorded");
    assert_eq!(error["code"], "REMOTE_REPLICA_FAILED");
}

#[test]
fn remote_required_with_working_replica_reaches_available_only_after_verify() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = config_at(dir.path());
    config.replica = ReplicaConfig {
        enabled: true,
        endpoint: Some("https://oss.example".to_string()),
        bucket: Some("dolly".to_string()),
        prefix: Some("assets".to_string()),
        credential_ref: Some("k8s://dolly/oss".to_string()),
    };
    let replica = InMemoryReplica::new("assets", "dolly", "dolly-bucket");
    let mut service = AssetService::open_with(config, TestClock::new(T0), DeniedFetcher, replica)
        .unwrap();
    let capability = cap(&service);
    let png = png_bytes(4, 2);

    let result = service
        .import(
            &capability,
            &request(
                419,
                Source::InlineBase64 {
                    base64: base64(&png),
                },
                Some("image/png"),
                true,
            ),
        )
        .unwrap();
    assert_eq!(result.state, "available");
    assert!(result.asset.is_some());
    let asset = result.asset.as_ref().unwrap();
    // The replica row must verify with the same content hash before release.
    assert_eq!(
        asset.asset_id,
        AssetId::from_digest(ContentHash::of_bytes(&png).digest)
    );
}

// ---------------------------------------------------------------------------
// 3. Crash / recovery / ownership controls
// ---------------------------------------------------------------------------

#[test]
fn illegal_state_transition_is_refused_by_cas() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = dolly_asset::AssetStore::open(&dir.path().join("db.sqlite")).unwrap();
    let tx = store.transaction().unwrap();
    let time = dolly_asset::ClockTime::new(T0);
    let err = tx
        .cas_import(
            &import_id(101),
            ImportState::Accepted,
            ImportState::Committing,
            &dolly_asset::store::ImportPatch::default(),
            time.clone(),
        )
        .err()
        .expect("Accepted -> Committing is illegal");
    assert!(matches!(
        err,
        dolly_asset::StoreError::IllegalTransition { .. }
    ));
    let err = tx
        .cas_import(
            &import_id(101),
            ImportState::Available,
            ImportState::Accepted,
            &dolly_asset::store::ImportPatch::default(),
            time,
        )
        .err()
        .expect("terminal states leave the machine");
    assert!(matches!(
        err,
        dolly_asset::StoreError::IllegalTransition { .. }
    ));
}

#[test]
fn committing_recovery_completes_when_object_verifies_and_resets_when_not() {
    // Present object -> COMMITTING resolves to AVAILABLE after recovery.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    std::fs::create_dir_all(root.join("objects")).unwrap();
    let png = png_bytes(4, 2);
    let hash = ContentHash::of_bytes(&png);
    let asset_id = AssetId::from_digest(hash.digest);
    std::fs::write(root.join("objects").join(asset_id.as_str()), &png).unwrap();

    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    let capability = cap(&service);
    seed_committing_import(&mut service, 420, &png, &hash, &asset_id);
    let report = service.recover().unwrap();
    assert_eq!(report.resolved_committing, 1);
    let status = service.status(&capability, &import_id(420)).unwrap();
    assert_eq!(status.state, "available");
    assert!(status.asset.is_some());

    // Missing object -> COMMITTING resets to ACCEPTED, never AVAILABLE.
    let dir2 = tempfile::tempdir().unwrap();
    let (mut service2, _clock2) = service_at(dir2.path(), TestClock::new(T0));
    let capability2 = cap(&service2);
    seed_committing_import(&mut service2, 421, &png, &hash, &asset_id);
    let report = service2.recover().unwrap();
    assert_eq!(report.resolved_committing, 1);
    let status = service2.status(&capability2, &import_id(421)).unwrap();
    assert_eq!(status.state, "accepted");
}

#[test]
fn acquiring_recovery_restarts_from_accepted_when_staging_is_incomplete() {
    let dir = tempfile::tempdir().unwrap();
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    seed_import_in_state(&mut service, 422, ImportState::Acquiring, None, None);
    let report = service.recover().unwrap();
    assert_eq!(report.resumed_from_partial, 1);
    let status = service.status(&cap(&service), &import_id(422)).unwrap();
    assert_eq!(status.state, "accepted");
}

#[test]
fn verifying_recovery_keeps_a_complete_verified_staging_object() {
    let dir = tempfile::tempdir().unwrap();
    let png = png_bytes(4, 2);
    let hash = ContentHash::of_bytes(&png);
    // Write the staging object exactly as a completed acquisition would.
    std::fs::create_dir_all(dir.path().join("staging")).unwrap();
    let staging_name = format!("staging-{}", import_id(423));
    std::fs::write(dir.path().join("staging").join(&staging_name), &png).unwrap();
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    seed_import_in_state(
        &mut service,
        423,
        ImportState::Verifying,
        Some((png.len() as u64, hash.digest_hex())),
        None,
    );
    let report = service.recover().unwrap();
    assert_eq!(report.kept_verified, 1);
    let status = service.status(&cap(&service), &import_id(423)).unwrap();
    assert_eq!(status.state, "verifying");
}

#[test]
fn lease_ownership_blocks_gc_and_tombstone_blocks_new_leases() {
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::new(T0);
    let (mut service, clock) = service_at(dir.path(), clock);
    let capability = cap(&service);
    let png = png_bytes(4, 2);
    let available = service
        .import(
            &capability,
            &request(430, Source::InlineBase64 { base64: base64(&png) }, Some("image/png"), false),
        )
        .unwrap();
    let asset_ref = available.asset.clone().unwrap();
    let asset_id = asset_ref.asset_id.as_str().to_string();

    let lease = service
        .lease(&capability, &asset_id, "model-op-1", "provider output", 240_000)
        .unwrap();
    assert!(lease.lease_id.len() >= 32);
    assert!(lease.expires_at > lease.created_at);

    clock.advance(120_000);
    let gc = service.run_gc().unwrap();
    assert_eq!(gc.tombstones_created, 0, "live lease must block GC");

    assert!(service.release_lease(&lease.lease_id).unwrap());
    clock.advance(120_000);
    let gc = service.run_gc().unwrap();
    assert_eq!(gc.tombstones_created, 1);
    assert!(!dir.path().join("objects").join(&asset_id).exists());

    let err = service
        .lease(&capability, &asset_id, "model-op-2", "late lease", 1000)
        .unwrap_err();
    assert_eq!(err.code, AssetErrorCode::NotFound);
}

#[test]
fn pin_without_expiry_requires_privilege_and_blocks_gc() {
    let dir = tempfile::tempdir().unwrap();
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    let capability = cap(&service);
    let png = png_bytes(4, 2);
    let available = service
        .import(
            &capability,
            &request(431, Source::InlineBase64 { base64: base64(&png) }, Some("image/png"), false),
        )
        .unwrap();
    let asset_id = available.asset.unwrap().asset_id.as_str().to_string();

    let err = service
        .pin(&capability, &asset_id, "ops", "keep", None, false)
        .unwrap_err();
    assert_eq!(err.code, AssetErrorCode::Unauthorized);

    service
        .pin(&capability, &asset_id, "ops", "keep", None, true)
        .unwrap();
    let gc = service.run_gc().unwrap();
    assert_eq!(gc.tombstones_created, 0);
}

#[test]
fn durable_reference_racing_tombstone_never_wins() {
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::new(T0);
    let (mut service, clock) = service_at(dir.path(), clock);
    let capability = cap(&service);
    let png = png_bytes(4, 2);
    let available = service
        .import(
            &capability,
            &request(432, Source::InlineBase64 { base64: base64(&png) }, Some("image/png"), false),
        )
        .unwrap();
    let asset_id = available.asset.unwrap().asset_id.as_str().to_string();

    let reference = service
        .create_reference(&capability, &asset_id, "block:b1", "block:b1")
        .unwrap();
    assert_eq!(reference.ref_key, "block:b1");
    clock.advance(120_000);
    let gc = service.run_gc().unwrap();
    assert_eq!(gc.tombstones_created, 0, "durable reference blocks GC");

    service
        .remove_reference(&capability, &asset_id, reference.generation, "block:b1")
        .unwrap();
    clock.advance(120_000);
    let gc = service.run_gc().unwrap();
    assert_eq!(gc.tombstones_created, 1);

    let err = service
        .create_reference(&capability, &asset_id, "block:b2", "block:b2")
        .unwrap_err();
    assert!(matches!(
        err.code,
        AssetErrorCode::NotFound | AssetErrorCode::Tombstoned
    ));
}

#[test]
fn security_domain_isolation_keeps_identical_bytes_apart() {
    let dir = tempfile::tempdir().unwrap();
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    let domain_a = service.issue_capability("work", "instance-a", "module-a");
    let domain_b = service.issue_capability("personal", "instance-a", "module-a");
    let png = png_bytes(4, 2);

    let a = service
        .import(
            &domain_a,
            &request(433, Source::InlineBase64 { base64: base64(&png) }, Some("image/png"), false),
        )
        .unwrap();
    let b = service
        .import(
            &domain_b,
            &request(434, Source::InlineBase64 { base64: base64(&png) }, Some("image/png"), false),
        )
        .unwrap();

    let asset_a = a.asset.unwrap();
    let asset_b = b.asset.unwrap();
    assert_eq!(asset_a.asset_id, asset_b.asset_id);
    assert_eq!(
        asset_a.asset_id,
        AssetId::from_digest(ContentHash::of_bytes(&png).digest)
    );

    // A domain that never imported the bytes must NOT read them, even
    // though a hash match exists in another domain.
    assert!(service.read(&domain_a, asset_a.asset_id.as_str()).is_ok());
    let uninvolved = service.issue_capability("other", "instance-a", "module-a");
    match service.read(&uninvolved, asset_a.asset_id.as_str()) {
        Ok(_) => panic!("a domain that never imported the bytes must not read them"),
        Err(e) => assert_eq!(e.code, AssetErrorCode::NotFound),
    }

    // GC must not delete the object shared by the other domain's live row.
    let gc = service.run_gc().unwrap();
    assert_eq!(gc.tombstones_created, 0, "shared object is retained");
    assert!(dir.path().join("objects").join(asset_a.asset_id.as_str()).exists());
}

// ---------------------------------------------------------------------------
// Seed helpers (direct durable-store controls)
// ---------------------------------------------------------------------------

fn seed_committing_import(
    service: &mut AssetService,
    id: u64,
    png: &[u8],
    hash: &ContentHash,
    asset_id: &AssetId,
) {
    seed_record(service, id, ImportState::Committing, Some((png.len() as u64, hash.digest_hex())), Some(asset_id.as_str()));
}

fn seed_import_in_state(
    service: &mut AssetService,
    id: u64,
    state: ImportState,
    staging: Option<(u64, String)>,
    asset_id: Option<&str>,
) {
    seed_record(service, id, state, staging, asset_id);
}

fn seed_record(
    service: &mut AssetService,
    id: u64,
    state: ImportState,
    staging: Option<(u64, String)>,
    asset_id: Option<&str>,
) {
    let config = service.config_ro().clone();
    let staging_bytes = staging.as_ref().map(|(len, _)| *len);
    let staging_hash = staging.as_ref().map(|(_, h)| h.clone());
    let record = dolly_asset::ImportRecord {
        import_id: import_id(id),
        instance_id: "instance-a".to_string(),
        module_id: "module-a".to_string(),
        security_domain: "personal".to_string(),
        state,
        params_digest: "x".to_string(),
        media_kind: "image".to_string(),
        source_kind: "inline_base64".to_string(),
        source_json: "{}".to_string(),
        declared_media_type: Some("image/png".to_string()),
        expected_byte_length: None,
        remote_required: false,
        deadline: deadline(),
        max_bytes: config.max_decoded_bytes,
        asset_id: asset_id.map(|s| s.to_string()),
        detected_media_type: Some("image/png".to_string()),
        byte_length: staging_bytes,
        encoded_width: Some(4),
        encoded_height: Some(2),
        orientation: Some(1),
        staging_bytes,
        staging_hash,
        error_code: None,
        error_message: None,
        error_retryable: None,
        error_outcome: None,
        error_details_json: None,
        replica_state: ReplicaState::Disabled,
        replica_attempt: 0,
        retry_at_ms: None,
        created_at: "2026-08-09T15:00:00.000000Z".to_string(),
        updated_at: "2026-08-09T15:00:00.000000Z".to_string(),
        updated_at_ms: T0,
    };
    let tx = service.store_transaction().unwrap();
    assert!(tx.insert_import_if_absent(&record).unwrap());
    tx.commit().unwrap();
}

// ---------------------------------------------------------------------------
// 9. Asset Host import/status façade: closed absent, exact owner binding,
//    Host-lifecycle fencing, and canonical wire round-trips.
// ---------------------------------------------------------------------------

#[test]
fn status_of_unknown_import_id_is_closed_absent_never_a_lifecycle_state() {
    let dir = tempfile::tempdir().unwrap();
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    let capability = cap(&service);

    // Unknown ImportId -> closed absent, not an error, not a lifecycle state.
    let status = service.status(&capability, &import_id(501)).unwrap();
    assert_eq!(status.state, "absent");
    assert!(!status.terminal);
    assert!(status.asset.is_none(), "absent must never mint an AssetRef");
    assert!(status.error.is_none());
    assert_eq!(status.import_id, import_id(501));

    // The absent wire form must not collide with any recorded state name.
    assert_ne!(status.state, "accepted");
    assert_ne!(status.state, "available");
    assert_ne!(status.state, "rejected");
    assert_ne!(status.state, "cancelled");

    // A status result for a real import is authoritative and never absent.
    let png = png_bytes(4, 2);
    service
        .import(
            &capability,
            &request(502, Source::InlineBase64 { base64: base64(&png) }, Some("image/png"), false),
        )
        .unwrap();
    assert_eq!(service.status(&capability, &import_id(502)).unwrap().state, "available");

    // Re-serializing the absent result round-trips the closed wire form.
    let json = serde_json::to_string(&status).unwrap();
    let back: dolly_asset::StatusResult = serde_json::from_str(&json).unwrap();
    assert_eq!(back, status);
    assert_eq!(back.state, "absent");
    assert!(back.asset.is_none());
}

#[test]
fn status_binds_instance_module_and_domain_and_is_non_disclosing() {
    let dir = tempfile::tempdir().unwrap();
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    let png = png_bytes(4, 2);
    let result = service
        .import(
            &cap(&service),
            &request(503, Source::InlineBase64 { base64: base64(&png) }, Some("image/png"), false),
        )
        .unwrap();
    assert_eq!(result.state, "available");
    let owner_status = service.status(&cap(&service), &import_id(503)).unwrap();
    assert_eq!(owner_status.state, "available");
    assert_eq!(owner_status.asset, result.asset, "owner status returns the same canonical AssetRef");

    // Same domain and instance, different module: indistinguishable absent.
    let other_module = service.issue_capability("personal", "instance-a", "module-b");
    let s = service.status(&other_module, &import_id(503)).unwrap();
    assert_eq!(s.state, "absent", "cross-module status must not disclose the record");
    assert!(s.asset.is_none());

    // Same domain and module, different instance: indistinguishable absent.
    let other_instance = service.issue_capability("personal", "instance-b", "module-a");
    let s = service.status(&other_instance, &import_id(503)).unwrap();
    assert_eq!(s.state, "absent", "cross-instance status must not disclose the record");
    assert!(s.asset.is_none());

    // Different security domain: indistinguishable absent.
    let other_domain = service.issue_capability("work", "instance-a", "module-a");
    let s = service.status(&other_domain, &import_id(503)).unwrap();
    assert_eq!(s.state, "absent", "cross-domain status must not disclose the record");
    assert!(s.asset.is_none());

    // The owner can still read its own record afterwards.
    assert_eq!(service.status(&cap(&service), &import_id(503)).unwrap().state, "available");
}

#[test]
fn cancel_binds_owner_and_cross_owner_cancel_never_mutates() {
    let dir = tempfile::tempdir().unwrap();
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    seed_record(&mut service, 504, ImportState::Accepted, None, None);

    // Cross-module and cross-instance cancel are refused before mutation.
    let other_module = service.issue_capability("personal", "instance-a", "module-b");
    let err = service.cancel(&other_module, &import_id(504)).unwrap_err();
    assert_eq!(err.code, AssetErrorCode::NotFound);
    let other_instance = service.issue_capability("personal", "instance-b", "module-a");
    let err = service.cancel(&other_instance, &import_id(504)).unwrap_err();
    assert_eq!(err.code, AssetErrorCode::NotFound);
    let other_domain = service.issue_capability("work", "instance-a", "module-a");
    let err = service.cancel(&other_domain, &import_id(504)).unwrap_err();
    assert_eq!(err.code, AssetErrorCode::NotFound);

    // The record is untouched: still accepted for the owner.
    let status = service.status(&cap(&service), &import_id(504)).unwrap();
    assert_eq!(status.state, "accepted", "denied cancellation must not mutate the record");

    // The owner may cancel.
    let cancelled = service.cancel(&cap(&service), &import_id(504)).unwrap();
    assert_eq!(cancelled.state, "cancelled");
}

#[test]
fn stale_capability_from_another_service_instance_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let (mut first, _clock) = service_at(dir.path(), TestClock::new(T0));
    let png = png_bytes(4, 2);
    first
        .import(
            &cap(&first),
            &request(505, Source::InlineBase64 { base64: base64(&png) }, Some("image/png"), false),
        )
        .unwrap();
    let stale = cap(&first);

    // A fresh service over the same durable store is a new Host lifecycle.
    let (mut second, _clock) = service_at(dir.path(), TestClock::new(T0));
    let err = second.status(&stale, &import_id(505)).unwrap_err();
    assert_eq!(err.code, AssetErrorCode::Unauthorized, "stale capability status refused");
    let err = second.cancel(&stale, &import_id(505)).unwrap_err();
    assert_eq!(err.code, AssetErrorCode::Unauthorized, "stale capability cancel refused");
    let err = second
        .import(
            &stale,
            &request(506, Source::InlineBase64 { base64: base64(&png) }, Some("image/png"), false),
        )
        .unwrap_err();
    assert_eq!(err.code, AssetErrorCode::Unauthorized, "stale capability import refused");
    assert_eq!(second.store_import_count(), 1, "denied import leaves no partial record");

    // The current lifecycle's own capability still sees the durable record.
    let fresh = cap(&second);
    let status = second.status(&fresh, &import_id(505)).unwrap();
    assert_eq!(status.state, "available", "durable record survives across service instances");
}

#[test]
fn import_authz_binds_module_and_instance_before_any_durable_write() {
    let dir = tempfile::tempdir().unwrap();
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    let png = png_bytes(4, 2);

    let wrong_module = service.issue_capability("personal", "instance-a", "module-b");
    let mut r = request(507, Source::InlineBase64 { base64: base64(&png) }, Some("image/png"), false);
    r.module_id = "module-a".to_string();
    let err = service.import(&wrong_module, &r).unwrap_err();
    assert_eq!(err.code, AssetErrorCode::Unauthorized);

    let wrong_instance = service.issue_capability("personal", "instance-b", "module-a");
    let mut r = request(508, Source::InlineBase64 { base64: base64(&png) }, Some("image/png"), false);
    r.instance_id = "instance-a".to_string();
    let err = service.import(&wrong_instance, &r).unwrap_err();
    assert_eq!(err.code, AssetErrorCode::Unauthorized);

    // The request carries no domain; the capability's domain is authoritative
    // and the request is unaffected by it. Only module/instance mismatches
    // are denied by the capability.
    assert_eq!(
        service.store_import_count(),
        0,
        "denied imports leave no partial authority"
    );
}

#[test]
fn canonical_asset_ref_wire_round_trips_and_forged_forms_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    let capability = cap(&service);
    let png = png_bytes(4, 2);
    let result = service
        .import(
            &capability,
            &request(510, Source::InlineBase64 { base64: base64(&png) }, Some("image/png"), false),
        )
        .unwrap();
    let asset = result.asset.unwrap();

    // Canonical round-trip.
    let json = serde_json::to_string(&asset).unwrap();
    let back: AssetRef = serde_json::from_str(&json).unwrap();
    assert_eq!(back, asset);
    assert_eq!(back.asset_id, asset.asset_id);
    assert_eq!(back.byte_length, png.len() as u64);
    assert_eq!(back.encoded_width, Some(4));
    assert_eq!(back.encoded_height, Some(2));
    assert_eq!(back.orientation, Some(1));

    let value = serde_json::to_value(&asset).unwrap();
    let mut obj = value.as_object().unwrap().clone();

    // Oversized byte length is a forged form and must be rejected.
    let mut oversize = obj.clone();
    oversize.insert("byte_length".into(), 9_007_199_254_740_992u64.into());
    assert!(serde_json::from_value::<AssetRef>(oversize.into()).is_err());

    // Orientation out of the 1..=8 range is a forged form.
    for bad in [0u8, 9, 200] {
        let mut forged = obj.clone();
        forged.insert("orientation".into(), bad.into());
        assert!(
            serde_json::from_value::<AssetRef>(forged.into()).is_err(),
            "orientation {bad} must be rejected"
        );
    }

    // Zero or oversized dimensions are forged.
    let mut zero_width = obj.clone();
    zero_width.insert("encoded_width".into(), 0u64.into());
    assert!(serde_json::from_value::<AssetRef>(zero_width.into()).is_err());
    let mut huge_display = obj.clone();
    huge_display.insert("display_height".into(), 9_007_199_254_740_992u64.into());
    assert!(serde_json::from_value::<AssetRef>(huge_display.into()).is_err());

    // Unknown extra fields are forged.
    let mut extra = obj.clone();
    extra.insert("forged".into(), true.into());
    assert!(serde_json::from_value::<AssetRef>(extra.into()).is_err());

    // Non-canonical AssetId text is forged.
    let mut bad_id = obj.clone();
    bad_id.insert("asset_id".into(), "ast_b3_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into());
    assert!(serde_json::from_value::<AssetRef>(bad_id.into()).is_err());
}

#[test]
fn facade_registers_import_and_status_with_closed_absent_and_envelopes() {
    use dolly_asset::facade::{AssetHostFacade, AssetStatusRequest};

    let dir = tempfile::tempdir().unwrap();
    let mut facade = AssetHostFacade::open(config_at(dir.path())).unwrap();
    let capability = facade.issue_capability("personal", "instance-a", "module-a");
    let png = png_bytes(4, 2);

    let result = facade
        .import(
            &capability,
            &request(511, Source::InlineBase64 { base64: base64(&png) }, Some("image/png"), false),
        )
        .unwrap();
    assert_eq!(result.state, "available");
    let asset_json = serde_json::to_value(result.asset.as_ref().unwrap()).unwrap();
    assert!(asset_json.get("asset_id").is_some());
    assert!(asset_json.get("media_type").is_some());
    assert!(asset_json.get("byte_length").is_some());

    // Valid status request returns the authoritative record state.
    let status_req = AssetStatusRequest::new(
        "0198ab31-6c44-7e8a-b2bb-000000000111",
        "module-a",
        "0198ab31-6c44-7e8a-b2bb-000000000511",
        "2026-08-10T01:02:03.000000Z",
    )
    .unwrap();
    let status = facade.status(&capability, &status_req).unwrap();
    assert_eq!(status.state, "available");
    assert_eq!(status.asset, result.asset);

    // Unknown ImportId -> closed absent through the façade.
    let absent_req = AssetStatusRequest::new(
        "0198ab31-6c44-7e8a-b2bb-000000000112",
        "module-a",
        "0198ab31-6c44-7e8a-b2bb-000000000599",
        "2026-08-10T01:02:03.000000Z",
    )
    .unwrap();
    let status = facade.status(&capability, &absent_req).unwrap();
    assert_eq!(status.state, "absent");
    assert!(status.asset.is_none());

    // A request naming a module other than the grant is a closed envelope.
    let mismatched = AssetStatusRequest::new(
        "0198ab31-6c44-7e8a-b2bb-000000000113",
        "module-b",
        "0198ab31-6c44-7e8a-b2bb-000000000511",
        "2026-08-10T01:02:03.000000Z",
    )
    .unwrap();
    let envelope = facade.status(&capability, &mismatched).unwrap_err();
    assert_eq!(envelope.code, "UNAUTHORIZED");
    assert_eq!(envelope.outcome, "not_applied");

    // Forged request JSON fails closed at the wire boundary.
    let forged = r#"{"operation_id":"0198ab31-6c44-7e8a-b2bb-000000000114","module_id":"module-a","import_id":"0198ab31-6c44-7e8a-b2bb-000000000511","deadline":"2026-08-10T01:02:03.000000Z","extra":1}"#;
    assert!(serde_json::from_str::<AssetStatusRequest>(forged).is_err());
    let bad_grammar = r#"{"operation_id":"not-a-uuid","module_id":"module-a","import_id":"not-a-uuid","deadline":"nope"}"#;
    assert!(serde_json::from_str::<AssetStatusRequest>(bad_grammar).is_err());

    // Registration hands back the full service for the other Host lanes.
    let mut service = facade.into_service();
    let grant = service
        .read(&capability, result.asset.as_ref().unwrap().asset_id.as_str())
        .unwrap();
    assert_eq!(grant.byte_length(), png.len() as u64);
}

// ---------------------------------------------------------------------------
// 10. Sol-round fixes: cross-owner import-ID replay non-disclosure, partial
//     staging cancellation cleanup, and the real AVAILABLE wire emission.
// ---------------------------------------------------------------------------

#[test]
fn cross_owner_import_id_replay_is_refused_without_disclosure() {
    let dir = tempfile::tempdir().unwrap();
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    let capability = cap(&service);
    let png = png_bytes(4, 2);

    // The owner imports import_id(601) to AVAILABLE.
    service
        .import(
            &capability,
            &request(601, Source::InlineBase64 { base64: base64(&png) }, Some("image/png"), false),
        )
        .unwrap();
    assert_eq!(service.store_import_count(), 1);

    // Another module in the same domain reuses the same ImportId under its
    // own identity: refused as a conflict, never disclosed as the owner's
    // record, and no second durable record is created.
    let intruder = service.issue_capability("personal", "instance-a", "module-b");
    let mut own_identity = request(
        601,
        Source::InlineBase64 { base64: base64(&png) },
        Some("image/png"),
        false,
    );
    own_identity.module_id = "module-b".to_string();
    let err = service.import(&intruder, &own_identity).unwrap_err();
    assert_eq!(
        err.code,
        AssetErrorCode::ImportIdConflict,
        "cross-owner replay must not disclose the owner's record"
    );
    assert_eq!(service.store_import_count(), 1, "conflict creates no second record");

    // An intruder forging the owner's module in the request is refused as
    // Unauthorized before any store access.
    let forged = request(
        601,
        Source::InlineBase64 { base64: base64(&png) },
        Some("image/png"),
        false,
    );
    let err = service.import(&intruder, &forged).unwrap_err();
    assert_eq!(err.code, AssetErrorCode::Unauthorized);
    assert_eq!(err.phase, ErrorPhase::Validate);

    // The owner still owns the intact AVAILABLE record.
    let status = service.status(&capability, &import_id(601)).unwrap();
    assert_eq!(status.state, "available");
    assert!(status.asset.is_some());
    assert_eq!(service.store_import_count(), 1);
}

#[test]
fn cancellation_during_partial_staging_cleans_up_and_never_mints_authority() {
    let dir = tempfile::tempdir().unwrap();
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    let capability = cap(&service);

    // A durable ACQUIRING import with a partial staging object on disk.
    let staging_name = format!("staging-{}", import_id(602));
    std::fs::create_dir_all(dir.path().join("staging")).unwrap();
    std::fs::write(dir.path().join("staging").join(&staging_name), b"partial-bytes").unwrap();
    assert!(dir.path().join("staging").join(&staging_name).exists());
    seed_import_in_state(&mut service, 602, ImportState::Acquiring, Some((13, "x".to_string())), None);

    // Cross-owner cancellation during the partial acquisition is refused and
    // the partial staging object is untouched.
    let intruder = service.issue_capability("personal", "instance-a", "module-b");
    let err = service.cancel(&intruder, &import_id(602)).unwrap_err();
    assert_eq!(err.code, AssetErrorCode::NotFound);
    assert!(
        dir.path().join("staging").join(&staging_name).exists(),
        "a denied cancel must not remove another module's staging bytes"
    );
    assert_eq!(
        service.status(&intruder, &import_id(602)).unwrap().state,
        "absent",
        "the intruder sees no record during the owner's partial acquisition"
    );

    // The owner cancels: the partial object is deleted and the import is
    // CANCELLED with no AssetRef and no partial authority.
    let cancelled = service.cancel(&capability, &import_id(602)).unwrap();
    assert_eq!(cancelled.state, "cancelled");
    assert!(cancelled.terminal);
    assert!(cancelled.asset.is_none(), "cancellation must never mint authority");
    assert!(
        !dir.path().join("staging").join(&staging_name).exists(),
        "cancelled partial staging bytes are deleted"
    );
    let status = service.status(&capability, &import_id(602)).unwrap();
    assert_eq!(status.state, "cancelled");
    assert!(status.asset.is_none());
    assert_eq!(service.store_import_count(), 1, "one durable record, zero partial state");
}

#[test]
fn real_available_emission_matches_the_authoritative_asset_object_shape() {
    let dir = tempfile::tempdir().unwrap();
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    let capability = cap(&service);
    let png = png_bytes(4, 2);

    let result = service
        .import(
            &capability,
            &request(603, Source::InlineBase64 { base64: base64(&png) }, Some("image/png"), false),
        )
        .unwrap();
    assert_eq!(result.state, "available");

    // A real AVAILABLE emission: exactly the canonical asset fields of the
    // authoritative asset-status schema object, no second wire shape.
    let json = serde_json::to_value(result.asset.as_ref().unwrap()).unwrap();
    let obj = json.as_object().unwrap();
    let mut keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
    keys.sort_unstable();
    assert!(
        keys.iter().all(|k| matches!(
            *k,
            "asset_id" | "media_type" | "byte_length" | "orientation"
                | "encoded_width" | "encoded_height" | "display_width" | "display_height"
        )),
        "AssetRef emits only the canonical asset object fields: {keys:?}"
    );
    assert!(obj.contains_key("asset_id"));
    assert!(obj.contains_key("media_type"));
    assert!(obj.contains_key("byte_length"));
    let bytes = obj["byte_length"].as_u64().unwrap();
    assert!(bytes <= AssetRef::MAX_WIRE_SAFE_INTEGER);
    assert_eq!(obj["encoded_width"].as_u64(), Some(4));
    assert_eq!(obj["encoded_height"].as_u64(), Some(2));
    assert_eq!(obj["display_width"].as_u64(), Some(4));
    assert_eq!(obj["display_height"].as_u64(), Some(2));

    // A reference carrying an explicit orientation emits all eight fields.
    let full = AssetRef {
        asset_id: AssetId::from_digest([1u8; 32]),
        media_type: "image/png".parse().unwrap(),
        byte_length: 123,
        orientation: Some(1),
        encoded_width: Some(4),
        encoded_height: Some(2),
        display_width: Some(4),
        display_height: Some(2),
    };
    let full_json = serde_json::to_value(&full).unwrap();
    let mut full_keys: Vec<&str> = full_json.as_object().unwrap().keys().map(|k| k.as_str()).collect();
    full_keys.sort_unstable();
    assert_eq!(
        full_keys,
        vec![
            "asset_id",
            "byte_length",
            "display_height",
            "display_width",
            "encoded_height",
            "encoded_width",
            "media_type",
            "orientation",
        ],
        "the authoritative wire carries the exact canonical AssetRef and image fields"
    );

    // An absent status emits the schema-required null slots.
    let absent = service.status(&capability, &import_id(999)).unwrap();
    let absent_json = serde_json::to_value(&absent).unwrap();
    assert!(absent_json.get("asset").unwrap().is_null());
    assert!(absent_json.get("error").unwrap().is_null());
}

#[test]
fn byte_identical_replay_across_domains_fails_closed_without_disclosure() {
    let dir = tempfile::tempdir().unwrap();
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    let png = png_bytes(4, 2);
    // Same module and instance, two security domains.
    let domain_a = service.issue_capability("personal", "instance-a", "module-a");
    let domain_b = service.issue_capability("work", "instance-a", "module-a");

    let first = service
        .import(
            &domain_a,
            &request(701, Source::InlineBase64 { base64: base64(&png) }, Some("image/png"), false),
        )
        .unwrap();
    assert_eq!(first.state, "available");
    assert!(first.asset.is_some());

    // Byte-identical import-ID/request replayed by the same module+instance
    // in a different security domain: must fail closed and non-disclosing.
    let replay = request(
        701,
        Source::InlineBase64 { base64: base64(&png) },
        Some("image/png"),
        false,
    );
    let err = service.import(&domain_b, &replay).unwrap_err();
    assert_eq!(
        err.code,
        AssetErrorCode::ImportIdConflict,
        "a cross-domain replay must be refused, never answered with the first domain's record"
    );
    assert_eq!(
        err.message, "ImportId is already in use",
        "the refusal is cause-neutral and reveals no ownership"
    );
    assert!(
        err.asset_id.is_none(),
        "the refusal must carry no identifier into the first domain's asset"
    );
    assert_eq!(
        service.store_import_count(),
        1,
        "the cross-domain replay must not create or mutate any record"
    );

    // The first domain's record is untouched and still authoritative.
    let status_a = service.status(&domain_a, &import_id(701)).unwrap();
    assert_eq!(status_a.state, "available");
    assert!(status_a.asset.is_some());

    // The second domain sees only the closed absent status for the same
    // import id: no AssetRef, no state, no partial authority.
    let status_b = service.status(&domain_b, &import_id(701)).unwrap();
    assert_eq!(status_b.state, "absent");
    assert!(status_b.asset.is_none());
    assert_eq!(service.store_import_count(), 1);
}

#[test]
fn facade_end_to_end_available_emission_is_live() {
    use dolly_asset::facade::AssetHostFacade;

    let dir = tempfile::tempdir().unwrap();
    let mut facade = AssetHostFacade::open(config_at(dir.path())).unwrap();
    let capability = facade.issue_capability("personal", "instance-a", "module-a");
    let png = png_bytes(4, 2);

    // Obtain a real AVAILABLE response through the public façade boundary.
    let result = facade
        .import(
            &capability,
            &request(702, Source::InlineBase64 { base64: base64(&png) }, Some("image/png"), false),
        )
        .unwrap();
    assert_eq!(result.state, "available");
    assert!(result.terminal);
    assert!(result.asset.is_some());

    // Serialize that actual response and persist it as the authoritative
    // emission artifact the schema conformance guard validates. The artifact
    // is the live bytes, never a manually re-typed object.
    let emission = serde_json::to_string_pretty(&result).unwrap();
    let artifact = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../dolly-spec/examples/host-asset-status-available.json");
    std::fs::write(&artifact, emission.as_bytes()).expect("persist the live AVAILABLE emission");

    // The artifact round-trips to the identical live response and its asset
    // object is exactly the canonical schema field set, no second wire shape.
    let back: dolly_asset::StatusResult = serde_json::from_str(&emission).unwrap();
    assert_eq!(back, result);
    let asset = serde_json::to_value(result.asset.as_ref().unwrap()).unwrap();
    let obj = asset.as_object().unwrap();
    let mut keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
    keys.sort_unstable();
    assert!(
        keys.iter().all(|k| matches!(
            *k,
            "asset_id" | "media_type" | "byte_length" | "orientation"
                | "encoded_width" | "encoded_height" | "display_width" | "display_height"
        )),
        "the live emission asset carries only the canonical schema fields: {keys:?}"
    );
    for k in ["asset_id", "media_type", "byte_length"] {
        assert!(obj.contains_key(k), "required asset field {k} is present");
    }
    let bytes = obj["byte_length"].as_u64().unwrap();
    assert!(bytes <= AssetRef::MAX_WIRE_SAFE_INTEGER);
    assert_eq!(obj["encoded_width"].as_u64(), Some(4));
    assert_eq!(obj["encoded_height"].as_u64(), Some(2));
}


#[test]
fn same_domain_cross_owner_and_different_parameter_replays_are_neutral_conflicts() {
    let dir = tempfile::tempdir().unwrap();
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    let png = png_bytes(4, 2);
    let id = 711;

    // Owner imports to AVAILABLE in the personal domain.
    let owner = cap(&service);
    let available = service
        .import(
            &owner,
            &request(id, Source::InlineBase64 { base64: base64(&png) }, Some("image/png"), false),
        )
        .unwrap();
    assert_eq!(available.state, "available");

    // Same security domain, different module, byte-identical request: the
    // complete identity gate refuses with the exact cause-neutral conflict.
    let other_module = service.issue_capability("personal", "instance-a", "module-b");
    let mut contender = request(
        id,
        Source::InlineBase64 { base64: base64(&png) },
        Some("image/png"),
        false,
    );
    contender.module_id = "module-b".to_string();
    let err = service.import(&other_module, &contender).unwrap_err();
    assert_eq!(err.code, AssetErrorCode::ImportIdConflict, "cross-module");
    assert_eq!(err.message, "ImportId is already in use", "cross-module message is cause-neutral");
    assert!(err.asset_id.is_none(), "cross-module refusal discloses no AssetId");

    // Same security domain, different module instance, byte-identical
    // request: refused identically.
    let other_instance = service.issue_capability("personal", "instance-b", "module-a");
    let mut contender = request(
        id,
        Source::InlineBase64 { base64: base64(&png) },
        Some("image/png"),
        false,
    );
    contender.instance_id = "instance-b".to_string();
    let err = service.import(&other_instance, &contender).unwrap_err();
    assert_eq!(err.code, AssetErrorCode::ImportIdConflict, "cross-instance");
    assert_eq!(err.message, "ImportId is already in use", "cross-instance message is cause-neutral");
    assert!(err.asset_id.is_none(), "cross-instance refusal discloses no AssetId");

    // Same owner (module/instance/domain) but different parameters: refused
    // with the same cause-neutral code and message, never the recorded state.
    let different = request(
        id,
        Source::InlineBase64 {
            base64: base64(&png_bytes(8, 8)),
        },
        Some("image/png"),
        false,
    );
    let err = service.import(&owner, &different).unwrap_err();
    assert_eq!(err.code, AssetErrorCode::ImportIdConflict, "different parameters");
    assert_eq!(err.message, "ImportId is already in use", "different-parameter message is cause-neutral");
    assert!(err.asset_id.is_none(), "different-parameter refusal discloses no AssetId");

    // None of the refused contenders created or mutated any record: exactly
    // one durable AVAILABLE record remains with the same canonical AssetRef.
    assert_eq!(service.store_import_count(), 1);
    let status = service.status(&owner, &import_id(id)).unwrap();
    assert_eq!(status.state, "available");
    assert_eq!(
        status.asset.as_ref(),
        available.asset.as_ref(),
        "the winning record is unmodified"
    );

    // The true byte-identical replay (same owner and parameters) still
    // returns the authoritative record.
    let replay = request(
        id,
        Source::InlineBase64 { base64: base64(&png) },
        Some("image/png"),
        false,
    );
    let replayed = service.import(&owner, &replay).unwrap();
    assert_eq!(replayed.state, "available");
    assert_eq!(replayed.asset, available.asset, "true replay returns the authoritative AssetRef");
}
// ---------------------------------------------------------------------------
// 10. WP-013B Asset-side media preparation seam: the service accepts only a
//    committed `AssetId` under the exact current lease, resolves the durable
//    authoritative row itself, mints the canonical `AssetRef` from that row,
//    and re-proves `AssetId = BLAKE3(content)`. Forged/stale/revoked/
//    expired/foreign/non-AVAILABLE authority and content tampering fail
//    closed before any bytes are released. Races are driven by the clock,
//    durable-row barriers, and the deterministic post-read failpoint — no
//    sleeps.
// ---------------------------------------------------------------------------

fn prepare_request(
    asset_id: AssetId,
    expected_media_kind: MediaKind,
    claimed: Option<&str>,
    lease_id: String,
) -> MediaPrepareRequest {
    MediaPrepareRequest {
        asset_id,
        expected_media_kind,
        claimed_media_type: claimed.map(|m| m.parse().unwrap()),
        lease_id,
    }
}

/// Seed a live asset row with its bytes already in the content-addressed
/// store (same authority the import pipeline uses), so tests can construct
/// non-importable durable states deterministically.
fn seed_live_asset(
    service: &mut AssetService,
    clock: &mut TestClock,
    domain: &str,
    bytes: &[u8],
    detected: Option<&str>,
) -> (AssetId, AssetRef) {
    let digest = ContentHash::of_bytes(bytes);
    let asset_id = AssetId::from_digest(digest.digest);
    let objects = service.config_ro().local_root.join("objects");
    fs::create_dir_all(&objects).unwrap();
    fs::write(objects.join(asset_id.as_str()), bytes).unwrap();
    let now = clock.now();
    let record = AssetRecord {
        asset_id: asset_id.as_str().to_string(),
        security_domain: domain.to_string(),
        generation: 0,
        content_hash: digest,
        byte_length: bytes.len() as u64,
        declared_media_type: detected.map(|d| d.to_string()),
        detected_media_type: detected.map(|d| d.to_string()),
        orientation: None,
        encoded_width: None,
        encoded_height: None,
        display_width: None,
        display_height: None,
        lifecycle: Lifecycle::Live,
        deletion_generation: 0,
        local_state: LocalState::Present,
        replica_state: ReplicaState::Disabled,
        tombstoned_at: None,
        created_at: now.iso(),
        updated_at: now.iso(),
        updated_at_ms: now.millis,
    };
    let tx = service.store_transaction().unwrap();
    tx.insert_asset(&record, now).unwrap();
    tx.commit().unwrap();
    let media_type = detected.unwrap_or("application/octet-stream").parse().unwrap();
    let asset_ref = AssetRef {
        asset_id: asset_id.clone(),
        media_type,
        byte_length: bytes.len() as u64,
        orientation: None,
        encoded_width: None,
        encoded_height: None,
        display_width: None,
        display_height: None,
    };
    assert!(asset_ref.validate().is_ok());
    (asset_id, asset_ref)
}

#[test]
fn prepare_media_succeeds_for_available_asset_with_current_lease() {
    let dir = tempfile::tempdir().unwrap();
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    let capability = cap(&service);
    let png = png_bytes(4, 2);
    let available = service
        .import(
            &capability,
            &request(
                440,
                Source::InlineBase64 {
                    base64: base64(&png),
                },
                Some("image/png"),
                false,
            ),
        )
        .unwrap();
    let asset_ref = available.asset.clone().unwrap();
    let asset_id = asset_ref.asset_id.clone();
    let lease = service
        .lease(&capability, asset_id.as_str(), "instance-a", "channel-send", 60_000)
        .unwrap();

    let prepared = service
        .prepare_media(
            &capability,
            &prepare_request(asset_id.clone(), MediaKind::Image, Some("image/png"), lease.lease_id.clone()),
        )
        .unwrap();
    // The service mints the canonical reference from the durable row; it
    // must equal the import's authoritative reference exactly, because no
    // caller metadata can be echoed.
    assert_eq!(prepared.asset_ref, asset_ref, "service mints the canonical reference from the row");
    assert_eq!(prepared.asset_ref.media_type.as_str(), "image/png");
    assert_eq!(prepared.media_kind, MediaKind::Image);
    assert_eq!(prepared.generation, lease.generation, "exact current generation");
    assert_eq!(prepared.digest, ContentHash::of_bytes(&png), "verified canonical digest");
    assert_eq!(prepared.lease_id, lease.lease_id);
    assert_eq!(prepared.lease_expires_at_ms, lease.expires_at_ms, "lease authority proof for the send window");
    assert_eq!(prepared.bytes, png, "exact immutable bytes");

    // The lease is not consumed: a repeated preparation is idempotent.
    let again = service
        .prepare_media(
            &capability,
            &prepare_request(asset_id, MediaKind::Image, Some("image/png"), lease.lease_id),
        )
        .unwrap();
    assert_eq!(again.bytes, png);
}

#[test]
fn prepare_media_returns_only_authoritative_inspected_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::new(T0);
    let (mut service, mut clock) = service_at(dir.path(), clock);
    let capability = cap(&service);
    let png = png_bytes(12, 20);
    let digest = ContentHash::of_bytes(&png);
    let asset_id = AssetId::from_digest(digest.digest);
    let objects = service.config_ro().local_root.join("objects");
    fs::create_dir_all(&objects).unwrap();
    fs::write(objects.join(asset_id.as_str()), &png).unwrap();
    let now = clock.now();
    let record = AssetRecord {
        asset_id: asset_id.as_str().to_string(),
        security_domain: "personal".to_string(),
        generation: 0,
        content_hash: digest,
        byte_length: png.len() as u64,
        declared_media_type: Some("image/png".to_string()),
        detected_media_type: Some("image/png".to_string()),
        orientation: Some(6),
        encoded_width: Some(12),
        encoded_height: Some(20),
        display_width: Some(20),
        display_height: Some(12),
        lifecycle: Lifecycle::Live,
        deletion_generation: 0,
        local_state: LocalState::Present,
        replica_state: ReplicaState::Disabled,
        tombstoned_at: None,
        created_at: now.iso(),
        updated_at: now.iso(),
        updated_at_ms: now.millis,
    };
    let tx = service.store_transaction().unwrap();
    tx.insert_asset(&record, now).unwrap();
    tx.commit().unwrap();

    let lease = service
        .lease(&capability, asset_id.as_str(), "instance-a", "channel-send", 60_000)
        .unwrap();
    // No caller metadata whatsoever (claims omitted): the result must carry
    // only the inspected/stored values from the durable row.
    let prepared = service
        .prepare_media(&capability, &prepare_request(asset_id, MediaKind::Image, None, lease.lease_id))
        .unwrap();
    assert_eq!(prepared.asset_ref.media_type.as_str(), "image/png");
    assert_eq!(prepared.asset_ref.byte_length, png.len() as u64);
    assert_eq!(prepared.asset_ref.orientation, Some(6));
    assert_eq!(prepared.asset_ref.encoded_width, Some(12));
    assert_eq!(prepared.asset_ref.encoded_height, Some(20));
    assert_eq!(prepared.asset_ref.display_width, Some(20));
    assert_eq!(prepared.asset_ref.display_height, Some(12));
    assert!(prepared.asset_ref.validate().is_ok());
}

#[test]
fn prepare_media_refuses_forged_asset_identity_and_content_digest() {
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::new(T0);
    let (mut service, mut clock) = service_at(dir.path(), clock);
    let capability = cap(&service);
    let objects = service.config_ro().local_root.join("objects");
    fs::create_dir_all(&objects).unwrap();

    // Forged identity: a live row whose asset_id is NOT the content-derived
    // AssetId of its recorded digest. Preparation must refuse before any
    // byte read: the row cannot bind the committed identity.
    let forged_bytes = b"forged identity content";
    let forged_id = AssetId::from_digest([7u8; 32]);
    fs::write(objects.join(forged_id.as_str()), forged_bytes).unwrap();
    let now = clock.now();
    let forged_row = AssetRecord {
        asset_id: forged_id.as_str().to_string(),
        security_domain: "personal".to_string(),
        generation: 0,
        content_hash: ContentHash::of_bytes(forged_bytes),
        byte_length: forged_bytes.len() as u64,
        declared_media_type: None,
        detected_media_type: None,
        orientation: None,
        encoded_width: None,
        encoded_height: None,
        display_width: None,
        display_height: None,
        lifecycle: Lifecycle::Live,
        deletion_generation: 0,
        local_state: LocalState::Present,
        replica_state: ReplicaState::Disabled,
        tombstoned_at: None,
        created_at: now.iso(),
        updated_at: now.iso(),
        updated_at_ms: now.millis,
    };
    let tx = service.store_transaction().unwrap();
    tx.insert_asset(&forged_row, now).unwrap();
    tx.commit().unwrap();
    let lease = service
        .lease(&capability, forged_id.as_str(), "instance-a", "channel-send", 60_000)
        .unwrap();
    let err = service
        .prepare_media(&capability, &prepare_request(forged_id, MediaKind::File, None, lease.lease_id))
        .unwrap_err();
    assert_eq!(
        err.code,
        AssetErrorCode::InvalidRequest,
        "a forged AssetId is refused before any byte read"
    );

    // Forged content: row identity and digest are canonical, but the stored
    // object bytes are tampered with equal length. The read re-proves
    // `AssetId = BLAKE3(content)` and fails closed with no bytes released.
    let png = png_bytes(4, 2);
    let digest = ContentHash::of_bytes(&png);
    let asset_id = AssetId::from_digest(digest.digest);
    fs::write(objects.join(asset_id.as_str()), vec![0u8; png.len()]).unwrap();
    let now2 = clock.now();
    let tampered = AssetRecord {
        asset_id: asset_id.as_str().to_string(),
        security_domain: "personal".to_string(),
        generation: 0,
        content_hash: digest,
        byte_length: png.len() as u64,
        declared_media_type: Some("image/png".to_string()),
        detected_media_type: Some("image/png".to_string()),
        orientation: Some(1),
        encoded_width: Some(4),
        encoded_height: Some(2),
        display_width: Some(4),
        display_height: Some(2),
        lifecycle: Lifecycle::Live,
        deletion_generation: 0,
        local_state: LocalState::Present,
        replica_state: ReplicaState::Disabled,
        tombstoned_at: None,
        created_at: now2.iso(),
        updated_at: now2.iso(),
        updated_at_ms: now2.millis,
    };
    let tx = service.store_transaction().unwrap();
    tx.insert_asset(&tampered, now2).unwrap();
    tx.commit().unwrap();
    let lease = service
        .lease(&capability, asset_id.as_str(), "instance-a", "channel-send", 60_000)
        .unwrap();
    let err = service
        .prepare_media(
            &capability,
            &prepare_request(asset_id, MediaKind::Image, Some("image/png"), lease.lease_id),
        )
        .unwrap_err();
    assert_eq!(
        err.code,
        AssetErrorCode::HashMismatch,
        "tampered content fails digest verification with no bytes released"
    );
}

#[test]
fn prepare_media_refuses_revoked_lease_before_reading_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    let capability = cap(&service);
    let png = png_bytes(4, 2);
    let available = service
        .import(
            &capability,
            &request(
                441,
                Source::InlineBase64 {
                    base64: base64(&png),
                },
                Some("image/png"),
                false,
            ),
        )
        .unwrap();
    let asset_ref = available.asset.unwrap();
    let asset_id = asset_ref.asset_id;
    let lease = service
        .lease(&capability, asset_id.as_str(), "instance-a", "channel-send", 60_000)
        .unwrap();
    assert!(service.release_lease(&lease.lease_id).unwrap());

    // Corrupt the object so a read would fail digest verification; the
    // refusal must still be the revoked-lease error, proving no read ran.
    fs::write(dir.path().join("objects").join(asset_id.as_str()), b"tampered").unwrap();
    let err = service
        .prepare_media(
            &capability,
            &prepare_request(asset_id, MediaKind::Image, Some("image/png"), lease.lease_id),
        )
        .unwrap_err();
    assert_eq!(
        err.code,
        AssetErrorCode::LeaseInvalid,
        "a revoked lease fails before any byte read"
    );
}

#[test]
fn prepare_media_refuses_expired_lease() {
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::new(T0);
    let (mut service, clock) = service_at(dir.path(), clock);
    let capability = cap(&service);
    let png = png_bytes(4, 2);
    let available = service
        .import(
            &capability,
            &request(
                442,
                Source::InlineBase64 {
                    base64: base64(&png),
                },
                Some("image/png"),
                false,
            ),
        )
        .unwrap();
    let asset_ref = available.asset.unwrap();
    let asset_id = asset_ref.asset_id;
    let lease = service
        .lease(&capability, asset_id.as_str(), "instance-a", "channel-send", 1_000)
        .unwrap();
    clock.advance(2_000);
    let err = service
        .prepare_media(
            &capability,
            &prepare_request(asset_id, MediaKind::Image, Some("image/png"), lease.lease_id),
        )
        .unwrap_err();
    assert_eq!(err.code, AssetErrorCode::LeaseInvalid, "an expired lease is refused");
}

#[test]
fn prepare_media_refuses_stale_generation_lease() {
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::new(T0);
    let (mut service, mut clock) = service_at(dir.path(), clock);
    let capability = cap(&service);
    let png = png_bytes(4, 2);
    let available = service
        .import(
            &capability,
            &request(
                443,
                Source::InlineBase64 {
                    base64: base64(&png),
                },
                Some("image/png"),
                false,
            ),
        )
        .unwrap();
    let asset_ref = available.asset.unwrap();
    let asset_id = asset_ref.asset_id;
    let lease = service
        .lease(&capability, asset_id.as_str(), "instance-a", "channel-send", 60_000)
        .unwrap();
    assert_eq!(lease.generation, 1);

    // A tombstone+resurrect racing the held lease makes generation 2 the
    // current live row; the generation-1 lease must fail closed.
    let now = clock.now();
    let resurrected = AssetRecord {
        asset_id: asset_id.as_str().to_string(),
        security_domain: "personal".to_string(),
        generation: 2,
        content_hash: ContentHash::of_bytes(&png),
        byte_length: png.len() as u64,
        declared_media_type: Some("image/png".to_string()),
        detected_media_type: Some("image/png".to_string()),
        orientation: Some(1),
        encoded_width: Some(4),
        encoded_height: Some(2),
        display_width: Some(4),
        display_height: Some(2),
        lifecycle: Lifecycle::Live,
        deletion_generation: 0,
        local_state: LocalState::Present,
        replica_state: ReplicaState::Disabled,
        tombstoned_at: None,
        created_at: now.iso(),
        updated_at: now.iso(),
        updated_at_ms: now.millis,
    };
    let tx = service.store_transaction().unwrap();
    tx.insert_asset(&resurrected, now).unwrap();
    tx.commit().unwrap();

    let err = service
        .prepare_media(
            &capability,
            &prepare_request(asset_id, MediaKind::Image, Some("image/png"), lease.lease_id),
        )
        .unwrap_err();
    assert_eq!(
        err.code,
        AssetErrorCode::LeaseInvalid,
        "a lease bound to a stale generation is refused"
    );
}

#[test]
fn prepare_media_refuses_foreign_domain_and_owner_leases() {
    let dir = tempfile::tempdir().unwrap();
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    let owner = service.issue_capability("personal", "instance-a", "module-a");
    let foreign_domain = service.issue_capability("work", "instance-a", "module-a");
    let foreign_instance = service.issue_capability("personal", "instance-b", "module-a");
    let png = png_bytes(4, 2);
    let available = service
        .import(
            &owner,
            &request(
                444,
                Source::InlineBase64 {
                    base64: base64(&png),
                },
                Some("image/png"),
                false,
            ),
        )
        .unwrap();
    let asset_ref = available.asset.unwrap();
    let asset_id = asset_ref.asset_id;
    let lease = service
        .lease(&owner, asset_id.as_str(), "instance-a", "channel-send", 60_000)
        .unwrap();

    let err = service
        .prepare_media(
            &foreign_domain,
            &prepare_request(asset_id.clone(), MediaKind::Image, Some("image/png"), lease.lease_id.clone()),
        )
        .unwrap_err();
    assert_eq!(err.code, AssetErrorCode::Unauthorized, "a foreign security-domain lease is refused");

    let err = service
        .prepare_media(
            &foreign_instance,
            &prepare_request(asset_id, MediaKind::Image, Some("image/png"), lease.lease_id),
        )
        .unwrap_err();
    assert_eq!(err.code, AssetErrorCode::Unauthorized, "a foreign-owner lease is refused");
}

#[test]
fn prepare_media_refuses_forged_kind_and_type_claims() {
    let dir = tempfile::tempdir().unwrap();
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    let capability = cap(&service);
    let png = png_bytes(4, 2);
    let available = service
        .import(
            &capability,
            &request(
                445,
                Source::InlineBase64 {
                    base64: base64(&png),
                },
                Some("image/png"),
                false,
            ),
        )
        .unwrap();
    let asset_ref = available.asset.unwrap();
    let asset_id = asset_ref.asset_id;
    let lease = service
        .lease(&capability, asset_id.as_str(), "instance-a", "channel-send", 60_000)
        .unwrap();

    // A forged media-type claim (action override) is refused.
    let err = service
        .prepare_media(
            &capability,
            &prepare_request(asset_id.clone(), MediaKind::Image, Some("image/jpeg"), lease.lease_id.clone()),
        )
        .unwrap_err();
    assert_eq!(err.code, AssetErrorCode::Unauthorized, "a forged claimed media type is refused");

    // A forged media-kind claim is refused.
    let err = service
        .prepare_media(
            &capability,
            &prepare_request(asset_id, MediaKind::Audio, Some("image/png"), lease.lease_id),
        )
        .unwrap_err();
    assert_eq!(err.code, AssetErrorCode::Unauthorized, "a forged expected media kind is refused");
}

#[test]
fn prepare_media_refuses_active_document_content() {
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::new(T0);
    let (mut service, mut clock) = service_at(dir.path(), clock);
    let capability = cap(&service);
    let pdf = b"%PDF-1.4 fake pdf bytes exercising the active-content gate";
    let (asset_id, _asset_ref) =
        seed_live_asset(&mut service, &mut clock, "personal", pdf, Some("application/pdf"));
    let lease = service
        .lease(&capability, asset_id.as_str(), "instance-a", "channel-send", 60_000)
        .unwrap();
    let err = service
        .prepare_media(
            &capability,
            &prepare_request(asset_id, MediaKind::File, Some("application/pdf"), lease.lease_id),
        )
        .unwrap_err();
    assert_eq!(
        err.code,
        AssetErrorCode::UnsafeMedia,
        "active document content is never relabeled into transportable media"
    );
}

#[test]
fn prepare_media_refuses_missing_bytes_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    let capability = cap(&service);
    let png = png_bytes(4, 2);
    let available = service
        .import(
            &capability,
            &request(
                446,
                Source::InlineBase64 {
                    base64: base64(&png),
                },
                Some("image/png"),
                false,
            ),
        )
        .unwrap();
    let asset_ref = available.asset.unwrap();
    let asset_id = asset_ref.asset_id;
    let lease = service
        .lease(&capability, asset_id.as_str(), "instance-a", "channel-send", 60_000)
        .unwrap();
    fs::remove_file(dir.path().join("objects").join(asset_id.as_str())).unwrap();
    let err = service
        .prepare_media(
            &capability,
            &prepare_request(asset_id, MediaKind::Image, Some("image/png"), lease.lease_id),
        )
        .unwrap_err();
    assert_eq!(
        err.code,
        AssetErrorCode::NotFound,
        "deleted local bytes fail closed, never releasing bytes"
    );
}

#[test]
fn prepare_media_enforces_the_current_decoded_byte_bound() {
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::new(T0);
    let (mut service, mut clock) = service_at(dir.path(), clock);
    let big: Vec<u8> = (0..2000u32).map(|i| (i % 251) as u8).collect();
    let (asset_id, _asset_ref) = seed_live_asset(&mut service, &mut clock, "personal", &big, None);

    // Reopen the same durable store under a lowered decoded bound: the
    // current configuration authority must fail closed at preparation time.
    let mut lowered = config_at(dir.path());
    lowered.max_decoded_bytes = 1024;
    let mut service2 = AssetService::open_with(
        lowered,
        clock.clone(),
        DeniedFetcher,
        DisabledReplica::new("assets"),
    )
    .expect("second service opens the same store");
    let capability2 = service2.issue_capability("personal", "instance-a", "module-a");
    let lease = service2
        .lease(&capability2, asset_id.as_str(), "instance-a", "channel-send", 60_000)
        .unwrap();
    let err = service2
        .prepare_media(
            &capability2,
            &prepare_request(asset_id, MediaKind::File, None, lease.lease_id),
        )
        .unwrap_err();
    assert_eq!(
        err.code,
        AssetErrorCode::SizeLimit,
        "a lowered decoded bound fails closed at preparation time"
    );
}

#[test]
fn prepare_media_revalidation_after_read_revokes_and_returns_no_result() {
    let dir = tempfile::tempdir().unwrap();
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
    let capability = cap(&service);
    let png = png_bytes(4, 2);
    let available = service
        .import(
            &capability,
            &request(
                449,
                Source::InlineBase64 {
                    base64: base64(&png),
                },
                Some("image/png"),
                false,
            ),
        )
        .unwrap();
    let asset_ref = available.asset.unwrap();
    let asset_id = asset_ref.asset_id;
    let lease = service
        .lease(&capability, asset_id.as_str(), "instance-a", "channel-send", 60_000)
        .unwrap();

    // Positive control: before the failpoint is armed the same request
    // succeeds, so the failpoint is the only variable.
    service
        .prepare_media(
            &capability,
            &prepare_request(asset_id.clone(), MediaKind::Image, Some("image/png"), lease.lease_id.clone()),
        )
        .expect("preparation succeeds before arming the failpoint");

    // The failpoint revokes the lease in the exact window between the
    // blocking read and the post-read revalidation. The deterministic
    // barrier proves no prepared result escapes after revocation.
    let revoke_lease_id = lease.lease_id.clone();
    service.arm_prepare_failpoint(Some(PrepareFailpoint::new(
        move |store: &mut AssetStore| {
            let tx = store.transaction().unwrap();
            assert!(
                tx.release_lease(&revoke_lease_id).unwrap(),
                "failpoint revokes the lease"
            );
            tx.commit().unwrap();
        },
    )));
    let err = service
        .prepare_media(
            &capability,
            &prepare_request(asset_id, MediaKind::Image, Some("image/png"), lease.lease_id),
        )
        .unwrap_err();
    assert_eq!(
        err.code,
        AssetErrorCode::LeaseInvalid,
        "revocation after the read fails the whole preparation before release"
    );
}
