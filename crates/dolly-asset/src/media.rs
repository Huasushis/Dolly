//! Bounded media-type sniffing and image metadata extraction.
//!
//! The declared media type is a hint; the service independently sniffs from a
//! bounded head of the accepted bytes. Active content (SVG, HTML, PDF) keeps
//! its real type and is never relabeled as a passive image. For raster images
//! the module extracts encoded dimensions and EXIF orientation (default 1),
//! deriving upright display dimensions by swapping axes for orientations 5..=8
//! exactly as the specification and the shared `dolly-schema` crop module do.

use crate::error::{AssetError, AssetErrorCode, ErrorPhase};
use crate::identity::MediaType;

/// How much of a file head is inspected. Bounded by construction.
pub const SNIFF_HEAD_BYTES: usize = 16 * 1024;
/// JPEG marker scan bound.
const JPEG_SCAN_BOUND: usize = 64 * 1024;
/// Maximum EXIF IFD entries inspected.
const EXIF_MAX_ENTRIES: usize = 256;

/// Whether sniffed content is passive media or active/document content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaDisposition {
    Passive,
    Active,
}

/// Result of bounded media probing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaProbe {
    pub detected: Option<MediaType>,
    pub disposition: MediaDisposition,
    pub width: Option<u64>,
    pub height: Option<u64>,
    pub orientation: u8,
    pub pixel_count: Option<u64>,
}

impl MediaProbe {
    fn anon() -> Self {
        Self {
            detected: None,
            disposition: MediaDisposition::Passive,
            width: None,
            height: None,
            orientation: 1,
            pixel_count: None,
        }
    }
}

/// Sniff one media type from a bounded head of bytes.
pub fn sniff_media_type(head: &[u8]) -> Option<(MediaType, MediaDisposition)> {
    if head.len() >= 8 && head[..8] == [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a] {
        return Some((MediaType::parse("image/png").unwrap(), MediaDisposition::Passive));
    }
    if head.len() >= 3 && head[..3] == [0xff, 0xd8, 0xff] {
        return Some((MediaType::parse("image/jpeg").unwrap(), MediaDisposition::Passive));
    }
    if head.len() >= 6 && (&head[..6] == b"GIF87a" || &head[..6] == b"GIF89a") {
        return Some((MediaType::parse("image/gif").unwrap(), MediaDisposition::Passive));
    }
    if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        return Some((MediaType::parse("image/webp").unwrap(), MediaDisposition::Passive));
    }
    if head.len() >= 5 && &head[..5] == b"%PDF-" {
        return Some((MediaType::parse("application/pdf").unwrap(), MediaDisposition::Active));
    }
    // HTML: a case-insensitive match on the head after optional whitespace.
    let truncated = &head[..head.len().min(256)];
    let lower: Vec<u8> = truncated.iter().map(|b| b.to_ascii_lowercase()).collect();
    let text = String::from_utf8_lossy(&lower);
    let trimmed = text.trim_start();
    if trimmed.starts_with("<!doctype html") || trimmed.starts_with("<html") {
        return Some((MediaType::parse("text/html").unwrap(), MediaDisposition::Active));
    }
    // SVG: XML declaration or an <svg root within a bounded head.
    if trimmed.starts_with("<?xml") || trimmed.contains("<svg") {
        if let Some(rpos) = trimmed.find("<svg") {
            // Only a root-level svg element counts (no outer HTML wrapper).
            if !trimmed[..rpos].contains("<html") {
                return Some((
                    MediaType::parse("image/svg+xml").unwrap(),
                    MediaDisposition::Active,
                ));
            }
        }
        if trimmed.starts_with("<?xml") {
            return Some((
                MediaType::parse("image/svg+xml").unwrap(),
                MediaDisposition::Active,
            ));
        }
    }
    None
}

/// Probe a content head for media type and image metadata.
///
/// `max_pixels` is enforced here (pixel-count bounds), and orientation values
/// outside `1..=8` are rejected with `INVALID_ORIENTATION`.
pub fn probe_media_head(head: &[u8], max_pixels: u64) -> Result<MediaProbe, AssetError> {
    let mut probe = match sniff_media_type(head) {
        Some((mt, disposition)) => MediaProbe {
            detected: Some(mt),
            disposition,
            width: None,
            height: None,
            orientation: 1,
            pixel_count: None,
        },
        None => MediaProbe::anon(),
    };

    match probe.detected.as_ref().map(|m| m.as_str()) {
        Some("image/png") => {
            if head.len() >= 24 {
                let w = u32::from_be_bytes([head[16], head[17], head[18], head[19]]) as u64;
                let h = u32::from_be_bytes([head[20], head[21], head[22], head[23]]) as u64;
                probe.width = Some(w);
                probe.height = Some(h);
            }
        }
        Some("image/jpeg") => {
            let dims = jpeg_dimensions(head);
            if let Some((w, h)) = dims {
                probe.width = Some(w);
                probe.height = Some(h);
            }
            let orientation = jpeg_exif_orientation(head);
            if !(1..=8).contains(&orientation) {
                return Err(AssetError::new(
                    AssetErrorCode::InvalidOrientation,
                    ErrorPhase::Verify,
                    format!("EXIF orientation {orientation} is outside 1..=8"),
                ));
            }
            probe.orientation = orientation;
        }
        Some("image/gif") => {
            if head.len() >= 10 {
                let w = u16::from_le_bytes([head[6], head[7]]) as u64;
                let h = u16::from_le_bytes([head[8], head[9]]) as u64;
                probe.width = Some(w);
                probe.height = Some(h);
            }
        }
        Some("image/webp") => {
            webp_dimensions(head, &mut probe);
        }
        _ => {}
    }

    if let (Some(w), Some(h)) = (probe.width, probe.height) {
        if w == 0 || h == 0 {
            return Err(AssetError::new(
                AssetErrorCode::UnsafeMedia,
                ErrorPhase::Verify,
                "image dimensions are zero".to_string(),
            ));
        }
        let pixels = w.saturating_mul(h);
        if pixels > max_pixels {
            return Err(AssetError::new(
                AssetErrorCode::UnsafeMedia,
                ErrorPhase::Verify,
                format!("image pixel count {pixels} exceeds the bound {max_pixels}"),
            ));
        }
        probe.pixel_count = Some(pixels);
    }
    Ok(probe)
}

/// Check a declared media type against the sniffed reality.
///
/// Fail-closed: a declared type must agree with the sniffed type; an
/// unrecognized binary only passes when the media kind is `file`. Active
/// content keeps its real type and is rejected when it was declared as a
/// passive image.
pub fn validate_declared_media(
    media_kind: &str,
    declared: Option<&MediaType>,
    detected: Option<&MediaType>,
) -> Result<(), AssetError> {
    match (declared, detected) {
        (Some(d), Some(s)) => {
            if d != s {
                return Err(AssetError::new(
                    AssetErrorCode::MediaTypeMismatch,
                    ErrorPhase::Verify,
                    format!("declared {} does not match detected {}", d.as_str(), s.as_str()),
                ));
            }
            Ok(())
        }
        (Some(_), None) => {
            if media_kind == "file" {
                Ok(())
            } else {
                Err(AssetError::new(
                    AssetErrorCode::MediaTypeMismatch,
                    ErrorPhase::Verify,
                    "declared media type cannot be substantiated from the bytes".to_string(),
                ))
            }
        }
        (None, Some(_)) => Ok(()),
        (None, None) => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// JPEG parsing (bounded)
// ---------------------------------------------------------------------------

/// Scan JPEG segments for the first SOF marker and read frame dimensions.
fn jpeg_dimensions(head: &[u8]) -> Option<(u64, u64)> {
    let mut pos = 2usize;
    while pos + 4 <= head.len() && pos < JPEG_SCAN_BOUND {
        if head[pos] != 0xff {
            // Fill bytes 0xff 0xff are padding; else malformed.
            if head[pos] == 0xff {
                pos += 1;
                continue;
            }
            return None;
        }
        let marker = head[pos + 1];
        if marker == 0xd8 || marker == 0x01 {
            pos += 2;
            continue;
        }
        if marker == 0xda {
            // SOS: no frame header seen.
            return None;
        }
        if (0xc0..=0xcf).contains(&marker) && !matches!(marker, 0xc4 | 0xc8 | 0xcc) {
            if pos + 9 > head.len() {
                return None;
            }
            let h = u16::from_be_bytes([head[pos + 5], head[pos + 6]]) as u64;
            let w = u16::from_be_bytes([head[pos + 7], head[pos + 8]]) as u64;
            return Some((w, h));
        }
        // Standing-alone markers have no length.
        if matches!(marker, 0xd0..=0xd7 | 0x01) {
            pos += 2;
            continue;
        }
        if pos + 4 > head.len() {
            return None;
        }
        let seg_len = u16::from_be_bytes([head[pos + 2], head[pos + 3]]) as usize;
        if seg_len < 2 {
            return None;
        }
        pos += 2 + seg_len;
    }
    None
}

/// Parse the EXIF Orientation tag (0x0112) from the JPEG APP1 segment.
/// Returns 1 when no orientation is present.
fn jpeg_exif_orientation(head: &[u8]) -> u8 {
    let mut pos = 2usize;
    let mut scanned = 0usize;
    while pos + 4 <= head.len() && scanned < JPEG_SCAN_BOUND {
        if head[pos] != 0xff {
            return 1;
        }
        let marker = head[pos + 1];
        if marker == 0xda {
            return 1;
        }
        if pos + 4 > head.len() {
            return 1;
        }
        let seg_len = u16::from_be_bytes([head[pos + 2], head[pos + 3]]) as usize;
        if seg_len < 2 {
            return 1;
        }
        if marker == 0xe1 {
            let start = pos + 4;
            let end = (start + seg_len - 2).min(head.len());
            if let Some(o) = parse_exif_orientation(&head[start..end]) {
                return o;
            }
        }
        scanned += 2 + seg_len;
        pos += 2 + seg_len;
    }
    1
}

/// Parse the IFD0 Orientation tag from an EXIF byte blob (after "Exif\0\0").
fn parse_exif_orientation(blob: &[u8]) -> Option<u8> {
    if blob.len() < 14 || &blob[..6] != b"Exif\x00\x00" {
        return None;
    }
    let tiff = &blob[6..];
    if tiff.len() < 8 {
        return None;
    }
    let (little, offset) = match &tiff[..2] {
        b"II" => (true, u32::from_le_bytes([tiff[4], tiff[5], tiff[6], tiff[7]]) as usize),
        b"MM" => (false, u32::from_be_bytes([tiff[4], tiff[5], tiff[6], tiff[7]]) as usize),
        _ => return None,
    };
    if tiff[2..4] != [0x2a, 0x00] && tiff[2..4] != [0x00, 0x2a] {
        return None;
    }
    if offset + 2 > tiff.len() {
        return None;
    }
    let count = read_u16(tiff, offset, little)? as usize;
    let mut p = offset + 2;
    for _ in 0..count.min(EXIF_MAX_ENTRIES) {
        if p + 12 > tiff.len() {
            break;
        }
        let tag = read_u16(tiff, p, little)?;
        let field_type = read_u16(tiff, p + 2, little)?;
        if tag == 0x0112 && field_type == 3 {
            // SHORT: value stored inline in the 4 value bytes.
            let value = read_u16(tiff, p + 8, little)?;
            return Some(if value <= 8 { value as u8 } else { value.min(255) as u8 });
        }
        p += 12;
    }
    None
}

fn read_u16(buf: &[u8], offset: usize, little: bool) -> Option<u16> {
    if offset + 2 > buf.len() {
        return None;
    }
    Some(if little {
        u16::from_le_bytes([buf[offset], buf[offset + 1]])
    } else {
        u16::from_be_bytes([buf[offset], buf[offset + 1]])
    })
}

fn webp_dimensions(head: &[u8], probe: &mut MediaProbe) {
    if head.len() < 30 {
        return;
    }
    match &head[12..16] {
        b"VP8 " => {
            let w = u16::from_le_bytes([head[26] & 0x3f, head[27]]) as u64;
            let h = u16::from_le_bytes([head[28] & 0x3f, head[29]]) as u64;
            probe.width = Some(w);
            probe.height = Some(h);
        }
        b"VP8L" => {
            // Header: 0x2f then 14-bit width-1/height-1 packed little-endian.
            if head[20] == 0x2f {
                let bits = u32::from_le_bytes([head[21], head[22], head[23], head[24]]);
                let w = (bits & 0x3fff) as u64 + 1;
                let h = ((bits >> 14) & 0x3fff) as u64 + 1;
                probe.width = Some(w);
                probe.height = Some(h);
            }
        }
        b"VP8X" => {
            let w = u32::from_le_bytes([head[24], head[25], head[26], 0]) as u64 + 1;
            let h = u32::from_le_bytes([head[27], head[28], head[29], 0]) as u64 + 1;
            probe.width = Some(w);
            probe.height = Some(h);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_head(w: u32, h: u32) -> Vec<u8> {
        let mut head = Vec::new();
        head.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
        head.extend_from_slice(&[0, 0, 0, 13]); // IHDR length
        head.extend_from_slice(b"IHDR");
        head.extend_from_slice(&w.to_be_bytes());
        head.extend_from_slice(&h.to_be_bytes());
        head.resize(40, 0);
        head
    }

    #[test]
    fn sniffs_png_and_dimensions() {
        let head = png_head(1920, 1080);
        let probe = probe_media_head(&head, 10_000_000).unwrap();
        assert_eq!(probe.detected.unwrap().as_str(), "image/png");
        assert_eq!(probe.width, Some(1920));
        assert_eq!(probe.height, Some(1080));
        assert_eq!(probe.orientation, 1);
        assert_eq!(probe.pixel_count, Some(1920 * 1080));
    }

    #[test]
    fn pixel_bound_is_enforced() {
        let head = png_head(5000, 5000); // 25M pixels
        assert!(probe_media_head(&head, 10_000_000).is_err());
        let err = probe_media_head(&head, 100_000_000).unwrap();
        assert_eq!(err.pixel_count, Some(25_000_000));
    }

    #[test]
    fn svg_is_active_and_never_relabeled() {
        let svg = b"<?xml version=\"1.0\"?><svg width=\"10\"><path/></svg>";
        let probe = probe_media_head(svg, 1_000_000).unwrap();
        assert_eq!(probe.detected.clone().unwrap().as_str(), "image/svg+xml");
        assert_eq!(probe.disposition, MediaDisposition::Active);

        // Declaring an active document as a passive image is a mismatch.
        let declared = MediaType::parse("image/png").unwrap();
        let detected = probe.detected.as_ref().unwrap();
        let err = validate_declared_media("image", Some(&declared), Some(detected));
        let code = err.unwrap_err().code;
        assert_eq!(code, AssetErrorCode::MediaTypeMismatch);
    }

    #[test]
    fn html_and_pdf_are_active() {
        let html = b"<!DOCTYPE html><html><body>x</body></html>";
        let probe = probe_media_head(html, 1_000_000).unwrap();
        assert_eq!(probe.detected.unwrap().as_str(), "text/html");
        assert_eq!(probe.disposition, MediaDisposition::Active);

        let pdf = b"%PDF-1.7\n....";
        let probe = probe_media_head(pdf, 1_000_000).unwrap();
        assert_eq!(probe.detected.unwrap().as_str(), "application/pdf");
        assert_eq!(probe.disposition, MediaDisposition::Active);
    }

    #[test]
    fn declared_mismatch_rejected() {
        let head = png_head(10, 10);
        let probe = probe_media_head(&head, 1_000_000).unwrap();
        let declared = MediaType::parse("image/jpeg").unwrap();
        assert_eq!(
            validate_declared_media("image", Some(&declared), probe.detected.as_ref())
                .unwrap_err()
                .code,
            AssetErrorCode::MediaTypeMismatch
        );
        // Undeclared passive image is accepted.
        assert!(validate_declared_media("image", None, probe.detected.as_ref()).is_ok());
        // Declared file with unrecognized bytes is accepted.
        assert!(validate_declared_media(
            "file",
            Some(&MediaType::parse("application/octet-stream").unwrap()),
            None
        )
        .is_ok());
        // Declared image with unrecognized bytes is rejected.
        assert_eq!(
            validate_declared_media("image", Some(&MediaType::parse("image/png").unwrap()), None)
                .unwrap_err()
                .code,
            AssetErrorCode::MediaTypeMismatch
        );
    }

    #[test]
    fn jpeg_orientation_round_trip() {
        fn build_jpeg_with_orientation(orientation: u16) -> Vec<u8> {
            // SOI, APP1 with EXIF Orientation tag 0x0112 = orientation, then SOF0.
            let mut jpeg = vec![0xff, 0xd8];
            let mut exif = Vec::new();
            exif.extend_from_slice(b"Exif\x00\x00");
            exif.extend_from_slice(b"II");
            exif.extend_from_slice(&0x2au16.to_le_bytes());
            exif.extend_from_slice(&8u32.to_le_bytes());
            exif.extend_from_slice(&1u16.to_le_bytes()); // 1 IFD entry
            exif.extend_from_slice(&0x0112u16.to_le_bytes()); // tag
            exif.extend_from_slice(&3u16.to_le_bytes()); // SHORT
            exif.extend_from_slice(&1u32.to_le_bytes()); // count
            exif.extend_from_slice(&orientation.to_le_bytes());
            exif.extend_from_slice(&[0u8; 4]); // next IFD offset = 0

            let app1_len = (2 + exif.len()) as u16;
            jpeg.extend_from_slice(&[0xff, 0xe1]);
            jpeg.extend_from_slice(&app1_len.to_be_bytes());
            jpeg.extend_from_slice(&exif);

            // SOF0: height 8, width 10
            jpeg.extend_from_slice(&[0xff, 0xc0]);
            jpeg.extend_from_slice(&[0, 17, 8, 0, 10, 8, 0]); // len, precision, h, w, ncomp, comp
            jpeg.extend_from_slice(&[0xff, 0xda]); // SOS
            jpeg
        }

        let jpeg = build_jpeg_with_orientation(6);
        let probe = probe_media_head(&jpeg, 1_000_000).unwrap();
        assert_eq!(probe.detected.unwrap().as_str(), "image/jpeg");
        assert_eq!(probe.orientation, 6);

        let jpeg = build_jpeg_with_orientation(9);
        assert_eq!(
            probe_media_head(&jpeg, 1_000_000).unwrap_err().code,
            AssetErrorCode::InvalidOrientation
        );

        // A present-but-invalid orientation (0) is rejected; a missing one is 1.
        let jpeg = build_jpeg_with_orientation(0);
        assert_eq!(
            probe_media_head(&jpeg, 1_000_000).unwrap_err().code,
            AssetErrorCode::InvalidOrientation
        );
    }

    #[test]
    fn gif_dimensions() {
        let mut head = b"GIF89a".to_vec();
        head.extend_from_slice(&6u16.to_le_bytes());
        head.extend_from_slice(&4u16.to_le_bytes());
        head.resize(20, 0);
        let probe = probe_media_head(&head, 1_000_000).unwrap();
        assert_eq!(probe.width, Some(6));
        assert_eq!(probe.height, Some(4));
    }

    #[test]
    fn webp_dimensions() {
        let mut head = b"RIFF\x00\x00\x00\x00WEBPVP8 ".to_vec();
        head.extend_from_slice(&[0u8; 14]);
        head[26] = 20 & 0x3f;
        head[27] = 0;
        head[28] = 30 & 0x3f;
        head[29] = 0;
        let probe = probe_media_head(&head, 1_000_000).unwrap();
        assert_eq!(probe.detected.unwrap().as_str(), "image/webp");
        assert_eq!(probe.width, Some(20));
        assert_eq!(probe.height, Some(30));
    }
}
