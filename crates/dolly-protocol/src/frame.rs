//! Bounded frame codec for the Dolly Extension wire protocol (v1).
//!
//! A frame is exactly four octets of big-endian unsigned length followed by
//! that many octets of UTF-8 JSON. A zero length, a length above the current
//! limit, end-of-stream in the header, end-of-stream before the declared
//! payload bytes arrive, and bytes after a decoded frame that cannot begin
//! another valid frame are all fatal framing violations: the receiver MUST
//! close the connection and MUST NOT attempt to resynchronize on the same
//! transport stream.

use std::fmt;

/// Bootstrap maximum frame length in bytes before initialization.
pub const BOOTSTRAP_MAX_FRAME_BYTES: u32 = 1_048_576;
/// v1 Host default maximum frame length in bytes after negotiation.
pub const DEFAULT_MAX_FRAME_BYTES: u32 = 4_194_304;
/// Hard ceiling for complete-frame nesting depth (a negotiated depth may be
/// lower, never higher).
pub const FRAME_NESTING_HARD_LIMIT: u16 = 96;
/// Hard ceiling for semantic payload nesting depth.
pub const SEMANTIC_DEPTH_HARD_LIMIT: u16 = 64;

/// Error constructing [`FrameLimits`] from out-of-contract values.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrameLimitsError(pub String);

impl fmt::Display for FrameLimitsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for FrameLimitsError {}

/// Configured wire limits for a protocol connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameLimits {
    max_frame_bytes: u32,
    max_frame_nesting_depth: u16,
    semantic_payload_depth_limit: u16,
}

impl FrameLimits {
    /// Validates the limits against the hard ceilings: bytes >= 1, frame
    /// depth in `1..=FRAME_NESTING_HARD_LIMIT`, semantic depth in
    /// `1..=SEMANTIC_DEPTH_HARD_LIMIT`.
    pub fn new(
        max_frame_bytes: u32,
        max_frame_nesting_depth: u16,
        semantic_payload_depth_limit: u16,
    ) -> Result<Self, FrameLimitsError> {
        if max_frame_bytes == 0 {
            return Err(FrameLimitsError(
                "max_frame_bytes must be at least 1".into(),
            ));
        }
        if !(1..=FRAME_NESTING_HARD_LIMIT).contains(&max_frame_nesting_depth) {
            return Err(FrameLimitsError(format!(
                "max_frame_nesting_depth must be in 1..={FRAME_NESTING_HARD_LIMIT}"
            )));
        }
        if !(1..=SEMANTIC_DEPTH_HARD_LIMIT).contains(&semantic_payload_depth_limit) {
            return Err(FrameLimitsError(format!(
                "semantic_payload_depth_limit must be in 1..={SEMANTIC_DEPTH_HARD_LIMIT}"
            )));
        }
        Ok(Self {
            max_frame_bytes,
            max_frame_nesting_depth,
            semantic_payload_depth_limit,
        })
    }

    /// Bootstrap limits before initialization: 1 MiB frames, 96 frame levels,
    /// 64 semantic levels.
    pub fn bootstrap() -> Self {
        Self {
            max_frame_bytes: BOOTSTRAP_MAX_FRAME_BYTES,
            max_frame_nesting_depth: FRAME_NESTING_HARD_LIMIT,
            semantic_payload_depth_limit: SEMANTIC_DEPTH_HARD_LIMIT,
        }
    }

    /// v1 Host default negotiated limits: 4 MiB frames, 96 frame levels,
    /// 64 semantic levels.
    pub fn defaults() -> Self {
        Self {
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES,
            max_frame_nesting_depth: FRAME_NESTING_HARD_LIMIT,
            semantic_payload_depth_limit: SEMANTIC_DEPTH_HARD_LIMIT,
        }
    }

    pub const fn max_frame_bytes(&self) -> u32 {
        self.max_frame_bytes
    }

    pub const fn max_frame_nesting_depth(&self) -> u16 {
        self.max_frame_nesting_depth
    }

    pub const fn semantic_payload_depth_limit(&self) -> u16 {
        self.semantic_payload_depth_limit
    }
}

/// Fatal framing violations.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FrameError {
    /// A four-octet big-endian length of zero.
    ZeroLength,
    /// A declared length above the current limit.
    Oversize { declared: u32, limit: u32 },
    /// End of stream with 1..=3 header octets outstanding.
    EofInHeader { outstanding: usize },
    /// End of stream before all declared payload bytes arrived.
    EofInPayload { declared: u32, received: usize },
    /// Bytes after a decoded frame that cannot begin another frame.
    TrailingInvalidBytes { outstanding: usize },
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FrameError::ZeroLength => write!(f, "zero frame length is invalid"),
            FrameError::Oversize { declared, limit } => {
                write!(f, "frame length {declared} exceeds limit {limit}")
            }
            FrameError::EofInHeader { outstanding } => {
                write!(
                    f,
                    "end of stream in four-octet header ({outstanding} octets outstanding)"
                )
            }
            FrameError::EofInPayload { declared, received } => write!(
                f,
                "end of stream before payload arrived: declared {declared}, received {received}"
            ),
            FrameError::TrailingInvalidBytes { outstanding } => write!(
                f,
                "{outstanding} bytes after a frame cannot begin another valid frame"
            ),
        }
    }
}

impl std::error::Error for FrameError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Header,
    Payload,
}

/// Incremental frame reader: accepts arbitrary-size chunks (fragmentation and
/// multiple frames per chunk) and yields each complete frame payload once its
/// declared bytes have all arrived. After a fatal violation the reader is
/// latched; every further call returns the same error.
#[derive(Debug)]
pub struct FrameReader {
    limits: FrameLimits,
    buffer: Vec<u8>,
    declared: u32,
    phase: Phase,
    frames_seen: u64,
    fatal: Option<FrameError>,
}

impl FrameReader {
    pub fn new(limits: FrameLimits) -> Self {
        Self {
            limits,
            buffer: Vec::new(),
            declared: 0,
            phase: Phase::Header,
            frames_seen: 0,
            fatal: None,
        }
    }

    pub fn is_fatal(&self) -> bool {
        self.fatal.is_some()
    }

    pub fn fatal_error(&self) -> Option<&FrameError> {
        self.fatal.as_ref()
    }

    /// Feeds bytes, returning the payload of every frame completed by this
    /// call. An `Err` is a fatal framing violation that latches the reader.
    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<Vec<u8>>, FrameError> {
        if let Some(ref err) = self.fatal {
            return Err(err.clone());
        }
        self.buffer.extend_from_slice(bytes);
        let mut frames = Vec::new();
        loop {
            if let Some(ref err) = self.fatal {
                return Err(err.clone());
            }
            match self.phase {
                Phase::Header => {
                    if self.buffer.len() < 4 {
                        break;
                    }
                    let header: [u8; 4] = self.buffer[..4].try_into().expect("len checked");
                    self.buffer.drain(..4);
                    let length = u32::from_be_bytes(header);
                    if length == 0 {
                        self.fatal = Some(FrameError::ZeroLength);
                        return Err(self.fatal.clone().expect("just set"));
                    }
                    if length > self.limits.max_frame_bytes {
                        self.fatal = Some(FrameError::Oversize {
                            declared: length,
                            limit: self.limits.max_frame_bytes,
                        });
                        return Err(self.fatal.clone().expect("just set"));
                    }
                    self.declared = length;
                    self.phase = Phase::Payload;
                }
                Phase::Payload => {
                    if (self.buffer.len() as u64) < self.declared as u64 {
                        break;
                    }
                    let payload = self.buffer.drain(..self.declared as usize).collect();
                    self.frames_seen += 1;
                    frames.push(payload);
                    self.phase = Phase::Header;
                }
            }
        }
        Ok(frames)
    }

    /// Signals end of stream. Remaining bytes that cannot form a complete
    /// frame (partial header or partial payload, possibly trailing a decoded
    /// frame) become a fatal framing violation.
    pub fn finish(self) -> Result<(), FrameError> {
        if let Some(ref err) = self.fatal {
            return Err(err.clone());
        }
        match self.phase {
            Phase::Header if !self.buffer.is_empty() => {
                let err = if self.frames_seen > 0 {
                    FrameError::TrailingInvalidBytes {
                        outstanding: self.buffer.len(),
                    }
                } else {
                    FrameError::EofInHeader {
                        outstanding: self.buffer.len(),
                    }
                };
                Err(err)
            }
            Phase::Payload => Err(FrameError::EofInPayload {
                declared: self.declared,
                received: self.buffer.len(),
            }),
            Phase::Header => Ok(()),
        }
    }
}

/// Builds a single framed message: four-octet big-endian length + payload.
pub fn encode_frame(payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

/// Whether a candidate generation's effective frame bounds satisfy the
/// Manifest's required frame bounds without exceeding the 96-level ceiling
/// (TST-PROTO-003; `INV-ACTIVATION-010`, `INV-RAM-014`).
pub fn frame_bounds_compatible(
    max_frame_bytes: u32,
    max_frame_nesting_depth: u16,
    required_frame_bytes: u32,
    required_frame_nesting_depth: u16,
) -> bool {
    required_frame_bytes <= max_frame_bytes
        && required_frame_nesting_depth <= max_frame_nesting_depth
        && max_frame_nesting_depth <= FRAME_NESTING_HARD_LIMIT
        && required_frame_nesting_depth <= FRAME_NESTING_HARD_LIMIT
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunked(reader: &mut FrameReader, bytes: &[u8], width: usize) -> Vec<Vec<u8>> {
        let mut all = Vec::new();
        let mut i = 0;
        while i < bytes.len() {
            let end = (i + width).min(bytes.len());
            all.extend(reader.feed(&bytes[i..end]).unwrap());
            i = end;
        }
        all
    }

    #[test]
    fn fragmented_and_multiple_frames() {
        let payload_a = br#"{"jsonrpc":"2.0","id":"a","method":"extension.ping","params":{}}"#;
        let payload_b = br#"{"jsonrpc":"2.0","id":"b","method":"extension.notify"}"#;
        let mut frame = encode_frame(payload_a);
        frame.extend_from_slice(&encode_frame(payload_b));
        let mut reader = FrameReader::new(FrameLimits::defaults());
        let frames = chunked(&mut reader, &frame, 7);
        assert!(reader.finish().is_ok());
        assert_eq!(frames, vec![payload_a.to_vec(), payload_b.to_vec()]);
    }

    #[test]
    fn empty_stream_is_clean() {
        let reader = FrameReader::new(FrameLimits::defaults());
        assert!(reader.finish().is_ok());
    }

    #[test]
    fn zero_length_is_fatal() {
        let mut reader = FrameReader::new(FrameLimits::defaults());
        let err = reader.feed(&[0, 0, 0, 0]).unwrap_err();
        assert_eq!(err, FrameError::ZeroLength);
        assert!(reader.feed(&[1, 2, 3]).is_err(), "reader is latched");
    }

    #[test]
    fn oversize_is_fatal() {
        let limits = FrameLimits::new(16, 96, 64).unwrap();
        let mut reader = FrameReader::new(limits);
        let err = reader.feed(&[0, 0, 0, 17]).unwrap_err();
        assert_eq!(
            err,
            FrameError::Oversize {
                declared: 17,
                limit: 16
            }
        );
    }

    #[test]
    fn eof_in_header_is_fatal() {
        let mut reader = FrameReader::new(FrameLimits::defaults());
        reader.feed(&[0, 0, 0]).unwrap();
        let err = reader.finish().unwrap_err();
        assert_eq!(err, FrameError::EofInHeader { outstanding: 3 });
    }

    #[test]
    fn eof_in_payload_is_fatal() {
        let mut reader = FrameReader::new(FrameLimits::defaults());
        reader.feed(&[0, 0, 0, 5, b'{']).unwrap();
        let err = reader.finish().unwrap_err();
        assert_eq!(
            err,
            FrameError::EofInPayload {
                declared: 5,
                received: 1
            }
        );
    }

    #[test]
    fn trailing_invalid_bytes_after_frame_is_fatal() {
        let mut reader = FrameReader::new(FrameLimits::defaults());
        let payload = br#"{"jsonrpc":"2.0","id":"a","method":"extension.ping"}"#;
        let mut frame = encode_frame(payload);
        frame.extend_from_slice(&[0xDE, 0xAD]);
        reader.feed(&frame).unwrap();
        let err = reader.finish().unwrap_err();
        assert_eq!(err, FrameError::TrailingInvalidBytes { outstanding: 2 });
    }

    #[test]
    fn configured_max_frame_bytes_boundary() {
        let limits = FrameLimits::new(4, 96, 64).unwrap();
        let mut reader = FrameReader::new(limits);
        // exactly at the limit
        reader.feed(&[0, 0, 0, 4, b'1', b'2', b'3', b'4']).unwrap();
        // one over the limit is fatal oversize
        let err = reader.feed(&[0, 0, 0, 5]).unwrap_err();
        assert_eq!(
            err,
            FrameError::Oversize {
                declared: 5,
                limit: 4
            }
        );
    }
}
