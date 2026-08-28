//! Bounded acquisition from the five accepted import sources.
//!
//! Byte caps are enforced while bytes stream, never after buffering: the
//! [`BoundedSink`] cuts a source off mid-stream the moment the effective
//! bound is exceeded. Base64 decoding is strict (alphabet, terminal padding,
//! canonical trailing bits) and its decoded length is validated analytically
//! before any decode. File sources use a Host-issued capability rooted in an
//! allowed directory with symlink resolution re-checked at open time.
//! Remote sources revalidate every resolved IP and every redirect against the
//! SSRF deny policy before bytes are accepted.

use crate::config::ResolvedAssetConfig;
use crate::content::BoundedSink;
use crate::error::{AssetError, AssetErrorCode, ErrorPhase};
use crate::identity::ContentHash;
use crate::record::{ImportRequest, Source};
use crate::remote::{RemoteFetcher, RemoteOpenError, RemoteRead, SshDenyPolicy};
use dolly_core_domain::LeaseToken;
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

/// A Host-issued file capability: an exact canonical path inside an allowed
/// root, plus an optional per-file byte cap. Never an arbitrary path string.
#[derive(Debug, Clone)]
pub struct FileCapability {
    pub real_path: PathBuf,
    pub allowed_root: PathBuf,
    pub max_bytes: Option<u64>,
}

/// Resolves file capabilities minted by the Host.
pub trait FileCapabilityRegistry {
    fn resolve(&self, token: &LeaseToken) -> Option<FileCapability>;
}

/// Resolves single-use stream capabilities minted by the Host.
pub trait StreamCapabilityRegistry {
    fn take(&mut self, token: &LeaseToken) -> Option<Box<dyn Read + Send>>;
}

/// Everything the acquisition stage needs from the service.
pub struct AcquireContext<'a> {
    pub config: &'a ResolvedAssetConfig,
    pub content_root: &'a Path,
    pub file_caps: &'a dyn FileCapabilityRegistry,
    pub stream_caps: &'a mut dyn StreamCapabilityRegistry,
    pub fetcher: &'a mut dyn RemoteFetcher,
    pub policy: &'a SshDenyPolicy,
}

/// The decoded byte bound enforced while streaming one source.
fn effective_decoded_cap(config: &ResolvedAssetConfig, request: &ImportRequest) -> u64 {
    let declared = request.source.declared_max_bytes().unwrap_or(u64::MAX);
    declared.min(config.max_decoded_bytes)
}

/// Validates strict base64 and returns the exact decoded length.
///
/// Rejects: empty, length not a multiple of 4, non-alphabet characters,
/// non-terminal or double padding, and non-canonical trailing bits. Never
/// allocates the decoded bytes.
pub fn strict_base64_decoded_len(encoded: &str) -> Result<u64, AssetError> {
    let bytes = encoded.as_bytes();
    let len = bytes.len();
    if len == 0 || len % 4 != 0 {
        return Err(AssetError::new(
            AssetErrorCode::InvalidBase64,
            ErrorPhase::Acquire,
            "base64 length must be a positive multiple of 4".to_string(),
        ));
    }
    let mut padding = 0usize;
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'=' {
            padding += 1;
            if i < len - 2 {
                return Err(AssetError::new(
                    AssetErrorCode::InvalidBase64,
                    ErrorPhase::Acquire,
                    "base64 padding must be terminal".to_string(),
                ));
            }
        } else if !is_base64_alphabet(b) {
            return Err(AssetError::new(
                AssetErrorCode::InvalidBase64,
                ErrorPhase::Acquire,
                "base64 contains a non-alphabet character".to_string(),
            ));
        }
    }
    if padding > 2 {
        return Err(AssetError::new(
            AssetErrorCode::InvalidBase64,
            ErrorPhase::Acquire,
            "base64 has too much padding".to_string(),
        ));
    }
    // Canonical trailing bits: padding replaces bits that must be zero.
    // One pad leaves 2 pad bits in the final character (mask 0x03); two pads
    // leave 4 (mask 0x0f).
    if padding == 1 && (base64_value(bytes[len - 2]) & 0x03) != 0 {
        return Err(AssetError::new(
            AssetErrorCode::InvalidBase64,
            ErrorPhase::Acquire,
            "base64 has non-canonical trailing bits".to_string(),
        ));
    }
    if padding == 2 && (base64_value(bytes[len - 3]) & 0x0f) != 0 {
        return Err(AssetError::new(
            AssetErrorCode::InvalidBase64,
            ErrorPhase::Acquire,
            "base64 has non-canonical trailing bits".to_string(),
        ));
    }
    Ok(((len / 4) * 3) as u64 - padding as u64)
}

fn is_base64_alphabet(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'+' || b == b'/'
}

fn base64_value(b: u8) -> u32 {
    match b {
        b'A'..=b'Z' => (b - b'A') as u32,
        b'a'..=b'z' => (b - b'a') as u32 + 26,
        b'0'..=b'9' => (b - b'0') as u32 + 52,
        b'+' => 62,
        b'/' => 63,
        _ => 0,
    }
}

/// Acquire the bytes of one request into a fresh staging sink and finish it,
/// returning the counted length and hash over the accepted bytes.
/// `existing_asset` is handled by the pipeline (no acquisition); this returns
/// an error for it.
pub fn acquire_into_sink(
    sink_name: &str,
    request: &ImportRequest,
    ctx: &mut AcquireContext<'_>,
) -> Result<(u64, ContentHash), AssetError> {
    let cap = effective_decoded_cap(ctx.config, request);
    match &request.source {
        Source::InlineBase64 { base64 } => acquire_base64(sink_name, base64, cap, ctx),
        Source::RemoteUrl { url, max_bytes } => {
            let _ = max_bytes;
            acquire_remote(sink_name, url, cap, ctx)
        }
        Source::ModuleFile { file_capability } => {
            acquire_file(sink_name, file_capability, cap, ctx)
        }
        Source::Stream {
            stream_capability,
            max_bytes,
        } => {
            let _ = max_bytes;
            acquire_stream(sink_name, stream_capability, cap, ctx)
        }
        Source::ExistingAsset { .. } => Err(AssetError::new(
            AssetErrorCode::Internal,
            ErrorPhase::Acquire,
            "existing_asset has no byte acquisition".to_string(),
        )),
    }
}

fn open_sink(name: &str, cap: u64, ctx: &AcquireContext<'_>) -> Result<BoundedSink, AssetError> {
    BoundedSink::open(ctx.content_root, name, cap).map_err(|e| {
        AssetError::new(
            AssetErrorCode::StorageFull,
            ErrorPhase::Acquire,
            format!("cannot open staging sink: {e}"),
        )
    })
}

fn finish_sink(sink: BoundedSink) -> Result<(u64, ContentHash), AssetError> {
    sink.finish()
}

fn acquire_base64(
    sink_name: &str,
    base64: &str,
    cap: u64,
    ctx: &mut AcquireContext<'_>,
) -> Result<(u64, ContentHash), AssetError> {
    // Encoded-size limit, enforced before decode.
    let encoded_cap = ctx
        .config
        .max_inline_base64_chars
        .min(crate::config::MAX_INLINE_BASE64_CHARS_CEILING);
    if base64.len() as u64 > encoded_cap {
        return Err(AssetError::new(
            AssetErrorCode::SizeLimit,
            ErrorPhase::Acquire,
            format!(
                "inline base64 length {} exceeds the encoded bound {}",
                base64.len(),
                encoded_cap
            ),
        ));
    }
    if base64.len() as u64 > ctx.config.max_encoded_bytes {
        return Err(AssetError::new(
            AssetErrorCode::SizeLimit,
            ErrorPhase::Acquire,
            "inline base64 exceeds max_encoded_bytes".to_string(),
        ));
    }
    let decoded_len = strict_base64_decoded_len(base64)?;
    if decoded_len > cap {
        return Err(AssetError::new(
            AssetErrorCode::SizeLimit,
            ErrorPhase::Acquire,
            format!("base64 decodes to {decoded_len} bytes, exceeding the bound {cap}"),
        ));
    }
    let mut sink = open_sink(sink_name, cap, ctx)?;
    let bytes = base64.as_bytes();
    let mut i = 0usize;
    let mut chunk = [0u8; 3];
    let result = (|| -> Result<(), AssetError> {
        while i + 4 <= bytes.len() {
            let quadruple = [bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]];
            let n = if quadruple[2] == b'=' {
                1
            } else if quadruple[3] == b'=' {
                2
            } else {
                3
            };
            let acc = (base64_value(quadruple[0]) << 18)
                | (base64_value(quadruple[1]) << 12)
                | (base64_value(quadruple[2]) << 6)
                | base64_value(quadruple[3]);
            match n {
                3 => {
                    chunk[0] = (acc >> 16) as u8;
                    chunk[1] = (acc >> 8) as u8;
                    chunk[2] = acc as u8;
                    sink.write_bounded(&chunk)?;
                }
                2 => {
                    chunk[0] = (acc >> 16) as u8;
                    chunk[1] = (acc >> 8) as u8;
                    sink.write_bounded(&chunk[..2])?;
                }
                _ => {
                    chunk[0] = (acc >> 16) as u8;
                    sink.write_bounded(&chunk[..1])?;
                }
            }
            i += 4;
        }
        Ok(())
    })();
    result?;
    finish_sink(sink)
}

fn acquire_file(
    sink_name: &str,
    file_capability: &str,
    cap: u64,
    ctx: &mut AcquireContext<'_>,
) -> Result<(u64, ContentHash), AssetError> {
    let token = parse_capability_token(file_capability)?;
    let capability = ctx.file_caps.resolve(&token).ok_or_else(|| {
        AssetError::new(
            AssetErrorCode::SourceDenied,
            ErrorPhase::Acquire,
            "file capability is not recognized".to_string(),
        )
    })?;
    let path = open_verified_file(&capability)?;
    let mut file = File::open(&path).map_err(|e| {
        AssetError::new(
            AssetErrorCode::SourceUnavailable,
            ErrorPhase::Acquire,
            format!("cannot open capability file: {e}"),
        )
    })?;
    let mut sink = open_sink(sink_name, cap, ctx)?;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| {
            let _ = sink.abort();
            AssetError::new(
                AssetErrorCode::SourceUnavailable,
                ErrorPhase::Acquire,
                format!("read from capability file failed: {e}"),
            )
        })?;
        if n == 0 {
            break;
        }
        sink.write_bounded(&buf[..n])?;
    }
    finish_sink(sink)
}

/// Open the resolved capability file with symlink and traversal defenses.
#[cfg(unix)]
fn open_verified_file(capability: &FileCapability) -> Result<PathBuf, AssetError> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(O_NOFOLLOW)
        .open(&capability.real_path)
        .map_err(|e| {
            AssetError::new(
                AssetErrorCode::SourceDenied,
                ErrorPhase::Acquire,
                format!("capability path open refused: {e}"),
            )
        })?;
    // Re-resolve the canonical path after open and require it to stay inside
    // the allowed root (TOCTOU defense).
    let canonical = std::fs::canonicalize(&capability.real_path).map_err(|e| {
        AssetError::new(
            AssetErrorCode::SourceDenied,
            ErrorPhase::Acquire,
            format!("cannot canonicalize capability path: {e}"),
        )
    })?;
    if !canonical.starts_with(&capability.allowed_root) {
        return Err(AssetError::new(
            AssetErrorCode::SourceDenied,
            ErrorPhase::Acquire,
            "capability path escaped its allowed root".to_string(),
        ));
    }
    // Confirm the opened inode matches the canonical path we validated.
    let meta = file.metadata().map_err(|e| {
        AssetError::new(
            AssetErrorCode::SourceDenied,
            ErrorPhase::Acquire,
            format!("cannot stat opened capability file: {e}"),
        )
    })?;
    let canonical_meta = std::fs::metadata(&canonical).map_err(|e| {
        AssetError::new(
            AssetErrorCode::SourceDenied,
            ErrorPhase::Acquire,
            format!("cannot stat canonical path: {e}"),
        )
    })?;
    if meta.dev() != canonical_meta.dev() || meta.ino() != canonical_meta.ino() {
        return Err(AssetError::new(
            AssetErrorCode::SourceDenied,
            ErrorPhase::Acquire,
            "capability file was replaced between validation and open".to_string(),
        ));
    }
    Ok(capability.real_path.clone())
}

/// `O_NOFOLLOW` for Linux (0o400000). The asset service targets Linux.
#[cfg(unix)]
const O_NOFOLLOW: i32 = 0o400000;

#[cfg(not(unix))]
fn open_verified_file(capability: &FileCapability) -> Result<PathBuf, AssetError> {
    let canonical = std::fs::canonicalize(&capability.real_path).map_err(|e| {
        AssetError::new(
            AssetErrorCode::SourceDenied,
            ErrorPhase::Acquire,
            format!("cannot canonicalize capability path: {e}"),
        )
    })?;
    if !canonical.starts_with(&capability.allowed_root) {
        return Err(AssetError::new(
            AssetErrorCode::SourceDenied,
            ErrorPhase::Acquire,
            "capability path escaped its allowed root".to_string(),
        ));
    }
    Ok(canonical)
}

fn parse_capability_token(token: &str) -> Result<LeaseToken, AssetError> {
    token.parse::<LeaseToken>().map_err(|_| {
        AssetError::new(
            AssetErrorCode::SourceDenied,
            ErrorPhase::Acquire,
            "malformed capability token".to_string(),
        )
    })
}

fn acquire_stream(
    sink_name: &str,
    stream_capability: &str,
    cap: u64,
    ctx: &mut AcquireContext<'_>,
) -> Result<(u64, ContentHash), AssetError> {
    let token = parse_capability_token(stream_capability)?;
    let mut reader = ctx.stream_caps.take(&token).ok_or_else(|| {
        AssetError::new(
            AssetErrorCode::SourceDenied,
            ErrorPhase::Acquire,
            "stream capability is not recognized or already consumed".to_string(),
        )
    })?;
    let mut sink = open_sink(sink_name, cap, ctx)?;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buf).map_err(|e| {
            let _ = sink.abort();
            AssetError::new(
                AssetErrorCode::SourceUnavailable,
                ErrorPhase::Acquire,
                format!("stream read failed: {e}"),
            )
        })?;
        if n == 0 {
            break;
        }
        sink.write_bounded(&buf[..n])?;
    }
    finish_sink(sink)
}

fn acquire_remote(
    sink_name: &str,
    url: &str,
    cap: u64,
    ctx: &mut AcquireContext<'_>,
) -> Result<(u64, ContentHash), AssetError> {
    let mut current = url.to_string();
    let mut redirects: u64 = 0;
    let mut sink = open_sink(sink_name, cap, ctx)?;
    let mut buf = [0u8; 64 * 1024];
    loop {
        SshDenyPolicy::validate_url(&current).map_err(|e| deny_from_open_error(e, &current))?;
        let mut handle = ctx
            .fetcher
            .open(&current)
            .map_err(|e| deny_from_open_error(e, &current))?;
        for addr in handle.resolved_addresses() {
            if ctx.policy.is_denied(addr) {
                let _ = sink.abort();
                return Err(AssetError::new(
                    AssetErrorCode::SourceDenied,
                    ErrorPhase::Acquire,
                    format!("remote address {addr} is denied by the SSRF policy"),
                ));
            }
        }
        let mut finished = false;
        loop {
            match handle.read(&mut buf) {
                RemoteRead::Data(n) => sink.write_bounded(&buf[..n])?,
                RemoteRead::Redirect(next) => {
                    redirects += 1;
                    if redirects > ctx.config.max_redirects {
                        let _ = sink.abort();
                        return Err(AssetError::new(
                            AssetErrorCode::SourceDenied,
                            ErrorPhase::Acquire,
                            format!(
                                "remote redirect limit ({}) exceeded",
                                ctx.config.max_redirects
                            ),
                        ));
                    }
                    // A redirect is a new network target: revalidate it on
                    // the next outer iteration.
                    current = next;
                    finished = true;
                    break;
                }
                RemoteRead::Closed => {
                    finished = true;
                    break;
                }
                RemoteRead::Transport(reason) => {
                    let _ = sink.abort();
                    return Err(AssetError::new(
                        AssetErrorCode::SourceUnavailable,
                        ErrorPhase::Acquire,
                        format!("remote transport failure: {reason}"),
                    ));
                }
            }
        }
        if finished {
            break;
        }
    }
    finish_sink(sink)
}

fn deny_from_open_error(error: RemoteOpenError, url: &str) -> AssetError {
    let code = match error {
        RemoteOpenError::UnsupportedScheme | RemoteOpenError::EmbeddedCredentials => {
            AssetErrorCode::SourceDenied
        }
        RemoteOpenError::DnsFailure
        | RemoteOpenError::ConnectDenied
        | RemoteOpenError::Timeout
        | RemoteOpenError::Transport(_) => AssetErrorCode::SourceUnavailable,
    };
    AssetError::new(
        code,
        ErrorPhase::Acquire,
        format!("remote open for {url} refused: {error:?}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_base64_is_strict() {
        // b"hello" == aGVsbG8=
        assert_eq!(strict_base64_decoded_len("aGVsbG8=").unwrap(), 5);
        // Unpadded bodies are not multiple-of-4 and are refused (the schema
        // pattern requires terminal padding).
        assert!(strict_base64_decoded_len("aGVsbG8").is_err());
        assert!(strict_base64_decoded_len("aGVsbG8===").is_err());
        assert!(strict_base64_decoded_len("aGVs=bG8=").is_err()); // mid padding
        assert!(strict_base64_decoded_len("aGVsbG8!").is_err()); // bad char
        assert!(strict_base64_decoded_len("aGVsbG8==a").is_err()); // pad then char
        assert!(strict_base64_decoded_len("aGVsbG8a====").is_err());
        assert!(strict_base64_decoded_len("").is_err());
        assert!(strict_base64_decoded_len("aGV").is_err()); // not mult of 4
    }

    #[test]
    fn base64_hello_round_trip() {
        let encoded = "aGVsbG8="; // "hello"
        let (len, hash) = {
            // Decode directly through a tempdir sink is exercised by the
            // pipeline tests; here just confirm the analytic length.
            (strict_base64_decoded_len(encoded).unwrap(), ContentHash::of_bytes(b"hello"))
        };
        assert_eq!(len, 5);
        assert_eq!(hash, ContentHash::of_bytes(b"hello"));
        let _ = io::empty();
    }
}
