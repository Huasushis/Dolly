//! Pure crop materialization (imported vector `TST-ASSET-001`, requirement
//! `REQ-ASSET-001`, specification section "Normalized crop semantics").
//!
//! Terms, defined in plain language at first use:
//!
//! - The "normalized crop rectangle" (`image_rect_v1`) is an integer
//!   fixed-point rectangle on a `0..=1_000_000` grid in upright display
//!   space. Its origin is the top-left corner, its right/bottom edges are
//!   exclusive, and any valid rectangle satisfies `x0 < x1` and `y0 < y1`.
//!   The division scale (`CROP_NORMALIZED_SCALE`) is exactly `1_000_000`.
//! - "Display dimensions" (`DisplaySize`) are the width and height in pixels
//!   of the upright image after the EXIF orientation transform is applied.
//!   The wire record exposes them directly (as `display_width` and
//!   `display_height`); the module also derives them from encoded width and
//!   height by swapping the axes for orientations 5 through 8, exactly as
//!   the specification states ("display_width and display_height therefore
//!   swap for orientations 5 through 8").
//! - "Materialized bounds" (`MaterializedBounds`) are the integer pixel
//!   rectangle `{left, top, right, bottom}` that results from rounding the
//!   normalized rectangle onto the display: `left = floor(x0*W/1e6)`,
//!   `top = floor(y0*H/1e6)`, `right = ceil(x1*W/1e6)`,
//!   `bottom = ceil(y1*H/1e6)`, then clamped to `[0,W]` and `[0,H]`.
//!
//! Precedence (fixed and documented): `INVALID_ORIENTATION` (orientation
//! authority) precedes `INVALID_CROP` (display dimensions, then crop
//! coordinates) which precedes `EMPTY_CROP` (the materialized-bounds guard).
//! `REQ-ASSET-001` requires the empty guard, so it exists even though the
//! `exhaustive` proof in the tests shows it cannot fire for any crop the
//! module accepts on any positive display: `ceil(x1*W/1e6) > floor(x0*W/1e6)`
//! because the fractional arguments differ by at least `W/1e6 > 0`, so the
//! bounds always span at least one pixel. It is the pipeline's fail-closed
//! safety net for a downstream decoder whose bounds differ from the module's
//! validated display premise, never a fake error of this module.
//!
//! This is a pure, deterministic consumer: it never writes metadata, never
//! mutates the crop or the display, and its bounds/errors are never an
//! authority that rewrites the source. Cross-asset or stale (dual-direction)
//! premises are rejected at the boundary — the crop carries no dimensions
//! and the display carries no crop.

use serde::{Deserialize, Serialize};

/// The fixed-point division scale of a normalized crop rectangle. Every
/// coordinate is an integer in `0..=1_000_000`; the wire record calls this
/// scale only implicitly.
pub const CROP_NORMALIZED_SCALE: u64 = 1_000_000;

/// The largest supported display dimension: the safe JSON integer ceiling
/// `9007199254740991` (`2^53 - 1`) shared with every other Dolly integer
/// domain. Multiplications above this ceiling are rejected as
/// `INVALID_CROP` before any arithmetic, and within it all intermediates are
/// computed in `u128` so the largest product `1_000_000 *
/// 9_007_199_254_740_991 ≈ 9e21` stays far below `u128::MAX ≈ 3.4e38`.
pub const MAX_SUPPORTED_DIMENSION: u64 = 9_007_199_254_740_991;

/// The `kind` discriminator of the `image_rect_v1` wire shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ImageRectV1Kind;

impl Serialize for ImageRectV1Kind {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str("image_rect_v1")
    }
}

impl<'de> Deserialize<'de> for ImageRectV1Kind {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value == "image_rect_v1" {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom(format!(
                "expected kind \"image_rect_v1\", got \"{value}\""
            )))
        }
    }
}

/// A normalized crop rectangle with the exact `image_rect_v1` wire shape.
///
/// The type is closed: `kind` is fixed and unknown JSON fields are refused.
/// Coordinates are raw integers, matching the spec's JSON shape; validity
/// (`kind`, range, order) is enforced fail-closed on every entry path —
/// deserialization (`try_from_value`), construction (`new`), and again at
/// materialization — so an invalid premise can never materialize.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CropRect {
    kind: ImageRectV1Kind,
    x0: u64,
    y0: u64,
    x1: u64,
    y1: u64,
}

impl CropRect {
    /// Validates and constructs a crop rectangle. A coordinate outside
    /// `0..=1_000_000` or a rectangle with `x0 >= x1` or `y0 >= y1` (inverted
    /// or zero-area) is `INVALID_CROP`; a successful value is always a valid,
    /// materializable premise.
    pub fn new(x0: u64, y0: u64, x1: u64, y1: u64) -> Result<Self, CropError> {
        check_normalized_bounds("x0", x0, CROP_NORMALIZED_SCALE)?;
        check_normalized_bounds("y0", y0, CROP_NORMALIZED_SCALE)?;
        check_normalized_bounds("x1", x1, CROP_NORMALIZED_SCALE)?;
        check_normalized_bounds("y1", y1, CROP_NORMALIZED_SCALE)?;
        if x0 >= x1 {
            return Err(CropError::invalid_crop(format!(
                "x0 ({x0}) must be less than x1 ({x1})"
            )));
        }
        if y0 >= y1 {
            return Err(CropError::invalid_crop(format!(
                "y0 ({y0}) must be less than y1 ({y1})"
            )));
        }
        Ok(Self {
            kind: ImageRectV1Kind,
            x0,
            y0,
            x1,
            y1,
        })
    }

    /// Parses a wire-shaped JSON crop rectangle, `INVALID_CROP` on any
    /// malformed, unknown-field, or out-of-range input. The kind tag must be
    /// `image_rect_v1`.
    pub fn try_from_value(value: &serde_json::Value) -> Result<Self, CropError> {
        serde_json::from_value(value.clone()).map_err(|error| {
            CropError::invalid_crop(format!("invalid crop rectangle JSON: {error}"))
        })
    }

    /// The left normalized coordinate (in `0..=1_000_000`).
    pub fn x0(&self) -> u64 {
        self.x0
    }
    /// The top normalized coordinate (in `0..=1_000_000`).
    pub fn y0(&self) -> u64 {
        self.y0
    }
    /// The right normalized coordinate (in `0..=1_000_000`).
    pub fn x1(&self) -> u64 {
        self.x1
    }
    /// The bottom normalized coordinate (in `0..=1_000_000`).
    pub fn y1(&self) -> u64 {
        self.y1
    }

    /// The deterministic materialized-bounds consumer: it maps this
    /// normalized rectangle onto a display size with exact integer
    /// arithmetic. Revalidates every premise fail-closed before
    /// computing, and never mutates self or the display.
    pub fn materialize(&self, display: &DisplaySize) -> Result<MaterializedBounds, CropError> {
        // Revalidation keeps the module fail-closed even if a caller
        // constructed the struct from a corrupt wire shape by other means.
        check_display_dimension("width", display.width(), MAX_SUPPORTED_DIMENSION)?;
        check_display_dimension("height", display.height(), MAX_SUPPORTED_DIMENSION)?;
        check_normalized_bounds("x0", self.x0, CROP_NORMALIZED_SCALE)?;
        check_normalized_bounds("y0", self.y0, CROP_NORMALIZED_SCALE)?;
        check_normalized_bounds("x1", self.x1, CROP_NORMALIZED_SCALE)?;
        check_normalized_bounds("y1", self.y1, CROP_NORMALIZED_SCALE)?;
        if self.x0() >= self.x1() {
            return Err(CropError::invalid_crop(format!(
                "x0 ({}) must be less than x1 ({})",
                self.x0(),
                self.x1()
            )));
        }
        if self.y0() >= self.y1() {
            return Err(CropError::invalid_crop(format!(
                "y0 ({}) must be less than y1 ({})",
                self.y0(),
                self.y1()
            )));
        }
        let width = display.width();
        let height = display.height();
        let left = clamp_axis(floor_scale_edge(self.x0(), width), width);
        let top = clamp_axis(floor_scale_edge(self.y0(), height), height);
        let right = clamp_axis(ceil_scale_edge(self.x1(), width), width);
        let bottom = clamp_axis(ceil_scale_edge(self.y1(), height), height);
        let bounds = MaterializedBounds {
            left,
            top,
            right,
            bottom,
        };
        if bounds.right() <= bounds.left() || bounds.bottom() <= bounds.top() {
            return Err(CropError::empty_crop(format!(
                "crop became empty after decoder bounds checks on \
                 {width}x{height}: {self:?}"
            )));
        }
        Ok(bounds)
    }

    /// The wire `kind` value, `"image_rect_v1"`.
    pub fn wire_kind(&self) -> &'static str {
        "image_rect_v1"
    }
}

/// `coord * W / 1_000_000` floored, computed in `u128` so the intermediate
/// product cannot overflow. The result is at most `W`, hence fits `u64`.
fn floor_scale_edge(coord: u64, dimension: u64) -> u64 {
    let numerator = u128::from(coord) * u128::from(dimension);
    (numerator / u128::from(CROP_NORMALIZED_SCALE)) as u64
}

/// `coord * W / 1_000_000` ceiled, computed in `u128` so the intermediate
/// product cannot overflow. The result is at most `W + something`, and the
/// caller clamps it to `W`; the raw value can be `W + (W+1e6-2)/1e6`, so it
/// stays safely within `u64` for the supported `MAX_SUPPORTED_DIMENSION`.
fn ceil_scale_edge(coord: u64, dimension: u64) -> u64 {
    let numerator = u128::from(coord) * u128::from(dimension);
    let denominator = u128::from(CROP_NORMALIZED_SCALE);
    ((numerator + denominator - 1) / denominator) as u64
}

/// Clamps an edge into `[0, limit]`; left/top results are already in range
/// and right/bottom can exceed `W` by less than one scaled unit.
fn clamp_axis(edge: u64, limit: u64) -> u64 {
    edge.min(limit)
}

fn check_normalized_bounds(field: &str, value: u64, max: u64) -> Result<(), CropError> {
    if value > max {
        return Err(CropError::invalid_crop(format!(
            "{field} ({value}) must be in 0..={max}"
        )));
    }
    Ok(())
}

fn check_display_dimension(field: &str, value: u64, max: u64) -> Result<(), CropError> {
    if value == 0 {
        return Err(CropError::invalid_crop(format!(
            "{field} must be positive, got 0"
        )));
    }
    if value > max {
        return Err(CropError::invalid_crop(format!(
            "{field} ({value}) exceeds supported maximum {max}"
        )));
    }
    Ok(())
}

/// Display width and height in upright pixel space (the frame that crop
/// coordinates are materialized onto). Both must be positive and at most
/// `MAX_SUPPORTED_DIMENSION`, enforced at construction. A caller that only
/// has encoded (pre-transform) dimensions derives the upright display size
/// through `ExifOrientation::display_size`; this type is the result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DisplaySize {
    width: u64,
    height: u64,
}

impl DisplaySize {
    /// Validates coordinates: both dimensions positive and at most
    /// `MAX_SUPPORTED_DIMENSION`. An invalid display is `INVALID_CROP`.
    pub fn new(width: u64, height: u64) -> Result<Self, CropError> {
        check_display_dimension("width", width, MAX_SUPPORTED_DIMENSION)?;
        check_display_dimension("height", height, MAX_SUPPORTED_DIMENSION)?;
        Ok(Self { width, height })
    }

    /// Upright display width in pixels.
    pub fn width(&self) -> u64 {
        self.width
    }
    /// Upright display height in pixels.
    pub fn height(&self) -> u64 {
        self.height
    }
}

/// An EXIF orientation value, exactly the integers `1..=8`. Missing
/// orientation means `1`; any other value is `INVALID_ORIENTATION`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct ExifOrientation(u8);

impl ExifOrientation {
    /// Validates that a value is an EXIF orientation (`1..=8`).
    pub fn new(value: u8) -> Result<Self, CropError> {
        if value < 1 || value > 8 {
            return Err(CropError::invalid_orientation(format!(
                "EXIF orientation must be in 1..=8, got {value}"
            )));
        }
        Ok(Self(value))
    }

    /// The raw orientation integer, in `1..=8`.
    pub fn value(self) -> u8 {
        self.0
    }

    /// Whether the orientation transform swaps axes (orientations 5 through
    /// 8) in the encoded-to-display dimension mapping.
    pub fn requires_swap(self) -> bool {
        matches!(self.0, 5..=8)
    }

    /// Upright display dimensions derived from encoded (pre-transform)
    /// dimensions: identity for orientations 1-4, axis swap for 5-8, per the
    /// specification. The encoded dimensions must be positive and at most
    /// `MAX_SUPPORTED_DIMENSION` (`INVALID_CROP` otherwise).
    pub fn display_size(
        self,
        encoded_width: u64,
        encoded_height: u64,
    ) -> Result<DisplaySize, CropError> {
        if self.requires_swap() {
            DisplaySize::new(encoded_height, encoded_width)
        } else {
            DisplaySize::new(encoded_width, encoded_height)
        }
    }
}

/// Integer pixel bounds into one image: left/top inclusive, right/bottom
/// exclusive. Produced only by materialization; the module never mutates the
/// crop or display while producing it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterializedBounds {
    left: u64,
    top: u64,
    right: u64,
    bottom: u64,
}

impl MaterializedBounds {
    /// Inclusive left pixel column.
    pub fn left(&self) -> u64 {
        self.left
    }
    /// Inclusive top pixel row.
    pub fn top(&self) -> u64 {
        self.top
    }
    /// Exclusive right pixel column (one past the rightmost included pixel).
    pub fn right(&self) -> u64 {
        self.right
    }
    /// Exclusive bottom pixel row (one past the bottommost included pixel).
    pub fn bottom(&self) -> u64 {
        self.bottom
    }
}

/// The stable public error codes of the crop materialization module.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, thiserror::Error)]
pub enum CropErrorCode {
    /// A non-EXIF orientation value (outside `1..=8`).
    #[error("INVALID_ORIENTATION")]
    InvalidOrientation,
    /// An invalid display dimension (zero/over-limit) or an invalid crop
    /// rectangle (out-of-range, inverted, or zero-area coordinates).
    #[error("INVALID_CROP")]
    InvalidCrop,
    /// The crop became empty after decoder bounds checks. Invariant for any
    /// crop the module accepts on any positive display; retained as the
    /// authority-required guard for the decoder-bounds pipeline path.
    #[error("EMPTY_CROP")]
    EmptyCrop,
}

impl CropErrorCode {
    /// The normative wire string, matching `REQ-ASSET-001` and
    /// `TST-ASSET-001` (the asset service stable codes).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidOrientation => "INVALID_ORIENTATION",
            Self::InvalidCrop => "INVALID_CROP",
            Self::EmptyCrop => "EMPTY_CROP",
        }
    }
}

/// A typed materialization failure: stable `code` plus a human-readable
/// message. The codes and their precedence follow the accepted reference.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{code}: {message}")]
pub struct CropError {
    /// The stable public error code.
    pub code: CropErrorCode,
    /// Specific premise that failed (not part of the stable wire contract).
    pub message: String,
}

impl CropError {
    fn invalid_crop(message: String) -> Self {
        Self {
            code: CropErrorCode::InvalidCrop,
            message,
        }
    }
    fn empty_crop(message: String) -> Self {
        Self {
            code: CropErrorCode::EmptyCrop,
            message,
        }
    }
    fn invalid_orientation(message: String) -> Self {
        Self {
            code: CropErrorCode::InvalidOrientation,
            message,
        }
    }

    /// The stable public error code.
    pub fn code(&self) -> CropErrorCode {
        self.code
    }
}

/// Single-entry entrypoint that replicates the vector's premise direction:
/// source asset authority (display dimensions + EXIF orientation) then the
/// validated normalized crop, producing materialized bounds. Fails closed in
/// fixed precedence — `INVALID_ORIENTATION` (orientation), `INVALID_CROP`
/// (display dimensions, then crop coordinates), finally `EMPTY_CROP` (only
/// the decoder-bounds guard) — and never mutates the crop.
pub fn materialize_crop_bounds(
    crop: &CropRect,
    display_width: u64,
    display_height: u64,
    orientation: u8,
) -> Result<MaterializedBounds, CropError> {
    ExifOrientation::new(orientation)?;
    let display = DisplaySize::new(display_width, display_height)?;
    crop.materialize(&display)
}
