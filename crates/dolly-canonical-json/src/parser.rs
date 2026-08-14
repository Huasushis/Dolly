use crate::error::CanonicalError;
use crate::value::{CanonicalJsonObject, CanonicalJsonValue, CanonicalNumber};
use std::collections::HashSet;

/// A byte-oriented JSON parser that enforces the Dolly Core JSON profile:
///
/// - Rejects UTF-8 BOM and invalid UTF-8.
/// - Rejects duplicate object member names.
/// - Rejects escaped or literal lone UTF-16 surrogates.
/// - Rejects non-finite numbers and negative zero.
/// - Enforces a supplied nesting depth limit.
///
/// This is a custom parser, not a `serde_json::from_slice` into a map.
/// It produces a `CanonicalJsonValue` tree directly.
pub(crate) struct CoreJsonParser<'a> {
    input: &'a [u8],
    pos: usize,
    max_depth: u16,
}

impl<'a> CoreJsonParser<'a> {
    pub(crate) fn new(input: &'a [u8], max_depth: u16) -> Self {
        Self {
            input,
            pos: 0,
            max_depth,
        }
    }

    pub(crate) fn parse(mut self) -> Result<CanonicalJsonValue, CanonicalError> {
        // Reject UTF-8 BOM
        if self.input.len() >= 3
            && self.input[0] == 0xEF
            && self.input[1] == 0xBB
            && self.input[2] == 0xBF
        {
            return Err(CanonicalError::invalid_json(
                "UTF-8 byte-order mark is not permitted",
            ));
        }

        self.skip_ws()?;
        let value = self.parse_value(1)?;
        self.skip_ws()?;
        if self.pos != self.input.len() {
            return Err(CanonicalError::invalid_json(
                "trailing data after JSON value",
            ));
        }
        Ok(value)
    }

    fn peek(&self) -> Option<u8> {
        self.input.get(self.pos).copied()
    }

    fn skip_ws(&mut self) -> Result<(), CanonicalError> {
        while let Some(b' ') | Some(b'\n') | Some(b'\r') | Some(b'\t') = self.peek() {
            self.pos += 1;
        }
        Ok(())
    }

    fn parse_value(&mut self, depth: u16) -> Result<CanonicalJsonValue, CanonicalError> {
        self.skip_ws()?;
        match self.peek() {
            Some(b'{') if depth > self.max_depth => Err(CanonicalError::invalid_json(
                "JSON nesting depth limit exceeded",
            )),
            Some(b'[') if depth > self.max_depth => Err(CanonicalError::invalid_json(
                "JSON nesting depth limit exceeded",
            )),
            Some(b'{') => self.parse_object(depth),
            Some(b'[') => self.parse_array(depth),
            Some(b'"') => {
                let s = self.parse_string()?;
                Ok(CanonicalJsonValue::String(s))
            }
            Some(b't') => self.parse_literal("true", CanonicalJsonValue::Bool(true)),
            Some(b'f') => self.parse_literal("false", CanonicalJsonValue::Bool(false)),
            Some(b'n') => self.parse_literal("null", CanonicalJsonValue::Null),
            Some(c) if c == b'-' || c.is_ascii_digit() => {
                let num = self.parse_number()?;
                Ok(CanonicalJsonValue::Number(num))
            }
            _ => Err(CanonicalError::invalid_json("unexpected token in JSON")),
        }
    }

    fn parse_literal(
        &mut self,
        expected: &str,
        value: CanonicalJsonValue,
    ) -> Result<CanonicalJsonValue, CanonicalError> {
        let bytes = expected.as_bytes();
        if self.pos + bytes.len() > self.input.len()
            || &self.input[self.pos..self.pos + bytes.len()] != bytes
        {
            return Err(CanonicalError::invalid_json(format!(
                "invalid JSON literal, expected `{expected}`"
            )));
        }
        self.pos += bytes.len();
        Ok(value)
    }

    fn parse_object(&mut self, depth: u16) -> Result<CanonicalJsonValue, CanonicalError> {
        self.pos += 1; // consume '{'
        self.skip_ws()?;
        let mut members = Vec::new();
        let mut seen = HashSet::new();

        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(CanonicalJsonValue::Object(CanonicalJsonObject { members }));
        }

        loop {
            self.skip_ws()?;
            if self.peek() != Some(b'"') {
                return Err(CanonicalError::invalid_json("expected object member name"));
            }
            let key = self.parse_string()?;
            if !seen.insert(key.clone()) {
                return Err(CanonicalError::invalid_json(format!(
                    "duplicate object member: {key}"
                )));
            }
            self.skip_ws()?;
            if self.peek() != Some(b':') {
                return Err(CanonicalError::invalid_json(
                    "expected ':' after object member name",
                ));
            }
            self.pos += 1; // consume ':'
            let value = self.parse_value(depth + 1)?;
            members.push((key, value));
            self.skip_ws()?;
            match self.peek() {
                Some(b'}') => {
                    self.pos += 1;
                    break;
                }
                Some(b',') => {
                    self.pos += 1;
                }
                _ => {
                    return Err(CanonicalError::invalid_json(
                        "expected ',' or '}' in object",
                    ));
                }
            }
        }

        Ok(CanonicalJsonValue::Object(CanonicalJsonObject { members }))
    }

    fn parse_array(&mut self, depth: u16) -> Result<CanonicalJsonValue, CanonicalError> {
        self.pos += 1; // consume '['
        self.skip_ws()?;
        let mut items = Vec::new();

        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(CanonicalJsonValue::Array(items));
        }

        loop {
            let value = self.parse_value(depth + 1)?;
            items.push(value);
            self.skip_ws()?;
            match self.peek() {
                Some(b']') => {
                    self.pos += 1;
                    break;
                }
                Some(b',') => {
                    self.pos += 1;
                }
                _ => return Err(CanonicalError::invalid_json("expected ',' or ']' in array")),
            }
        }

        Ok(CanonicalJsonValue::Array(items))
    }

    fn parse_string(&mut self) -> Result<String, CanonicalError> {
        self.pos += 1; // consume opening '"'
        let mut result = String::new();
        let mut has_surrogate_pair_high = false; // track lone surrogates

        loop {
            if self.pos >= self.input.len() {
                return Err(CanonicalError::invalid_json("unterminated JSON string"));
            }
            let c = self.input[self.pos];
            if c == b'"' {
                self.pos += 1;
                // Check for lone surrogates in the final string
                if has_surrogate_pair_high {
                    return Err(CanonicalError::invalid_json(
                        "lone UTF-16 high surrogate in JSON string",
                    ));
                }
                return Ok(result);
            }
            if c < 0x20 {
                return Err(CanonicalError::invalid_json(
                    "unescaped control character in JSON string",
                ));
            }
            if c == b'\\' {
                self.pos += 1;
                if self.pos >= self.input.len() {
                    return Err(CanonicalError::invalid_json("unterminated JSON escape"));
                }
                let esc = self.input[self.pos];
                match esc {
                    b'"' => {
                        result.push('"');
                        self.pos += 1;
                        has_surrogate_pair_high = false;
                    }
                    b'\\' => {
                        result.push('\\');
                        self.pos += 1;
                        has_surrogate_pair_high = false;
                    }
                    b'/' => {
                        result.push('/');
                        self.pos += 1;
                        has_surrogate_pair_high = false;
                    }
                    b'b' => {
                        result.push('\u{0008}');
                        self.pos += 1;
                        has_surrogate_pair_high = false;
                    }
                    b'f' => {
                        result.push('\u{000C}');
                        self.pos += 1;
                        has_surrogate_pair_high = false;
                    }
                    b'n' => {
                        result.push('\n');
                        self.pos += 1;
                        has_surrogate_pair_high = false;
                    }
                    b'r' => {
                        result.push('\r');
                        self.pos += 1;
                        has_surrogate_pair_high = false;
                    }
                    b't' => {
                        result.push('\t');
                        self.pos += 1;
                        has_surrogate_pair_high = false;
                    }
                    b'u' => {
                        self.pos += 1;
                        let cp1 = self.parse_hex4()?;
                        if (0xD800..=0xDBFF).contains(&cp1) {
                            // High surrogate; must be followed by low surrogate
                            if self.pos + 1 >= self.input.len()
                                || self.input[self.pos] != b'\\'
                                || self.input[self.pos + 1] != b'u'
                            {
                                return Err(CanonicalError::invalid_json(
                                    "lone UTF-16 high surrogate in JSON string",
                                ));
                            }
                            self.pos += 2; // skip \u
                            let cp2 = self.parse_hex4()?;
                            if !(0xDC00..=0xDFFF).contains(&cp2) {
                                return Err(CanonicalError::invalid_json(
                                    "invalid UTF-16 surrogate pair in JSON string",
                                ));
                            }
                            let scalar = 0x10000 + ((cp1 - 0xD800) << 10) + (cp2 - 0xDC00);
                            result.push(char::from_u32(scalar).ok_or_else(|| {
                                CanonicalError::invalid_json(
                                    "invalid Unicode scalar from surrogate pair",
                                )
                            })?);
                            has_surrogate_pair_high = false;
                        } else if (0xDC00..=0xDFFF).contains(&cp1) {
                            return Err(CanonicalError::invalid_json(
                                "lone UTF-16 low surrogate in JSON string",
                            ));
                        } else {
                            result.push(char::from_u32(cp1).ok_or_else(|| {
                                CanonicalError::invalid_json(
                                    "invalid Unicode code point in \\u escape",
                                )
                            })?);
                            has_surrogate_pair_high = false;
                        }
                    }
                    _ => {
                        return Err(CanonicalError::invalid_json("invalid JSON escape sequence"));
                    }
                }
            } else {
                // Multi-byte UTF-8: collect bytes and decode
                let start = self.pos;
                let len = utf8_byte_len(c);
                if self.pos + len > self.input.len() {
                    return Err(CanonicalError::invalid_json(
                        "truncated UTF-8 sequence in JSON string",
                    ));
                }
                let bytes = &self.input[self.pos..self.pos + len];
                match std::str::from_utf8(bytes) {
                    Ok(s) => {
                        result.push_str(s);
                    }
                    Err(_) => {
                        return Err(CanonicalError::invalid_json("invalid UTF-8 in JSON string"));
                    }
                }
                self.pos += len;
                has_surrogate_pair_high = false;
                let _ = start;
            }
        }
    }

    fn parse_hex4(&mut self) -> Result<u32, CanonicalError> {
        if self.pos + 4 > self.input.len() {
            return Err(CanonicalError::invalid_json(
                "truncated \\u escape in JSON string",
            ));
        }
        let mut value: u32 = 0;
        for i in 0..4 {
            let c = self.input[self.pos + i];
            let digit = match c {
                b'0'..=b'9' => (c - b'0') as u32,
                b'a'..=b'f' => (c - b'a' + 10) as u32,
                b'A'..=b'F' => (c - b'A' + 10) as u32,
                _ => {
                    return Err(CanonicalError::invalid_json(
                        "invalid hex digit in \\u escape",
                    ));
                }
            };
            value = value * 16 + digit;
        }
        self.pos += 4;
        Ok(value)
    }

    fn parse_number(&mut self) -> Result<CanonicalNumber, CanonicalError> {
        let start = self.pos;

        // Optional minus
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }

        // Integer part: 0 or [1-9][0-9]*
        match self.peek() {
            Some(b'0') => {
                self.pos += 1;
            }
            Some(c) if c.is_ascii_digit() => {
                self.pos += 1;
                while let Some(c) = self.peek() {
                    if c.is_ascii_digit() {
                        self.pos += 1;
                    } else {
                        break;
                    }
                }
            }
            _ => return Err(CanonicalError::invalid_json("invalid JSON number")),
        }

        // Fractional part
        if self.peek() == Some(b'.') {
            self.pos += 1;
            if !matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
                return Err(CanonicalError::invalid_json(
                    "expected digit after decimal point",
                ));
            }
            while let Some(c) = self.peek() {
                if c.is_ascii_digit() {
                    self.pos += 1;
                } else {
                    break;
                }
            }
        }

        // Exponent part
        if matches!(self.peek(), Some(b'e') | Some(b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+') | Some(b'-')) {
                self.pos += 1;
            }
            if !matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
                return Err(CanonicalError::invalid_json("expected digit in exponent"));
            }
            while let Some(c) = self.peek() {
                if c.is_ascii_digit() {
                    self.pos += 1;
                } else {
                    break;
                }
            }
        }

        let text = std::str::from_utf8(&self.input[start..self.pos])
            .map_err(|_| CanonicalError::invalid_json("invalid UTF-8 in JSON number"))?;

        // Parse as f64 using serde_json's parser for exact IEEE-754 binary64 semantics
        let f: f64 = serde_json::from_str(text)
            .map_err(|_| CanonicalError::invalid_json(format!("invalid JSON number: {text}")))?;

        CanonicalNumber::from_f64(f)
    }
}

/// Returns the expected length of a UTF-8 sequence starting with the given byte.
fn utf8_byte_len(first: u8) -> usize {
    if first < 0x80 {
        1
    } else if first >> 5 == 0b110 {
        2
    } else if first >> 4 == 0b1110 {
        3
    } else if first >> 3 == 0b11110 {
        4
    } else {
        1 // invalid, will be caught by from_utf8
    }
}
