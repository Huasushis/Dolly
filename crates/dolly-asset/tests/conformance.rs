//! Focused WP-010 conformance tests: bounded import to a durable
//! `AVAILABLE`/`AssetRef`, refusal of invalid and over-limit sources with no
//! partial authority, idempotent replay, deterministic crash-recovery
//! controls, lease/GC ownership, and security-domain isolation.

use dolly_asset::clock::{Clock, ClockTime};
use dolly_asset::config::{ReplicaConfig, ResolvedAssetConfig};
use dolly_asset::error::{AssetErrorCode, ErrorPhase};
use dolly_asset::identity::{AssetId, ContentHash};
use dolly_asset::record::{ImportRequest, ImportState, MediaKind, Source};
use dolly_asset::remote::DeniedFetcher;
use dolly_asset::replica::{DisabledReplica, InMemoryReplica};
use dolly_asset::service::AssetService;
use dolly_asset::{AssetCapability, ReplicaState};
use parking_lot::Mutex;
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
        ClockTime {
            iso: dolly_asset::format_timestamp(millis),
            millis,
        }
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
    let store = dolly_asset::AssetStore::open(&dir.path().join("db.sqlite")).unwrap();
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
    let (mut service, _clock) = service_at(dir.path(), TestClock::new(T0));
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
    let gc = service.run_gc().unwrap();
    assert_eq!(gc.tombstones_created, 0, "durable reference blocks GC");

    service
        .remove_reference(&capability, &asset_id, reference.generation, "block:b1")
        .unwrap();
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

    // Cross-domain read does not leak even with identical bytes.
    assert!(service.read(&domain_a, asset_a.asset_id.as_str()).is_ok());
    assert!(
        service.read(&domain_b, asset_a.asset_id.as_str()).is_err(),
        "a hash match must not grant cross-domain read"
    );

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
    let (staging_bytes, staging_hash) = staging.unwrap_or((0, String::new()));
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
        byte_length: staging
            .as_ref()
            .map(|(len, _)| *len),
        encoded_width: Some(4),
        encoded_height: Some(2),
        orientation: Some(1),
        staging_bytes: staging.as_ref().map(|(len, _)| *len),
        staging_hash: staging.as_ref().map(|(_, h)| h.clone()),
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
    };
    let tx = service.store_transaction().unwrap();
    assert!(tx.insert_import_if_absent(&record).unwrap());
    tx.commit().unwrap();
}
