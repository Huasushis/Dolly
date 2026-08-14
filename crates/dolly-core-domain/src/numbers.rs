use serde::de::{self, Deserialize, Deserializer};
use serde::ser::{Serialize, Serializer};
use std::fmt;

/// A non-negative safe JSON integer in the range `0..=9007199254740991` (2^53 - 1).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SafeU53(u64);

impl SafeU53 {
    pub const MAX: u64 = 9007199254740991;

    pub fn new(value: u64) -> Result<Self, String> {
        if value > Self::MAX {
            return Err(format!("SafeU53 must be in 0..={}, got {value}", Self::MAX));
        }
        Ok(Self(value))
    }

    pub fn value(self) -> u64 {
        self.0
    }

    pub fn checked_next(self) -> Result<Self, String> {
        if self.0 >= Self::MAX {
            return Err("CORE_SEQUENCE_EXHAUSTED".to_string());
        }
        Ok(Self(self.0 + 1))
    }
}

impl fmt::Display for SafeU53 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl fmt::Debug for SafeU53 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SafeU53({})", self.0)
    }
}

impl Serialize for SafeU53 {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u64(self.0)
    }
}

impl<'de> Deserialize<'de> for SafeU53 {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let v = u64::deserialize(deserializer)?;
        SafeU53::new(v).map_err(de::Error::custom)
    }
}

// ---------------------------------------------------------------------------
// Positive assigned sequence/revision wrappers
// ---------------------------------------------------------------------------

macro_rules! positive_wrapper {
    ($name:ident, $doc:expr) => {
        #[doc = $doc]
        #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(SafeU53);

        impl $name {
            pub fn new(value: u64) -> Result<Self, String> {
                if value == 0 {
                    return Err(format!(concat!(
                        stringify!($name),
                        " must be greater than zero"
                    )));
                }
                Ok(Self(SafeU53::new(value)?))
            }

            pub fn value(self) -> u64 {
                self.0.value()
            }

            pub fn checked_next(self) -> Result<Self, String> {
                self.0.checked_next().map(Self)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(f)
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}({})", stringify!($name), self.0.value())
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                self.0.serialize(serializer)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let v = u64::deserialize(deserializer)?;
                Self::new(v).map_err(de::Error::custom)
            }
        }
    };
}

positive_wrapper!(
    CommitSeq,
    "Instance-global ordering domain for committed Core records."
);
positive_wrapper!(PageSeq, "Ordering within one Page.");
positive_wrapper!(GraphRevision, "Immutable graph snapshot revision.");
positive_wrapper!(ConfigRevision, "Accepted instance configuration revision.");
positive_wrapper!(DescriptorRevision, "One Module Descriptor revision.");
positive_wrapper!(LeaseGeneration, "Fencing generation for one Activation.");
positive_wrapper!(
    ExtensionGeneration,
    "Fencing generation for one configured Extension process alias."
);

/// Attempt count for one Activation. A `SafeU53` wrapper that may represent
/// zero before a dispatch attempt.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Attempt(SafeU53);

impl Attempt {
    pub fn new(value: u64) -> Result<Self, String> {
        Ok(Self(SafeU53::new(value)?))
    }

    pub fn value(self) -> u64 {
        self.0.value()
    }
}

impl fmt::Display for Attempt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl fmt::Debug for Attempt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Attempt({})", self.0.value())
    }
}

impl Serialize for Attempt {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for Attempt {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let v = u64::deserialize(deserializer)?;
        Self::new(v).map_err(de::Error::custom)
    }
}
