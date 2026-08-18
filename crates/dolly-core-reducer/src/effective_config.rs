//! Pure effective-config normalizer and member-ceiling gate.
//!
//! Establishes the one-way authority direction for Module configuration
//! (control-plane spec, `docs/spec/control-plane/01` §1.1, `REQ-CFG-003`,
//! `REQ-CFG-004`, `REQ-CFG-005`): the frozen Extension-level object is the
//! basis, the Module-level object is the exact user override source, and
//! `effective_config(m)` is their deterministic **shallow** overlay — every
//! top-level member of `e.config`, then for `m.config` each member either
//! replaces or inserts the same-named member in its entirety. There is no
//! recursive object merge, no array concatenation, and JSON `null` is an
//! ordinary replacement value rather than a delete instruction. The result is
//! emitted in JCS form and hashed; the inputs are never mutated. Both source
//! objects and the resolved object share the 1,024-member ceiling; an
//! over-limit overlay is rejected before any consumer (reducer `InstallConfig`
//! admission) can commit a configuration revision.

use dolly_canonical_json::canonicalize;
use serde_json::Map;
use serde_json::Value;

/// Maximum number of top-level members in a source object or in the resolved
/// effective Module configuration (`REQ-CFG-005` ceiling).
pub const MAX_EFFECTIVE_CONFIG_PROPERTIES: usize = 1_024;

/// Spec rejection reason for an over-ceiling effective configuration, emitted
/// as `ConfigurationCandidateRejected` details and as the consumer error code
/// (the vector literal is `effective_config_max_properties`; the consumer code
/// is the same term in the crate's uppercase error-code convention).
pub const EFFECTIVE_CONFIG_MAX_PROPERTIES: &str = "effective_config_max_properties";
pub const EFFECTIVE_CONFIG_MAX_PROPERTIES_CODE: &str = "EFFECTIVE_CONFIG_MAX_PROPERTIES";

/// Closed normalizer failure set. Every variant is a deterministic,
/// host-independent rejection; no fallback and no environment behavior.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EffectiveConfigError {
    /// The Extension-level config source is not a JSON object.
    ExtensionConfigNotObject,
    /// The Module-level config source is not a JSON object.
    ModuleConfigNotObject,
    /// The Extension-level source exceeds the 1,024-member input ceiling.
    ExtensionConfigMaxProperties,
    /// The Module-level source exceeds the 1,024-member input ceiling.
    ModuleConfigMaxProperties,
    /// The resolved overlay exceeds the 1,024-member consumer ceiling.
    EffectiveConfigMaxProperties,
    /// The overlay cannot be emitted as JCS (semantic nesting too deep or a
    /// value outside the strict JSON profile).
    EffectiveConfigNotCanonicalizable,
}

/// Owned, canonical effective configuration plus its JCS digest — the durable
/// source an InstallConfig admission binds (`effective_config` +
/// `effective_config_digest`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedEffectiveConfig {
    pub effective_config: Value,
    pub effective_config_digest: String,
}

/// Computes the effective config for one Module instance as `e.config` overlaid
/// by `m.config` using top-level replace-not-merge semantics, then emits the
/// result in JCS form and hashes it.
///
/// Fail-closed when either source is not a JSON object or when any of the two
/// sources/resolved object exceeds the ceiling. Non-commutative by
/// construction: `m.config` overlay applies after `e.config`; there is no
/// reverse merge, cross-extension, alias, or recursive union anywhere in the
/// API.
pub fn normalize_effective_config(
    extension_config: &Value,
    module_config: &Value,
) -> Result<NormalizedEffectiveConfig, EffectiveConfigError> {
    let extension = extension_config
        .as_object()
        .ok_or(EffectiveConfigError::ExtensionConfigNotObject)?;
    let module = module_config
        .as_object()
        .ok_or(EffectiveConfigError::ModuleConfigNotObject)?;
    if extension.len() > MAX_EFFECTIVE_CONFIG_PROPERTIES {
        return Err(EffectiveConfigError::ExtensionConfigMaxProperties);
    }
    if module.len() > MAX_EFFECTIVE_CONFIG_PROPERTIES {
        return Err(EffectiveConfigError::ModuleConfigMaxProperties);
    }
    // Shallow overlay: the Extension basis, then replace/insert each Module
    // member in its entirety. `Map` is BTree-backed, so order is deterministic.
    let mut merged: Map<String, Value> = extension.clone();
    for (key, value) in module {
        merged.insert(key.clone(), value.clone());
    }
    if merged.len() > MAX_EFFECTIVE_CONFIG_PROPERTIES {
        return Err(EffectiveConfigError::EffectiveConfigMaxProperties);
    }
    let effective_config = Value::Object(merged);
    let (_, digest) = canonicalize(&effective_config).map_err(|_| {
        // A source that cannot be emitted in JCS form cannot be admitted as
        // configuration; fail closed rather than guess.
        EffectiveConfigError::EffectiveConfigNotCanonicalizable
    })?;
    Ok(NormalizedEffectiveConfig {
        effective_config_digest: digest.to_canonical_string(),
        effective_config,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ceiling_inputs_rejected_independently() {
        let huge = {
            let mut map = Map::new();
            for index in 0..(MAX_EFFECTIVE_CONFIG_PROPERTIES + 1) {
                map.insert(format!("key-{index:04}"), json!(index));
            }
            Value::Object(map)
        };
        let small = json!({"a": 1});
        assert_eq!(
            normalize_effective_config(&huge, &small),
            Err(EffectiveConfigError::ExtensionConfigMaxProperties)
        );
        assert_eq!(
            normalize_effective_config(&small, &huge),
            Err(EffectiveConfigError::ModuleConfigMaxProperties)
        );
    }

    #[test]
    fn non_object_inputs_fail_closed() {
        assert_eq!(
            normalize_effective_config(&json!([1]), &json!({"a": 1})),
            Err(EffectiveConfigError::ExtensionConfigNotObject)
        );
        assert_eq!(
            normalize_effective_config(&json!({"a": 1}), &json!("x")),
            Err(EffectiveConfigError::ModuleConfigNotObject)
        );
    }

    #[test]
    fn overlay_is_replace_not_recursive_or_concatenative() {
        let extension = json!({"nested": {"a": 1}, "list": [1], "score": 0});
        let module = json!({"nested": {"b": 2}, "list": [2], "score": 1});
        let resolved = normalize_effective_config(&extension, &module).unwrap();
        assert_eq!(
            resolved.effective_config,
            json!({"nested": {"b": 2}, "list": [2], "score": 1})
        );
        // Original sources are untouched.
        assert_eq!(
            extension,
            json!({"nested": {"a": 1}, "list": [1], "score": 0})
        );
        assert_eq!(module, json!({"nested": {"b": 2}, "list": [2], "score": 1}));
    }

    #[test]
    fn stateless_across_calls() {
        let extension = json!({"a": 1});
        let module = json!({"b": 2});
        let first = normalize_effective_config(&extension, &module).unwrap();
        let second = normalize_effective_config(&extension, &module).unwrap();
        assert_eq!(first, second);
    }
}
