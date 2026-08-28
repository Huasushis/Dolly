use serde_json::Value;
use std::fmt;

/// Data that must never cross an observability or Module-backup boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UnsafeDataKind {
    Secret,
    HostAuthority,
    UpstreamPremise,
    CrossExtension,
}

impl fmt::Display for UnsafeDataKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Secret => "secret",
            Self::HostAuthority => "Host capability or authority",
            Self::UpstreamPremise => "upstream Host premise",
            Self::CrossExtension => "cross-Extension data",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UnsafeData {
    pub(crate) path: String,
    pub(crate) kind: UnsafeDataKind,
}

impl fmt::Display for UnsafeData {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} at {}", self.kind, self.path)
    }
}

/// Validate data that is about to become replay evidence or Module state.
///
/// Replay and backup records are intentionally closed semantic data. They
/// reject unsafe values rather than attempting to redact them, because a
/// caller must not mistake a partially preserved record for an exact one.
pub(crate) fn validate_closed_data(value: &Value) -> Result<(), UnsafeData> {
    validate_value(value, "$")
}

fn validate_value(value: &Value, path: &str) -> Result<(), UnsafeData> {
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                let child_path = format!("{path}.{key}");
                if let Some(kind) = classify_key(key) {
                    return Err(UnsafeData {
                        path: child_path,
                        kind,
                    });
                }
                validate_value(child, &child_path)?;
            }
            Ok(())
        }
        Value::Array(values) => {
            for (index, child) in values.iter().enumerate() {
                validate_value(child, &format!("{path}[{index}]"))?;
            }
            Ok(())
        }
        Value::String(string) if looks_like_secret(string) => Err(UnsafeData {
            path: path.to_owned(),
            kind: UnsafeDataKind::Secret,
        }),
        _ => Ok(()),
    }
}

fn classify_key(key: &str) -> Option<UnsafeDataKind> {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();

    if normalized.is_empty() {
        return None;
    }

    if normalized == "extension"
        || normalized == "extensionid"
        || normalized == "extensionalias"
        || normalized == "package"
        || normalized == "packagedigest"
        || normalized == "otherextension"
        || normalized == "crossextension"
        || normalized == "extensions"
        || normalized == "othermodule"
        || normalized == "crossmodule"
        || normalized == "modules"
        || normalized == "moduleid"
        || normalized == "storagescopeid"
    {
        return Some(UnsafeDataKind::CrossExtension);
    }

    if normalized.contains("capability")
        || normalized.contains("grant")
        || normalized.contains("reservation")
        || normalized == "leasetoken"
        || normalized == "runtimebinding"
        || normalized == "processgeneration"
        || normalized == "workerepoch"
        || normalized == "executionauthority"
        || normalized == "effectauthority"
        || normalized == "authority"
        || normalized == "fence"
    {
        return Some(UnsafeDataKind::HostAuthority);
    }

    if normalized.contains("premise")
        || normalized == "upstream"
        || normalized == "hostpremise"
        || normalized == "sourcepremise"
        || normalized == "instanceid"
        || normalized == "daemoninstallationid"
        || normalized == "runtimeid"
    {
        return Some(UnsafeDataKind::UpstreamPremise);
    }

    if normalized.starts_with("apikey")
        || normalized.starts_with("authorization")
        || normalized == "cookie"
        || normalized == "cookies"
        || normalized.starts_with("secret")
        || normalized.contains("password")
        || normalized.contains("credential")
        || normalized.starts_with("signedurl")
        || normalized.starts_with("privatepath")
        || normalized == "sessioncookie"
        || normalized == "bearertoken"
        || normalized == "token"
        || normalized.ends_with("token")
    {
        return Some(UnsafeDataKind::Secret);
    }

    None
}

fn looks_like_secret(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("authorization:")
        || lower.starts_with("bearer ")
        || lower.starts_with("basic ")
        || lower.contains("x-api-key:")
        || lower.contains("x-amz-signature=")
        || lower.contains("signature=")
        || lower.contains("sig=")
        || lower.starts_with("file://")
        || lower.starts_with("/home/")
        || lower.starts_with("/root/")
        || lower.starts_with("c:\\")
        || lower.starts_with("\\\\")
}
