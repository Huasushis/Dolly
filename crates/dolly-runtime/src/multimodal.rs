//! Runtime-owned WP-013B multimodal adapters — the single Runtime
//! implementation of the accepted `dolly-channel` sealed Asset seams.
//!
//! Outbound: [`ChannelAssetSeam`] implements `dolly_channel::AssetPreparation`.
//! For every committed `AssetPremise` it acquires the module's Asset
//! capability and a finite short lease from the accepted `AssetService`,
//! runs `AssetService::prepare_media` under the exact committed AssetId and
//! lease, and converts the returned `PreparedMedia` field-for-field into the
//! closed Channel `AssetPayload` (whose durable slice is the `AssetLeaseProof`).
//! No raw store, path, or caller metadata is substituted; the Asset service
//! re-proves availability, ownership, domain, generation, digest, media
//! type, and geometry at preparation time.
//!
//! Inbound: [`ChannelAttachmentImport`] implements
//! `dolly_channel::InboundAssetImport`. It imports one authenticated provider
//! attachment through the Asset façade under the Channel owner/domain/module
//! with an account-scoped deterministic import key, and answers name-based
//! status. `Absent` is reported only when the Asset authority has no durable
//! import record/effect for exactly that key.
//!
//! Every authority question the adapter cannot answer — no bound Asset
//! store/capability, an unavailable/foreign/stale asset, a missing, revoked,
//! or expired lease, a capability from another Host lifecycle, an unsafe or
//! over-bound provider payload — fails closed with the Channel asset code
//! (`CHANNEL_ASSET_IMPORT_FAILED`) and zero transport/durable effect. The
//! default (unbound) construction is the fail-closed text/attachment path a
//! route without a bound Asset store must take; the bound construction is
//! the single production registration per store/account/config lifecycle.

use std::time::{SystemTime, UNIX_EPOCH};

use dolly_asset::config::ResolvedAssetConfig;
use dolly_asset::facade::{AssetHostFacade, AssetStatusRequest};
use dolly_asset::prepare::{MediaPrepareRequest, PreparedMedia};
use dolly_asset::record::{ImportRequest, MediaKind, Source, StatusResult};
use dolly_asset::service::{AssetCapability, AssetService};
use dolly_channel::asset::{
    AssetId as ChannelAssetId, AssetPayload, AssetPremise, AssetPreparation,
    AssetRef as ChannelAssetRef, ContentHash as ChannelContentHash,
    MediaKind as ChannelMediaKind, MediaType as ChannelMediaType,
};
use dolly_channel::attachment::{
    AttachmentImportRequest, AttachmentImportStatus, AvailableAttachment, InboundAssetImport,
};
use dolly_channel::error::{ChannelError, ChannelOutcome, codes};
use dolly_storage::{HostCapabilityGrant, HostConnectionAuthority};

use crate::host_routes::HostRouteError;

/// The bounded authenticated provider attachment reader the Runtime owns.
/// It reads the exact immutable bytes for one authenticated provider key
/// within a caller-supplied byte bound — never a raw path, ambient network,
/// or caller authority claim. Acceptance injects a deterministic fake;
/// production binds the transport's own provider fetch here.
pub trait ProviderAttachmentReader {
    /// Read the exact bytes for `provider_key`, refusing when the provider
    /// cannot authenticate the key, the bytes are unavailable, or the payload
    /// exceeds `max_bytes`. Errors are closed and must not expose a path,
    /// capability, account, or network detail.
    fn read(&mut self, provider_key: &str, max_bytes: u64) -> Result<Vec<u8>, String>;
}

// ---------------------------------------------------------------------------
// One registered Asset route per store/account/config identity.
// ---------------------------------------------------------------------------

/// The sealed identity a registered Asset route belongs to. Both Channel
/// directions (outbound prepare and inbound import) for the same
/// store/account/activation must resolve to the exact same Asset store, so
/// registration records ONE root per identity and every later binding must
/// match it or fail closed.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct AssetRouteIdentity {
    extension_connection_id: String,
    worker_epoch: String,
    module_id: String,
    config_revision: i64,
}

#[derive(Debug, Clone)]
struct AssetRouteBinding {
    root: std::path::PathBuf,
}

impl AssetRouteBinding {
    fn root_key(&self) -> String {
        asset_root_key(&self.root)
    }
}

/// Process-wide registry of the registered Asset routes. Only grows with
/// distinct sealed route identities (bounded by the finite set of
/// activations) and never stores capabilities, paths beyond the content
/// root, or caller metadata.
static ASSET_ROUTE_BINDINGS: std::sync::OnceLock<
    parking_lot::Mutex<std::collections::HashMap<AssetRouteIdentity, AssetRouteBinding>>,
> = std::sync::OnceLock::new();

fn asset_route_registry() -> &'static parking_lot::Mutex<std::collections::HashMap<AssetRouteIdentity, AssetRouteBinding>> {
    ASSET_ROUTE_BINDINGS.get_or_init(|| parking_lot::Mutex::new(std::collections::HashMap::new()))
}

fn asset_route_identity(
    authority: &HostConnectionAuthority,
    grant: &HostCapabilityGrant,
    config_revision: i64,
) -> AssetRouteIdentity {
    AssetRouteIdentity {
        extension_connection_id: authority.extension_connection_id().to_owned(),
        worker_epoch: authority.worker_epoch().to_string(),
        module_id: grant.module_id().to_owned(),
        config_revision,
    }
}

/// A canonical absolute form of the content root used for equality (never a
/// capability or variable path component).
fn asset_root_key(root: &std::path::Path) -> String {
    std::path::absolute(root)
        .ok()
        .and_then(|absolute| absolute.canonicalize().ok().or(Some(absolute)))
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.to_string_lossy().into_owned())
}

/// Register (or verify) the one Asset route for this sealed store/account/
/// config identity and its exact content root. Requires the current
/// `host.asset.import` and `host.asset.status` capability under the same
/// extension/module authority; a different root for the same identity is a
/// stale/re-placed registration and fails closed.
pub(crate) fn asset_route_register(
    authority: &HostConnectionAuthority,
    grant: &HostCapabilityGrant,
    config_revision: i64,
    root: &std::path::Path,
) -> Result<(), HostRouteError> {
    if !grant.allows("host.asset.import") || !grant.allows("host.asset.status") {
        return Err(HostRouteError::CapabilityDenied {
            detail: "the multimodal Channel route requires host.asset.import and host.asset.status grants under the same authority".into(),
        });
    }
    let key = asset_route_identity(authority, grant, config_revision);
    let mut registry = asset_route_registry().lock();
    if let Some(existing) = registry.get(&key) {
        if existing.root_key() != asset_root_key(root) {
            return Err(HostRouteError::CapabilityDenied {
                detail: "a different Asset content root is already registered for this store/account/config identity".into(),
            });
        }
        return Ok(());
    }
    registry.insert(
        key,
        AssetRouteBinding {
            root: root.to_path_buf(),
        },
    );
    Ok(())
}

/// Resolve the exact registered Asset content root for this sealed identity,
/// failing closed when no route registered it (the outbound registration owns
/// the Asset store under the authority direction).
fn asset_route_registered_root(
    authority: &HostConnectionAuthority,
    grant: &HostCapabilityGrant,
    config_revision: i64,
) -> Result<std::path::PathBuf, HostRouteError> {
    let key = asset_route_identity(authority, grant, config_revision);
    let registry = asset_route_registry().lock();
    registry
        .get(&key)
        .map(|binding| binding.root.clone())
        .ok_or_else(|| HostRouteError::CapabilityDenied {
            detail: "no Asset route is registered for this store/account/config identity; register the outbound Asset route first".into(),
        })
}

/// The finite short Asset lease the outbound adapter holds per prepared
/// premise (the frozen "short Asset lease" of the multimodal profile).
const ASSET_LEASE_TTL_MS: u64 = 30_000;

/// Redacted fail-closed refusal for one asset part. Only the ordinal and the
/// Asset envelope code are surfaced; the content root, path, capability, and
/// raw cause never leave the Asset authority.
fn asset_refused(ordinal: u32, code: &str) -> ChannelError {
    ChannelError::new(
        codes::ASSET_IMPORT_FAILED,
        false,
        ChannelOutcome::NotApplied,
        format!(
            "asset authority refused asset part at ordinal {ordinal} (code {code}); the committed AssetId cannot be prepared"
        ),
    )
}

fn attachment_refused(provider_key: &str, detail: &str) -> ChannelError {
    ChannelError::new(
        codes::ASSET_IMPORT_FAILED,
        false,
        ChannelOutcome::NotApplied,
        format!("attachment import refused for provider key {provider_key}: {detail}"),
    )
}

fn asset_kind_of_type(media_type: &ChannelMediaType) -> MediaKind {
    if media_type.as_str().starts_with("image/") {
        MediaKind::Image
    } else if media_type.as_str().starts_with("audio/") {
        MediaKind::Audio
    } else if media_type.as_str().starts_with("video/") {
        MediaKind::Video
    } else {
        MediaKind::File
    }
}

fn channel_kind_of_type(kind: MediaKind) -> ChannelMediaKind {
    match kind {
        MediaKind::Image => ChannelMediaKind::Image,
        MediaKind::Audio => ChannelMediaKind::Audio,
        MediaKind::Video => ChannelMediaKind::Video,
        MediaKind::File => ChannelMediaKind::File,
    }
}

fn now_unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
/// Strict canonical base64 (RFC 4648 alphabet, terminal `=` padding),
/// matching the Asset `InlineBase64` wire contract.
fn strict_base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut index = 0usize;
    while index + 3 <= bytes.len() {
        let value = u32::from(bytes[index]) << 16
            | u32::from(bytes[index + 1]) << 8
            | u32::from(bytes[index + 2]);
        out.push(ALPHABET[(value >> 18) as usize & 0x3f] as char);
        out.push(ALPHABET[(value >> 12) as usize & 0x3f] as char);
        out.push(ALPHABET[(value >> 6) as usize & 0x3f] as char);
        out.push(ALPHABET[value as usize & 0x3f] as char);
        index += 3;
    }
    let remaining = bytes.len() - index;
    if remaining == 1 {
        let value = u32::from(bytes[index]) << 16;
        out.push(ALPHABET[(value >> 18) as usize & 0x3f] as char);
        out.push(ALPHABET[(value >> 12) as usize & 0x3f] as char);
        out.push('=');
        out.push('=');
    } else if remaining == 2 {
        let value = u32::from(bytes[index]) << 16 | u32::from(bytes[index + 1]) << 8;
        out.push(ALPHABET[(value >> 18) as usize & 0x3f] as char);
        out.push(ALPHABET[(value >> 12) as usize & 0x3f] as char);
        out.push(ALPHABET[(value >> 6) as usize & 0x3f] as char);
        out.push('=');
    }
    let _ = dolly_asset::source::strict_base64_decoded_len(&out)
        .expect("strict base64 encoder output must be canonical");
    out
}

/// One RFC3339 deadline string for Asset wire requests, derived from the
/// current monotonic instant.
fn wire_deadline_after(seconds: u64) -> String {
    dolly_asset::clock::format_timestamp(now_unix_millis() + seconds * 1000)
}

// ---------------------------------------------------------------------------
// Outbound: prepare_assets under the exact Asset capability and lease.
// ---------------------------------------------------------------------------

/// The Runtime's one outbound Asset preparation seam. Unbound by default
/// (fail closed on every asset part); bound by the route with the module's
/// resolved Asset configuration and the sealed authority/grant facts.
pub struct ChannelAssetSeam {
    service: Option<AssetService>,
    capability: Option<AssetCapability>,
}

impl ChannelAssetSeam {
    /// The fail-closed seam: no Asset store is bound to the route, so every
    /// committed asset part is refused with the Channel asset code before
    /// any durable prepared row or transport effect.
    pub fn unbound() -> Self {
        Self {
            service: None,
            capability: None,
        }
    }

    /// Bind the module's Asset store and capability. `domain`, `instance`,
    /// and `module` come only from the sealed authority/grant facts (the
    /// exact `AssetHostRoute` derivation), so no caller can choose or mint a
    /// capability and a stale Host lifecycle is refused by the service.
    pub fn bind(
        config: ResolvedAssetConfig,
        authority: &HostConnectionAuthority,
        grant: &HostCapabilityGrant,
    ) -> Result<Self, HostRouteError> {
        config.validate().map_err(|detail| HostRouteError::CapabilityDenied {
            detail: format!("asset config invalid: {detail}"),
        })?;
        let service = AssetService::open(config).map_err(|error| {
            let envelope = error.to_envelope();
            HostRouteError::Rejected {
                code: envelope.code,
                message: envelope.message,
            }
        })?;
        let instance_id = format!("i{}", authority.worker_epoch());
        if instance_id.parse::<dolly_core_domain::InstanceId>().is_err() {
            return Err(HostRouteError::CapabilityDenied {
                detail: "sealed worker epoch cannot form a stable instance identifier".into(),
            });
        }
        let capability = service.issue_capability(
            authority.extension_connection_id().to_owned(),
            instance_id,
            grant.module_id().to_owned(),
        );
        Ok(Self {
            service: Some(service),
            capability: Some(capability),
        })
    }

    /// Test-support: bind a pre-opened service and capability directly, so
    /// the adapter's prepare path can be proven without Host scaffolding.
    #[cfg(test)]
    pub(crate) fn for_test(
        service: AssetService,
        capability: AssetCapability,
        _owner: &str,
    ) -> Self {
        Self {
            service: Some(service),
            capability: Some(capability),
        }
    }

    #[cfg(test)]
    fn take_service(&mut self) -> AssetService {
        self.service.take().expect("service bound")
    }
}

impl AssetPreparation for ChannelAssetSeam {
    fn prepare_assets(
        &mut self,
        premises: &[AssetPremise],
    ) -> Result<Vec<AssetPayload>, ChannelError> {
        let Some((service, capability)) = self.service.as_mut().zip(self.capability.as_ref())
        else {
            if let Some(first) = premises.first() {
                return Err(asset_refused(first.ordinal, "NO_ASSET_STORE"));
            }
            return Ok(Vec::new());
        };
        let mut payloads = Vec::with_capacity(premises.len());
        for premise in premises {
            let asset_id = premise.asset_id.as_str().to_string();
            // 1. A finite short lease under the committed AssetId and the
            //    bound capability. `create_lease` re-checks availability,
            //    domain, and the tombstone in the same durable transaction.
            let lease = service
                .lease(
                    capability,
                    &asset_id,
                    capability.instance_id(),
                    "channel send",
                    ASSET_LEASE_TTL_MS,
                )
                .map_err(|error| asset_refused(premise.ordinal, &error_code(&error)))?;
            // 2. Prepare under the exact lease. Only the committed AssetId is
            //    trusted input; kind/type claims are checks, never labels,
            //    and the service re-proves identity, digest, geometry, and
            //    active-content safety before bytes are released.
            let claimed_type: dolly_asset::identity::MediaType =
                premise.media_type.as_str().parse().map_err(|_| {
                    asset_refused(premise.ordinal, "INVALID_MEDIA_TYPE")
                })?;
            let request = MediaPrepareRequest {
                asset_id: asset_id.parse().map_err(|_| {
                    asset_refused(premise.ordinal, "NONCANONICAL_ASSET_ID")
                })?,
                expected_media_kind: asset_kind_of_type(&premise.media_type),
                claimed_media_type: Some(claimed_type),
                lease_id: lease.lease_id.clone(),
            };
            let prepared = service
                .prepare_media(capability, &request)
                .map_err(|error| asset_refused(premise.ordinal, &error_code(&error)))?;
            payloads.push(convert_prepared_media(premise.ordinal, prepared)?);
        }
        Ok(payloads)
    }
}

fn error_code(error: &dolly_asset::error::AssetError) -> String {
    error.to_envelope().code
}

/// Field-for-field mirror of the accepted Asset `PreparedMedia` into the
/// closed Channel `AssetPayload`. Every reference field is the value the
/// Asset service minted from the durable row; no caller metadata is echoed
/// and no absent geometry is fabricated.
fn convert_prepared_media(ordinal: u32, prepared: PreparedMedia) -> Result<AssetPayload, ChannelError> {
    let asset_ref = ChannelAssetRef {
        asset_id: ChannelAssetId::parse(prepared.asset_ref.asset_id.as_str()).map_err(|_| {
            asset_refused(ordinal, "NONCANONICAL_ASSET_ID")
        })?,
        media_type: ChannelMediaType::parse(prepared.asset_ref.media_type.as_str()).map_err(|_| {
            asset_refused(ordinal, "INVALID_MEDIA_TYPE")
        })?,
        byte_length: prepared.asset_ref.byte_length,
        orientation: prepared.asset_ref.orientation,
        encoded_width: prepared.asset_ref.encoded_width,
        encoded_height: prepared.asset_ref.encoded_height,
        display_width: prepared.asset_ref.display_width,
        display_height: prepared.asset_ref.display_height,
    };
    asset_ref.validate().map_err(|message| {
        ChannelError::new(
            codes::ASSET_IMPORT_FAILED,
            false,
            ChannelOutcome::NotApplied,
            format!("asset part at ordinal {ordinal} refused: {message}"),
        )
    })?;
    Ok(AssetPayload {
        asset_ref,
        media_kind: channel_kind_of_type(prepared.media_kind),
        generation: prepared.generation,
        digest: ChannelContentHash::from_digest(prepared.digest.digest),
        lease_id: prepared.lease_id.clone(),
        lease_expiry_unix_ms: prepared.lease_expires_at_ms,
        bytes: prepared.bytes.clone(),
    })
}

// ---------------------------------------------------------------------------
// Inbound: provider attachment -> explicit Asset import -> name-based status.
// ---------------------------------------------------------------------------

/// The Runtime's one inbound Attachment import seam. Unbound by default
/// (every attachment is refused with the Channel asset code); bound by the
/// route with the module's resolved Asset configuration, the sealed
/// authority/grant facts, and the authenticated Channel account.
pub struct ChannelAttachmentImport {
    facade: Option<AssetHostFacade>,
    capability: Option<AssetCapability>,
    /// The sealed Channel principal account this seam serves. Every
    /// attachment request key must be scoped to exactly this account;
    /// anything else is refused before any Asset call.
    account: String,
    /// The bounded authenticated provider attachment reader. The multimodal
    /// bound construction always injects one; `None` exists only on the
    /// fail-closed unbound (text-only) seam.
    provider: Option<Box<dyn ProviderAttachmentReader>>,
}

impl ChannelAttachmentImport {
    /// The fail-closed seam: attachments are refused before any durable or
    /// transport effect.
    pub fn unbound() -> Self {
        Self {
            facade: None,
            capability: None,
            account: String::new(),
            provider: None,
        }
    }

    /// Bind the module's Asset facade, capability, and the sealed principal
    /// account, with the required bounded provider reader. Fails closed when
    /// the grant does not authorize `host.asset.import`/`host.asset.status`
    /// under the same extension/module authority, when the caller account is
    /// not the sealed Channel principal account, when the Asset content root
    /// is not the one registered for this store/account/config identity, or
    /// when the supplied reader is missing.
    pub fn bind(
        config: ResolvedAssetConfig,
        config_revision: i64,
        authority: &HostConnectionAuthority,
        grant: &HostCapabilityGrant,
        account: &str,
        provider: Box<dyn ProviderAttachmentReader>,
    ) -> Result<Self, HostRouteError> {
        config.validate().map_err(|detail| HostRouteError::CapabilityDenied {
            detail: format!("asset config invalid: {detail}"),
        })?;
        if !grant.allows("host.asset.import") || !grant.allows("host.asset.status") {
            return Err(HostRouteError::CapabilityDenied {
                detail: "the grant does not authorize host.asset.import/host.asset.status".into(),
            });
        }
        // The account is a sealed fact of the current authority/grant, never
        // an unchecked caller choice.
        let principal = dolly_channel::ChannelPrincipal::from_authority_grant(authority, grant)
            .map_err(|error| HostRouteError::Rejected {
                code: error.code,
                message: error.message,
            })?;
        if principal.account() != account {
            return Err(HostRouteError::CapabilityDenied {
                detail: "caller account does not match the sealed Channel principal account".into(),
            });
        }
        // The exact same Asset store the outbound route registered for this
        // identity must serve the inbound imports (one adapter set per
        // store/account/config lifecycle).
        let registered =
            asset_route_registered_root(authority, grant, config_revision)?;
        if asset_root_key(&config.local_root) != asset_root_key(&registered) {
            return Err(HostRouteError::CapabilityDenied {
                detail: "inbound Asset content root does not match the registered outbound Asset root for this identity".into(),
            });
        }
        let facade = AssetHostFacade::open(config).map_err(|error| {
            let envelope = error.to_envelope();
            HostRouteError::Rejected {
                code: envelope.code,
                message: envelope.message,
            }
        })?;
        let instance_id = format!("i{}", authority.worker_epoch());
        if instance_id.parse::<dolly_core_domain::InstanceId>().is_err() {
            return Err(HostRouteError::CapabilityDenied {
                detail: "sealed worker epoch cannot form a stable instance identifier".into(),
            });
        }
        let capability = facade.issue_capability(
            authority.extension_connection_id().to_owned(),
            instance_id,
            grant.module_id().to_owned(),
        );
        Ok(Self {
            facade: Some(facade),
            capability: Some(capability),
            account: account.to_string(),
            provider: Some(provider),
        })
    }

    /// Fail closed unless the attachment key is scoped to exactly this
    /// seam's bound account. Called before any provider read or Asset call,
    /// so a foreign or forged key can never import or query under this
    /// domain.
    fn check_attachment_ownership(
        &self,
        request: &AttachmentImportRequest,
    ) -> Result<(), ChannelError> {
        let scoped = format!("{}\u{0}", self.account);
        if !request.attachment_key.starts_with(&scoped) {
            return Err(attachment_refused(
                &request.provider_key,
                "attachment key is not scoped to the bound Channel account",
            ));
        }
        Ok(())
    }

    /// Test-support: bind a pre-opened facade and capability directly, so the
    /// adapter's import/status path can be proven without Host scaffolding.
    /// The provider is required here as well: the multimodal seam never runs
    /// without a bounded provider reader.
    #[cfg(test)]
    pub(crate) fn for_test(
        facade: AssetHostFacade,
        capability: AssetCapability,
        account: &str,
        provider: Box<dyn ProviderAttachmentReader>,
    ) -> Self {
        Self {
            facade: Some(facade),
            capability: Some(capability),
            account: account.to_string(),
            provider: Some(provider),
        }
    }

    fn import_id_for(&self, request: &AttachmentImportRequest) -> String {
        // Stable 128-bit UUID-v7-shaped id derived from the sealed account
        // and the Channel account-scoped idempotency key, so a restart
        // replays the exact same durable key without any caller-chosen id.
        let mut bytes = [0u8; 16];
        let mut seed = self.account.as_bytes().to_vec();
        seed.push(0);
        seed.extend_from_slice(request.attachment_key.as_bytes());
        let digest = blake3::hash(&seed);
        bytes.copy_from_slice(&digest.as_bytes()[0..16]);
        // v7 flavour: version 7 in the high nibble, variant 0b10 in byte 8.
        bytes[6] = (bytes[6] & 0x0f) | 0x70;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        format!(
            "{:08x}-{:04x}-{:04x}-{:04x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
            u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
            u16::from_be_bytes([bytes[4], bytes[5]]),
            u16::from_be_bytes([bytes[6], bytes[7]]),
            u16::from_be_bytes([bytes[8], bytes[9]]),
            bytes[10],
            bytes[11],
            bytes[12],
            bytes[13],
            bytes[14],
            bytes[15],
        )
    }

    fn run_import(
        &mut self,
        request: &AttachmentImportRequest,
    ) -> Result<AttachmentImportStatus, ChannelError> {
        self.check_attachment_ownership(request)?;
        let import_id = self.import_id_for(request);
        let Some((facade, capability)) = self.facade.as_mut().zip(self.capability.as_ref())
        else {
            return Err(attachment_refused(
                &request.provider_key,
                "no Asset store/capability is bound to the Channel inbound route",
            ));
        };
        let Some(reader) = self.provider.as_mut() else {
            return Err(attachment_refused(
                &request.provider_key,
                "no bounded provider reader is bound; provider bytes cannot be obtained",
            ));
        };
        let bytes = reader
            .read(&request.provider_key, request.byte_length_hint)
            .map_err(|detail| {
                attachment_refused(
                    &request.provider_key,
                    &format!("provider fetch refused: {detail}"),
                )
            })?;
        if bytes.len() as u64 > request.byte_length_hint {
            return Err(attachment_refused(
                &request.provider_key,
                "provider bytes exceed the closed declared byte bound",
            ));
        }
        let import_request = ImportRequest {
            import_id: import_id.clone(),
            instance_id: capability.instance_id().to_string(),
            module_id: capability.module_id().to_string(),
            activation_id: None,
            lease_token: None,
            media_kind: asset_kind_of_type(&request.declared_media_type),
            source: Source::InlineBase64 {
                base64: strict_base64_encode(&bytes),
            },
            declared_media_type: Some(
                request
                    .declared_media_type
                    .as_str()
                    .parse()
                    .map_err(|_| {
                        attachment_refused(&request.provider_key, "declared media type is invalid")
                    })?,
            ),
            remote_required: false,
            expected_byte_length: Some(bytes.len() as u64),
            deadline: wire_deadline_after(120),
        };
        match facade.import(capability, &import_request) {
            Ok(status) => Ok(map_import_status(status)),
            Err(envelope) => Err(attachment_refused(
                &request.provider_key,
                &format!("asset import refused (code {})", envelope.code),
            )),
        }
    }

    fn run_status(
        &mut self,
        request: &AttachmentImportRequest,
    ) -> Result<AttachmentImportStatus, ChannelError> {
        self.check_attachment_ownership(request)?;
        let import_id = self.import_id_for(request);
        let Some((facade, capability)) = self.facade.as_mut().zip(self.capability.as_ref())
        else {
            return Err(attachment_refused(
                &request.provider_key,
                "no Asset store/capability is bound to the Channel inbound route",
            ));
        };
        let status_request = AssetStatusRequest::new(
            import_id.clone(),
            capability.module_id().to_string(),
            import_id,
            wire_deadline_after(120),
        )
        .map_err(|message| {
            attachment_refused(&request.provider_key, &format!("invalid status request: {message}"))
        })?;
        match facade.status(capability, &status_request) {
            Ok(status) => Ok(map_import_status(status)),
            Err(envelope) => Err(attachment_refused(
                &request.provider_key,
                &format!("asset status refused (code {})", envelope.code),
            )),
        }
    }
}

/// Map the Asset authority's closed status result to the Channel
/// `AttachmentImportStatus`. `Absent` is emitted only for the Asset
/// authority's exact `absent` answer (no durable import record/effect);
/// every recorded in-progress and terminal state maps to its Channel
/// equivalent and is never fabricated as `Available`.
fn map_import_status(status: StatusResult) -> AttachmentImportStatus {
    match status.state.as_str() {
        "available" => match status.asset {
            Some(reference) => {
                let asset_ref = ChannelAssetRef {
                    asset_id: match ChannelAssetId::parse(reference.asset_id.as_str()) {
                        Ok(asset_id) => asset_id,
                        Err(_) => {
                            return AttachmentImportStatus::Refused {
                                code: "NONCANONICAL_ASSET_REF".to_string(),
                            }
                        }
                    },
                    media_type: match ChannelMediaType::parse(reference.media_type.as_str()) {
                        Ok(media_type) => media_type,
                        Err(_) => {
                            return AttachmentImportStatus::Refused {
                                code: "INVALID_MEDIA_TYPE".to_string(),
                            }
                        }
                    },
                    byte_length: reference.byte_length,
                    orientation: reference.orientation,
                    encoded_width: reference.encoded_width,
                    encoded_height: reference.encoded_height,
                    display_width: reference.display_width,
                    display_height: reference.display_height,
                };
                if let Err(message) = asset_ref.validate() {
                    return AttachmentImportStatus::Refused {
                        code: format!("NONCANONICAL_ASSET_REF: {message}"),
                    };
                }
                let media_kind = channel_kind_of_type(asset_kind_of_type(&asset_ref.media_type));
                AttachmentImportStatus::Available(AvailableAttachment {
                    asset_ref,
                    media_kind,
                    view: None,
                })
            }
            None => AttachmentImportStatus::Refused {
                code: "AVAILABLE_WITHOUT_ASSET_REF".to_string(),
            },
        },
        "absent" => AttachmentImportStatus::Absent,
        "rejected" | "cancelled" => AttachmentImportStatus::Refused {
            code: status
                .error
                .as_ref()
                .and_then(|error| error.get("code"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("IMPORT_REJECTED")
                .to_string(),
        },
        _ => AttachmentImportStatus::Pending,
    }
}

impl InboundAssetImport for ChannelAttachmentImport {
    fn import(
        &mut self,
        request: &AttachmentImportRequest,
    ) -> Result<AttachmentImportStatus, ChannelError> {
        self.run_import(request)
    }

    fn status(
        &mut self,
        request: &AttachmentImportRequest,
    ) -> Result<AttachmentImportStatus, ChannelError> {
        self.run_status(request)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        bytes.extend_from_slice(&[0, 0, 0, 13]);
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        bytes.extend_from_slice(&[0u8; 24]);
        bytes
    }

    /// Deterministic bounded provider reader for tests: serves a fixed byte
    /// payload per key and records reads (bounded).
    #[derive(Default)]
    struct FakeProvider {
        payload: Option<Vec<u8>>,
    }

    impl FakeProvider {
        fn serving(bytes: Vec<u8>) -> Self {
            Self {
                payload: Some(bytes),
            }
        }
    }

    impl ProviderAttachmentReader for FakeProvider {
        fn read(&mut self, provider_key: &str, max_bytes: u64) -> Result<Vec<u8>, String> {
            let payload = self.payload.clone().ok_or_else(|| format!("no payload for {provider_key}"))?;
            if provider_key == "missing" {
                return Err("no provider object for key".to_string());
            }
            if payload.len() as u64 > max_bytes {
                return Err("provider payload exceeds the bound".to_string());
            }
            Ok(payload)
        }
    }

    fn config_at(root: &std::path::Path) -> ResolvedAssetConfig {
        let mut config = ResolvedAssetConfig::with_local_root(root.to_path_buf());
        config.max_decoded_bytes = 64 * 1024;
        config.max_inline_base64_chars = 128 * 1024;
        config.max_image_pixels = 1_000_000;
        config.gc_grace_ms = 60_000;
        config
    }

    fn import_request(id: &str, bytes: &[u8]) -> ImportRequest {
        ImportRequest {
            import_id: id.to_string(),
            instance_id: "instance-a".to_string(),
            module_id: "module-a".to_string(),
            activation_id: None,
            lease_token: None,
            media_kind: MediaKind::Image,
            source: Source::InlineBase64 {
                base64: strict_base64_encode(bytes),
            },
            declared_media_type: Some("image/png".parse().expect("valid type")),
            remote_required: false,
            expected_byte_length: Some(bytes.len() as u64),
            deadline: "2026-08-09T15:00:00.000000Z".to_string(),
        }
    }

    fn import_available(root: &std::path::Path, id: &str, bytes: &[u8]) -> (AssetService, AssetCapability, String) {
        let mut service = AssetService::open(config_at(root)).expect("asset service");
        let capability = service.issue_capability("domain-a", "instance-a", "module-a");
        let imported = service
            .import(&capability, &import_request(id, bytes))
            .expect("import succeeds");
        assert_eq!(imported.state, "available", "import must be available");
        let asset_id = imported
            .asset
            .expect("asset ref")
            .asset_id
            .as_str()
            .to_string();
        (service, capability, asset_id)
    }

    #[test]
    fn outbound_seam_prepares_media_field_for_field_under_a_lease() {
        let dir = tempfile::tempdir().expect("tempdir");
        let png = png_bytes(4, 2);
        let (service, capability, asset_id) =
            import_available(dir.path(), "0198ab31-6c44-7e8a-b2bb-000000000001", &png);
        let mut seam = ChannelAssetSeam::for_test(service, capability, "test-owner");

        let premise = AssetPremise {
            ordinal: 0,
            asset_id: ChannelAssetId::parse(&asset_id).expect("canonical id"),
            media_type: ChannelMediaType::parse("image/png").expect("canonical type"),
            view: None,
        };
        let payloads = seam.prepare_assets(&[premise]).expect("prepare succeeds");
        assert_eq!(payloads.len(), 1, "one payload per premise");
        let payload = &payloads[0];
        // Field-for-field authoritative identity: the exact committed
        // content-addressed AssetId and detected media type.
        assert_eq!(payload.asset_ref.asset_id.as_str(), asset_id);
        assert_eq!(payload.asset_ref.media_type.as_str(), "image/png");
        assert_eq!(payload.asset_ref.byte_length, png.len() as u64);
        assert_eq!(payload.media_kind, ChannelMediaKind::Image);
        assert_eq!(payload.bytes, png, "verified immutable bytes");
        assert_eq!(payload.generation, 1, "current generation holds the lease");
        assert!(
            payload.lease_id.len() >= 32 && payload.lease_id != asset_id,
            "un-guessable finite lease token"
        );
        assert!(payload.lease_expiry_unix_ms > now_unix_millis());
        // Durable proof is exactly the payload minus the ephemeral bytes.
        let proof = payload.lease_proof();
        assert_eq!(proof.asset_ref, payload.asset_ref);
        assert_eq!(proof.digest.digest, payload.digest.digest);
    }

    #[test]
    fn outbound_seam_fails_closed_on_unavailable_and_unbound_assets() {
        let dir = tempfile::tempdir().expect("tempdir");
        let png = png_bytes(4, 2);
        let (service, capability, asset_id) =
            import_available(dir.path(), "0198ab31-6c44-7e8a-b2bb-000000000002", &png);

        let premise = |asset: &str| AssetPremise {
            ordinal: 0,
            asset_id: ChannelAssetId::parse(asset).expect("canonical id"),
            media_type: ChannelMediaType::parse("image/png").expect("canonical type"),
            view: None,
        };

        // A never-imported but canonical id is refused by the asset authority
        // with the Channel asset code and no path disclosure.
        let forged = "ast_b3_".to_string() + &"a".repeat(52);
        let mut seam = ChannelAssetSeam::for_test(service, capability.clone(), "test-owner");
        let refused = seam.prepare_assets(&[premise(&forged)]);
        match refused {
            Err(error) => {
                assert_eq!(error.code, codes::ASSET_IMPORT_FAILED);
                assert_eq!(error.outcome, ChannelOutcome::NotApplied);
                let root = dir.path().to_str().unwrap();
                assert!(
                    !error.message.contains(root),
                    "the content root must never leak into the error surface"
                );
            }
            Ok(_) => panic!("unavailable asset must fail closed"),
        }

        // A foreign-domain capability cannot prepare the identical AVAILABLE
        // asset: the lease/authority is domain-bound.
        let service = seam.take_service();
        let foreign = service.issue_capability("other-domain", "instance-a", "module-a");
        let mut foreign_seam =
            ChannelAssetSeam::for_test(service, foreign, "test-owner");
        let cross_domain = foreign_seam.prepare_assets(&[premise(&asset_id)]);
        match cross_domain {
            Err(error) => {
                assert_eq!(error.code, codes::ASSET_IMPORT_FAILED);
                assert_eq!(error.outcome, ChannelOutcome::NotApplied);
            }
            Ok(_) => panic!("cross-domain lease must fail closed"),
        }
    }

    #[test]
    fn unbound_outbound_seam_fails_closed_with_an_asset_code() {
        let mut seam = ChannelAssetSeam::unbound();
        let premise = AssetPremise {
            ordinal: 0,
            asset_id: ChannelAssetId::parse(
                &("ast_b3_".to_string() + &"a".repeat(52)),
            )
            .expect("canonical id"),
            media_type: ChannelMediaType::parse("image/png").expect("canonical type"),
            view: None,
        };
        let err = seam.prepare_assets(&[premise]).expect_err("unbound refuses");
        assert_eq!(err.code, codes::ASSET_IMPORT_FAILED);
        assert_eq!(err.outcome, ChannelOutcome::NotApplied);
        assert!(seam.prepare_assets(&[]).unwrap().is_empty(), "no premises -> no work");
    }

    #[test]
    fn inbound_seam_imports_available_and_reports_absent_for_unknown_keys() {
        let dir = tempfile::tempdir().expect("tempdir");
        let png = png_bytes(4, 2);
        let facade = AssetHostFacade::open(config_at(dir.path())).expect("facade");
        let capability = facade.issue_capability("domain-a", "instance-a", "module-a");
        let mut seam = ChannelAttachmentImport::for_test(
            facade,
            capability.clone(),
            "account-a",
            Box::new(FakeProvider::serving(png.clone())),
        );

        let request = AttachmentImportRequest::new("account-a", "evt-1", &dolly_channel::attachment::InboundAttachment {
            ordinal: 0,
            provider_key: "provider-blob-1".to_string(),
            media_kind: ChannelMediaKind::Image,
            declared_media_type: ChannelMediaType::parse("image/png").expect("type"),
            byte_length_hint: png.len() as u64,
        });
        match seam.import(&request).expect("import runs") {
            AttachmentImportStatus::Available(available) => {
                assert_eq!(available.asset_ref.media_type.as_str(), "image/png");
                assert_eq!(available.asset_ref.byte_length, png.len() as u64);
                assert_eq!(available.media_kind, ChannelMediaKind::Image);
            }
            other => panic!("expected Available, got {other:?}"),
        }
        // Authoritative absent only for a key with no durable import record.
        let unknown = AttachmentImportRequest::new("account-a", "nope", &dolly_channel::attachment::InboundAttachment {
            ordinal: 1,
            provider_key: "never-imported".to_string(),
            media_kind: ChannelMediaKind::Image,
            declared_media_type: ChannelMediaType::parse("image/png").expect("type"),
            byte_length_hint: 4,
        });
        match seam.status(&unknown).expect("status runs") {
            AttachmentImportStatus::Absent => {}
            other => panic!("expected Absent, got {other:?}"),
        }
    }


    #[test]
    fn inbound_seam_refuses_foreign_account_and_missing_provider_before_import() {
        let dir = tempfile::tempdir().expect("tempdir");
        let png = png_bytes(4, 2);
        let facade = AssetHostFacade::open(config_at(dir.path())).expect("facade");
        let capability = facade.issue_capability("domain-a", "instance-a", "module-a");
        let mut seam = ChannelAttachmentImport::for_test(
            facade,
            capability.clone(),
            "account-a",
            Box::new(FakeProvider::serving(png.clone())),
        );

        // A key scoped to a different account is refused before any provider
        // read or Asset call (mismatch rejection, exact-key/domain binding).
        let foreign = AttachmentImportRequest::new(
            "account-b",
            "evt-f",
            &dolly_channel::attachment::InboundAttachment {
                ordinal: 0,
                provider_key: "provider-foreign".to_string(),
                media_kind: ChannelMediaKind::Image,
                declared_media_type: ChannelMediaType::parse("image/png").expect("type"),
                byte_length_hint: png.len() as u64,
            },
        );
        let err = seam.import(&foreign).expect_err("foreign account must refuse");
        assert_eq!(err.code, codes::ASSET_IMPORT_FAILED);
        assert_eq!(err.outcome, ChannelOutcome::NotApplied);
        // No provider read happened and no durable import record exists.
        let err = seam.status(&foreign).expect_err("foreign account must refuse status");
        assert_eq!(err.code, codes::ASSET_IMPORT_FAILED);

        // A provider that cannot serve the authenticated key fails closed
        // before any Asset record, with zero duplicate effect.
        let mut on_missing = ChannelAttachmentImport::for_test(
            AssetHostFacade::open(config_at(dir.path())).expect("facade"),
            capability.clone(),
            "account-a",
            Box::new(FakeProvider::default()),
        );
        let missing = AttachmentImportRequest::new(
            "account-a",
            "evt-m",
            &dolly_channel::attachment::InboundAttachment {
                ordinal: 0,
                provider_key: "missing".to_string(),
                media_kind: ChannelMediaKind::Image,
                declared_media_type: ChannelMediaType::parse("image/png").expect("type"),
                byte_length_hint: png.len() as u64,
            },
        );
        let err = on_missing.import(&missing).expect_err("missing provider object must refuse");
        assert_eq!(err.code, codes::ASSET_IMPORT_FAILED);
    }

    #[test]
    fn unbound_inbound_seam_fails_closed_with_an_asset_code() {
        let mut seam = ChannelAttachmentImport::unbound();
        let request = AttachmentImportRequest::new(
            "account-a",
            "evt-x",
            &dolly_channel::attachment::InboundAttachment {
                ordinal: 0,
                provider_key: "k".to_string(),
                media_kind: ChannelMediaKind::Image,
                declared_media_type: ChannelMediaType::parse("image/png").expect("type"),
                byte_length_hint: 4,
            },
        );
        let err = seam.import(&request).expect_err("unbound refuses");
        assert_eq!(err.code, codes::ASSET_IMPORT_FAILED);
        assert_eq!(err.outcome, ChannelOutcome::NotApplied);
        let err = seam.status(&request).expect_err("unbound refuses status");
        assert_eq!(err.code, codes::ASSET_IMPORT_FAILED);
    }
}
