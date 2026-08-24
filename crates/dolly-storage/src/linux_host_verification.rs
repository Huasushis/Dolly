//! Live Linux Host service and delegated-cgroup-root verification.
//!
//! Persistent Host authority remains in [`crate::host_authority`].  This
//! module loads and re-verifies the fully authoritative current snapshot and
//! only returns fresh, process-local evidence for the next Host producer.  It
//! never writes the Runtime authority database, starts a process, creates a
//! transport, or grants a capability.

#[cfg(target_os = "linux")]
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::fs;
#[cfg(target_os = "linux")]
use std::io;
#[cfg(target_os = "linux")]
use std::process::{Command, Stdio};
#[cfg(target_os = "linux")]
use std::thread;
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use dolly_canonical_json::{Sha256Digest, canonicalize};
use rusqlite::Connection;
use serde::Serialize;
use thiserror::Error;

use crate::host_authority::{
    CurrentAuthoritySnapshot, HostAuthorityError, InstalledComponentOrigin, LinuxServiceCandidate,
    load_current_authority,
};

/// The fixed Linux control-group v2 mount point used by the product profile.
pub const CGROUP_V2_MOUNT_POINT: &str = "/sys/fs/cgroup";
/// Controllers the reviewed Host service must delegate to its children.
pub const REQUIRED_CGROUP_CONTROLLERS: [&str; 3] = ["cpu", "memory", "pids"];
/// The only user-service subgroup that may contain the Host process.
pub const REQUIRED_DELEGATE_SUBGROUP: &str = "core";
/// Schema label for the in-memory evidence returned by this module.
pub const LINUX_HOST_VERIFICATION_PROOF_SCHEMA: &str = "dolly.linux-host-verification-proof/v1";

/// Closed refusal codes.  A refusal never contains a partial verified proof.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinuxHostVerificationCode {
    PlatformUnsupported,
    PremiseMissing,
    PremiseStale,
    PremiseDigestMismatch,
    ServiceManagerMismatch,
    UnitMissing,
    UnitAmbiguous,
    UnitInactive,
    UnitFailed,
    UnitIdentityMismatch,
    ServiceModeMismatch,
    MainPidInvalid,
    ServiceInvocationInvalid,
    BootIdentityInvalid,
    CgroupVersionUnavailable,
    CgroupPathMismatch,
    DelegationDisabled,
    DelegateSubgroupInvalid,
    DelegatedRootInvalid,
    DelegatedRootPopulated,
    ControllerUnavailable,
    RuntimeProfileInvalid,
    UserLingerUnavailable,
    ObservationUnavailable,
    ObservationChanged,
}

/// Structured fail-closed error for both deterministic and live verification.
#[derive(Debug, Error)]
#[error("Linux Host verification refused ({code:?}): {detail}")]
pub struct LinuxHostVerificationError {
    pub code: LinuxHostVerificationCode,
    pub detail: String,
}

impl LinuxHostVerificationError {
    fn refused(code: LinuxHostVerificationCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

/// One effective systemd ExecStart command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LinuxExecStart {
    pub path: String,
    pub arguments: Vec<String>,
    pub flags: Vec<String>,
}

/// Effective unit settings read from the service manager, not from unit-file
/// text.  Durations are microseconds and must be finite and positive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LinuxServiceRuntimeProfile {
    pub unit_type: String,
    pub restart: String,
    pub start_limit_burst: u64,
    pub start_limit_interval_usec: u64,
    pub kill_mode: String,
    pub send_sigkill: bool,
    pub timeout_stop_usec: u64,
    pub delegate: bool,
    pub delegate_subgroup: String,
    pub exit_type: String,
    pub restart_mode: String,
    pub remain_after_exit: bool,
    pub success_exit_status: Vec<String>,
    pub restart_prevent_exit_status: Vec<String>,
    pub pass_environment: Vec<String>,
    pub environment_files: Vec<String>,
    pub exec_start: Vec<LinuxExecStart>,
}

/// The delegated service root observation.  The root itself must be empty and
/// must already report all required subtree controllers as enabled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LinuxDelegatedRootObservation {
    pub cgroup_path: String,
    pub filesystem_path: String,
    pub owner_unit_name: String,
    pub owner_manager_mode: String,
    pub process_ids: Vec<u32>,
    pub controllers: Vec<String>,
    pub subtree_control: Vec<String>,
    pub cgroup_v2: bool,
}

/// One complete observation pass.  Tests may construct this closed data shape
/// to exercise pure verification; production obtains it from systemd, `/proc`,
/// `/sys/fs/cgroup`, and `loginctl` through [`observe_current_linux_host`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LinuxHostObservation {
    pub platform: String,
    pub manager_mode: String,
    pub unit_name: String,
    pub unit_id: String,
    pub unit_names: Vec<String>,
    pub load_state: String,
    pub active_state: String,
    pub sub_state: String,
    pub result: String,
    pub self_pid: u32,
    pub main_pid: u32,
    pub control_group: String,
    pub self_cgroup_path: String,
    pub invocation_id: String,
    pub boot_id: String,
    pub cgroup_v2: bool,
    pub runtime: LinuxServiceRuntimeProfile,
    pub user_linger: Option<bool>,
    pub delegated_root: LinuxDelegatedRootObservation,
    pub observation_generation: u64,
    pub observed_at_unix_millis: i64,
}

/// Service identity proven by the live observation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedLinuxServiceIdentity {
    pub unit_name: String,
    pub mode: String,
    pub invocation_id: String,
    pub boot_id: String,
    pub main_pid: u32,
    pub control_group: String,
    pub host_cgroup_path: String,
}

/// Delegated-root facts that the next Host producer may consume.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedDelegatedCgroupRoot {
    pub cgroup_path: String,
    pub filesystem_path: String,
    pub controllers: Vec<String>,
    pub subtree_control: Vec<String>,
}

/// Fresh, non-serializable proof bound to one exact persistent premise and one
/// live service/root observation.  Its fields are private so callers cannot
/// construct a proof from equal-looking values.
#[derive(Debug, PartialEq, Eq)]
pub struct VerifiedLinuxHostProof {
    schema: &'static str,
    daemon_installation_id: String,
    instance_id: String,
    config_revision: i64,
    config_digest: Sha256Digest,
    premises_digest: Sha256Digest,
    service_candidate_digest: Sha256Digest,
    service_candidate_origin: InstalledComponentOrigin,
    service: VerifiedLinuxServiceIdentity,
    delegated_root: VerifiedDelegatedCgroupRoot,
    observation_generation: u64,
    observed_at_unix_millis: i64,
}

impl VerifiedLinuxHostProof {
    /// The in-memory evidence discriminator; it is not a wire/schema record.
    pub fn schema(&self) -> &'static str {
        self.schema
    }

    pub fn daemon_installation_id(&self) -> &str {
        &self.daemon_installation_id
    }

    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    pub fn config_revision(&self) -> i64 {
        self.config_revision
    }

    pub fn config_digest(&self) -> &Sha256Digest {
        &self.config_digest
    }

    pub fn premises_digest(&self) -> &Sha256Digest {
        &self.premises_digest
    }

    pub fn service_candidate_digest(&self) -> &Sha256Digest {
        &self.service_candidate_digest
    }

    pub fn service_candidate_origin(&self) -> &InstalledComponentOrigin {
        &self.service_candidate_origin
    }

    pub fn service(&self) -> &VerifiedLinuxServiceIdentity {
        &self.service
    }

    pub fn delegated_root(&self) -> &VerifiedDelegatedCgroupRoot {
        &self.delegated_root
    }

    pub fn observation_generation(&self) -> u64 {
        self.observation_generation
    }

    pub fn observed_at_unix_millis(&self) -> i64 {
        self.observed_at_unix_millis
    }
}
/// Test-only proof constructor bound strictly to the current authority's
/// persisted premise. It is compiled only into this crate's unit tests, never
/// into any production library artifact.
#[cfg(test)]
pub fn test_proof_for_authority(
    snapshot: &CurrentAuthoritySnapshot,
) -> VerifiedLinuxHostProof {
    let premise = snapshot
        .premise
        .as_ref()
        .expect("test proof requires a complete premise");
    let candidate = &premise.service_candidate;
    VerifiedLinuxHostProof {
        schema: LINUX_HOST_VERIFICATION_PROOF_SCHEMA,
        daemon_installation_id: snapshot.mapping.daemon_installation_id.clone(),
        instance_id: snapshot.mapping.instance_id.clone(),
        config_revision: snapshot.mapping.config_revision,
        config_digest: snapshot.mapping.config_digest.clone(),
        premises_digest: premise.premises_digest.clone(),
        service_candidate_digest: candidate.candidate_digest.clone(),
        service_candidate_origin: candidate.origin.clone(),
        service: VerifiedLinuxServiceIdentity {
            unit_name: candidate.unit_name.clone(),
            mode: candidate.mode.clone(),
            invocation_id: "2812432ad29e4d3bbd6776c62cafa929".into(),
            boot_id: "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9".into(),
            main_pid: 4242,
            control_group: format!("/user.slice/{}", candidate.unit_name),
            host_cgroup_path: format!(
                "/user.slice/{}/{}",
                candidate.unit_name, REQUIRED_DELEGATE_SUBGROUP
            ),
        },
        delegated_root: VerifiedDelegatedCgroupRoot {
            cgroup_path: format!("/user.slice/{}", candidate.unit_name),
            filesystem_path: format!("/sys/fs/cgroup/user.slice/{}", candidate.unit_name),
            controllers: REQUIRED_CGROUP_CONTROLLERS
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            subtree_control: REQUIRED_CGROUP_CONTROLLERS
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
        },
        observation_generation: 1,
        observed_at_unix_millis: 1_755_876_800_000,
    }
}

/// Verify one deterministic observation against the exact current authority.
///
#[cfg(test)]
fn verify_linux_host_observation(
    snapshot: &CurrentAuthoritySnapshot,
    observation: LinuxHostObservation,
) -> Result<VerifiedLinuxHostProof, LinuxHostVerificationError> {
    if observation.platform != "linux" {
        return Err(LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::PlatformUnsupported,
            format!(
                "installed Linux Host verification cannot run on {}",
                observation.platform
            ),
        ));
    }
    let candidate = validate_current_snapshot(snapshot)?;
    verify_observation(snapshot, candidate, observation)
}
/// Observe and verify the authoritative current Linux Host service in one
/// bounded operation.  The SQLite pointer and every canonical premise are
/// loaded internally; callers cannot substitute a snapshot or observation.
///
/// The first and second complete passes are compared to fence a service/root
/// change during observation.  The authoritative pointer is loaded again
/// after both passes, and any identity, revision, digest, premise, or
/// candidate change refuses the proof.
pub fn verify_current_linux_host(
    connection: &Connection,
) -> Result<VerifiedLinuxHostProof, LinuxHostVerificationError> {
    if !cfg!(target_os = "linux") {
        return Err(LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::PlatformUnsupported,
            "installed Linux Host verification requires Linux",
        ));
    }
    verify_current_linux_host_with_observer(connection, observe_current_linux_host_for_candidate)
}

fn verify_current_linux_host_with_observer<F>(
    connection: &Connection,
    mut observe: F,
) -> Result<VerifiedLinuxHostProof, LinuxHostVerificationError>
where
    F: FnMut(&LinuxServiceCandidate) -> Result<LinuxHostObservation, LinuxHostVerificationError>,
{
    let initial = load_authoritative_snapshot(connection)?;
    let candidate = validate_current_snapshot(&initial)?;
    let first = observe(candidate)?;
    let second = observe(candidate)?;
    if observation_identity(&first) != observation_identity(&second) {
        return Err(LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::ObservationChanged,
            "service, invocation, process, cgroup, or delegated-root observations changed during verification",
        ));
    }
    let final_snapshot = load_authoritative_snapshot(connection)?;
    if !same_authority_binding(&initial, &final_snapshot) {
        return Err(LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::ObservationChanged,
            "authoritative Runtime identity, revision, digest, premise, or service candidate changed during observation",
        ));
    }
    verify_observation(&initial, candidate, second)
}

fn load_authoritative_snapshot(
    connection: &Connection,
) -> Result<CurrentAuthoritySnapshot, LinuxHostVerificationError> {
    load_current_authority(connection)
        .map_err(|error: HostAuthorityError| {
            LinuxHostVerificationError::refused(
                LinuxHostVerificationCode::PremiseStale,
                format!("authoritative current pointer could not be loaded: {error}"),
            )
        })?
        .ok_or_else(|| {
            LinuxHostVerificationError::refused(
                LinuxHostVerificationCode::PremiseMissing,
                "authoritative current pointer has no committed Host activation premise",
            )
        })
}

fn same_authority_binding(
    initial: &CurrentAuthoritySnapshot,
    final_snapshot: &CurrentAuthoritySnapshot,
) -> bool {
    initial.mapping.daemon_installation_id == final_snapshot.mapping.daemon_installation_id
        && initial.mapping.instance_id == final_snapshot.mapping.instance_id
        && initial.mapping.config_revision == final_snapshot.mapping.config_revision
        && initial.mapping.config_digest == final_snapshot.mapping.config_digest
        && match (&initial.premise, &final_snapshot.premise) {
            (Some(initial), Some(final_premise)) => {
                initial.premises_digest == final_premise.premises_digest
                    && initial.service_candidate == final_premise.service_candidate
            }
            _ => false,
        }
}

fn validate_current_snapshot(
    snapshot: &CurrentAuthoritySnapshot,
) -> Result<&LinuxServiceCandidate, LinuxHostVerificationError> {
    let mapping = &snapshot.mapping;
    let Some(premise) = snapshot.premise.as_ref() else {
        return Err(LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::PremiseMissing,
            "current Runtime authority has no complete Host activation premise",
        ));
    };
    if mapping.schema != "dolly.config-revision-mapping/v1"
        || premise.schema != "dolly.module-activation-premises/v1"
    {
        return Err(LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::PremiseStale,
            "current Host premise uses an unsupported authority record schema",
        ));
    }
    if !valid_uuid_v7(&mapping.daemon_installation_id)
        || !valid_stable_id(&mapping.instance_id)
        || mapping.config_revision < 1
    {
        return Err(LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::PremiseStale,
            "current Runtime identity or revision is malformed",
        ));
    }
    let config_digest = canonicalize(&mapping.canonical_config)
        .map_err(|error| {
            LinuxHostVerificationError::refused(
                LinuxHostVerificationCode::PremiseDigestMismatch,
                format!("current resolved configuration is not canonical: {error}"),
            )
        })?
        .1;
    if config_digest != mapping.config_digest {
        return Err(LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::PremiseDigestMismatch,
            "current resolved configuration digest does not match the authority mapping",
        ));
    }
    if premise.daemon_installation_id != mapping.daemon_installation_id
        || premise.instance_id != mapping.instance_id
        || premise.config_revision != mapping.config_revision
        || premise.config_digest != mapping.config_digest
    {
        return Err(LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::PremiseStale,
            "current Host premise is not bound to the exact Runtime identity, revision, and config digest",
        ));
    }
    let Some(config_candidate) = mapping.canonical_config.service_candidate.as_ref() else {
        return Err(LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::PremiseMissing,
            "current resolved configuration has no Linux service candidate",
        ));
    };
    if config_candidate != &premise.service_candidate {
        return Err(LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::PremiseStale,
            "current mapping and activation premise name different service candidates",
        ));
    }
    if premise.service_candidate.schema != "dolly.linux-service-candidate/v1"
        || !valid_unit_name(&premise.service_candidate.unit_name)
        || !valid_origin(&premise.service_candidate.origin)
    {
        return Err(LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::PremiseStale,
            "persisted Linux service candidate identity is malformed",
        ));
    }
    if premise.service_candidate.mode != "user" {
        return Err(LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::ServiceModeMismatch,
            "v1 installed activation accepts only a user service candidate",
        ));
    }
    let candidate_digest = digest_without(&premise.service_candidate, "candidate_digest")?;
    if candidate_digest != premise.service_candidate.candidate_digest {
        return Err(LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::PremiseDigestMismatch,
            "service candidate digest does not match its canonical record",
        ));
    }
    let premise_digest = digest_without(premise, "premises_digest")?;
    if premise_digest != premise.premises_digest {
        return Err(LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::PremiseDigestMismatch,
            "activation premise digest does not match its canonical record",
        ));
    }
    if premise.daemon_installation_id.is_empty() || premise.instance_id.is_empty() {
        return Err(LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::PremiseStale,
            "current Runtime identity is incomplete",
        ));
    }
    Ok(config_candidate)
}
fn verify_observation(
    snapshot: &CurrentAuthoritySnapshot,
    candidate: &LinuxServiceCandidate,
    observation: LinuxHostObservation,
) -> Result<VerifiedLinuxHostProof, LinuxHostVerificationError> {
    let reject = |code, detail: String| Err(LinuxHostVerificationError::refused(code, detail));
    if observation.manager_mode != "user" {
        return reject(
            LinuxHostVerificationCode::ServiceManagerMismatch,
            format!(
                "candidate {} requires the current systemd user manager, observed {}",
                candidate.unit_name, observation.manager_mode
            ),
        );
    }
    if observation.unit_name != candidate.unit_name {
        return reject(
            LinuxHostVerificationCode::UnitIdentityMismatch,
            format!(
                "observed unit {} differs from persisted candidate {}",
                observation.unit_name, candidate.unit_name
            ),
        );
    }
    if observation.unit_id != candidate.unit_name {
        return reject(
            LinuxHostVerificationCode::UnitIdentityMismatch,
            format!(
                "service manager identity {} differs from persisted candidate {}",
                observation.unit_id, candidate.unit_name
            ),
        );
    }
    let exact_names = observation
        .unit_names
        .iter()
        .filter(|name| *name == &candidate.unit_name)
        .count();
    if exact_names == 0 {
        return reject(
            LinuxHostVerificationCode::UnitMissing,
            format!(
                "service manager did not report candidate unit {}",
                candidate.unit_name
            ),
        );
    }
    if exact_names != 1 || observation.unit_names.is_empty() {
        return reject(
            LinuxHostVerificationCode::UnitAmbiguous,
            format!(
                "service manager reported an ambiguous identity for {}",
                candidate.unit_name
            ),
        );
    }
    if observation.load_state != "loaded" {
        return reject(
            LinuxHostVerificationCode::UnitMissing,
            format!("candidate unit is not loaded: {}", observation.load_state),
        );
    }
    if observation.active_state != "active" || observation.sub_state != "running" {
        return reject(
            LinuxHostVerificationCode::UnitInactive,
            format!(
                "candidate unit is not active/running: {}/{}",
                observation.active_state, observation.sub_state
            ),
        );
    }
    if observation.result != "success" {
        return reject(
            LinuxHostVerificationCode::UnitFailed,
            format!(
                "candidate unit has non-success result {}",
                observation.result
            ),
        );
    }
    if observation.main_pid == 0 || observation.main_pid != observation.self_pid {
        return reject(
            LinuxHostVerificationCode::MainPidInvalid,
            format!(
                "service manager MainPID {} does not identify this process {}",
                observation.main_pid, observation.self_pid
            ),
        );
    }
    if !valid_invocation_id(&observation.invocation_id) {
        return reject(
            LinuxHostVerificationCode::ServiceInvocationInvalid,
            "service manager invocation identity is absent or invalid".into(),
        );
    }
    if !valid_boot_id(&observation.boot_id) {
        return reject(
            LinuxHostVerificationCode::BootIdentityInvalid,
            "Linux boot identity is absent or invalid".into(),
        );
    }
    if observation.observation_generation == 0 || observation.observed_at_unix_millis <= 0 {
        return reject(
            LinuxHostVerificationCode::ObservationUnavailable,
            "observation generation/time is absent or invalid".into(),
        );
    }
    if let Some(false) | None = observation.user_linger {
        return reject(
            LinuxHostVerificationCode::UserLingerUnavailable,
            "user manager lingering is not proven enabled".into(),
        );
    }
    if !observation.runtime.delegate {
        return reject(
            LinuxHostVerificationCode::DelegationDisabled,
            "systemd Delegate is disabled for the observed service".into(),
        );
    }
    if observation.runtime.delegate_subgroup != REQUIRED_DELEGATE_SUBGROUP {
        return reject(
            LinuxHostVerificationCode::DelegateSubgroupInvalid,
            format!(
                "systemd DelegateSubgroup is {}, expected {}",
                observation.runtime.delegate_subgroup, REQUIRED_DELEGATE_SUBGROUP
            ),
        );
    }
    if let Err(detail) = verify_runtime_profile(&observation.runtime) {
        return reject(LinuxHostVerificationCode::RuntimeProfileInvalid, detail);
    }
    if !observation.cgroup_v2 {
        return reject(
            LinuxHostVerificationCode::CgroupVersionUnavailable,
            "the Host service is not on a cgroup version 2 hierarchy".into(),
        );
    }
    let control_group = safe_cgroup_path(&observation.control_group).ok_or_else(|| {
        LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::CgroupPathMismatch,
            "service manager reported an unsafe or missing ControlGroup path",
        )
    })?;
    let process_group = safe_cgroup_path(&observation.self_cgroup_path).ok_or_else(|| {
        LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::CgroupPathMismatch,
            "the current process has an unsafe or missing cgroup path",
        )
    })?;
    let expected_process_group = format!("{control_group}/{REQUIRED_DELEGATE_SUBGROUP}");
    if process_group != expected_process_group {
        return reject(
            LinuxHostVerificationCode::CgroupPathMismatch,
            format!(
                "current process cgroup {} does not equal delegated subgroup {}",
                process_group, expected_process_group
            ),
        );
    }
    let root = &observation.delegated_root;
    if root.cgroup_path != control_group
        || root.owner_unit_name != candidate.unit_name
        || root.owner_manager_mode != "user"
        || !root.cgroup_v2
        || root.filesystem_path != format!("{CGROUP_V2_MOUNT_POINT}{control_group}")
    {
        return reject(
            LinuxHostVerificationCode::DelegatedRootInvalid,
            "delegated root path, owner, mount, or cgroup version does not match the current service".into(),
        );
    }
    if !root.process_ids.is_empty() {
        return reject(
            LinuxHostVerificationCode::DelegatedRootPopulated,
            format!(
                "delegated root contains {} process identifiers",
                root.process_ids.len()
            ),
        );
    }
    if let Some(missing) = missing_required_controller(&root.controllers) {
        return reject(
            LinuxHostVerificationCode::ControllerUnavailable,
            format!("delegated root is missing controller {missing}"),
        );
    }
    if let Some(missing) = missing_required_controller(&root.subtree_control) {
        return reject(
            LinuxHostVerificationCode::ControllerUnavailable,
            format!("delegated root subtree_control did not read back controller {missing}"),
        );
    }
    let premise = snapshot.premise.as_ref().ok_or_else(|| {
        LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::PremiseMissing,
            "current Host premise disappeared while constructing proof",
        )
    })?;
    Ok(VerifiedLinuxHostProof {
        schema: LINUX_HOST_VERIFICATION_PROOF_SCHEMA,
        daemon_installation_id: snapshot.mapping.daemon_installation_id.clone(),
        instance_id: snapshot.mapping.instance_id.clone(),
        config_revision: snapshot.mapping.config_revision,
        config_digest: snapshot.mapping.config_digest.clone(),
        premises_digest: premise.premises_digest.clone(),
        service_candidate_digest: candidate.candidate_digest.clone(),
        service_candidate_origin: candidate.origin.clone(),
        service: VerifiedLinuxServiceIdentity {
            unit_name: observation.unit_name,
            mode: observation.manager_mode,
            invocation_id: observation.invocation_id,
            boot_id: observation.boot_id,
            main_pid: observation.main_pid,
            control_group: control_group.clone(),
            host_cgroup_path: process_group,
        },
        delegated_root: VerifiedDelegatedCgroupRoot {
            cgroup_path: root.cgroup_path.clone(),
            filesystem_path: root.filesystem_path.clone(),
            controllers: root.controllers.clone(),
            subtree_control: root.subtree_control.clone(),
        },
        observation_generation: observation.observation_generation,
        observed_at_unix_millis: observation.observed_at_unix_millis,
    })
}

fn verify_runtime_profile(runtime: &LinuxServiceRuntimeProfile) -> Result<(), String> {
    if runtime.unit_type != "exec" {
        return Err(format!("Type must be exec, observed {}", runtime.unit_type));
    }
    if runtime.restart != "on-failure" {
        return Err(format!(
            "Restart must be on-failure, observed {}",
            runtime.restart
        ));
    }
    if runtime.start_limit_burst == 0 || runtime.start_limit_interval_usec == 0 {
        return Err("restart limit must be finite and positive".into());
    }
    if runtime.kill_mode != "control-group" {
        return Err(format!(
            "KillMode must be control-group, observed {}",
            runtime.kill_mode
        ));
    }
    if !runtime.send_sigkill {
        return Err("SendSIGKILL must be enabled".into());
    }
    if runtime.timeout_stop_usec == 0 {
        return Err("TimeoutStopUSec must be finite and positive".into());
    }
    if !runtime.delegate {
        return Err("Delegate must be enabled".into());
    }
    if runtime.delegate_subgroup != REQUIRED_DELEGATE_SUBGROUP {
        return Err(format!(
            "DelegateSubgroup must be {REQUIRED_DELEGATE_SUBGROUP}, observed {}",
            runtime.delegate_subgroup
        ));
    }
    if runtime.exit_type != "main" {
        return Err(format!(
            "ExitType must be main, observed {}",
            runtime.exit_type
        ));
    }
    if runtime.restart_mode != "normal" {
        return Err(format!(
            "RestartMode must be normal, observed {}",
            runtime.restart_mode
        ));
    }
    if runtime.remain_after_exit {
        return Err("RemainAfterExit must be disabled".into());
    }
    if !runtime.success_exit_status.is_empty() {
        return Err("SuccessExitStatus must not override the reviewed profile".into());
    }
    if !runtime.restart_prevent_exit_status.is_empty() {
        return Err("RestartPreventExitStatus must not override the reviewed profile".into());
    }
    if !runtime.pass_environment.is_empty() || !runtime.environment_files.is_empty() {
        return Err("PassEnvironment and EnvironmentFiles must be empty".into());
    }
    if runtime.exec_start.len() != 1 {
        return Err("reviewed service must have exactly one ExecStart".into());
    }
    let command = &runtime.exec_start[0];
    if !safe_executable_path(&command.path) {
        return Err("ExecStart path is not an absolute installed path".into());
    }
    if !command.flags.iter().any(|flag| flag == "no-env-expand") {
        return Err("ExecStart must carry the no-env-expand flag".into());
    }
    if command
        .arguments
        .iter()
        .any(|argument| argument.contains('$') || argument.contains('%'))
    {
        return Err("ExecStart arguments contain expandable variable text".into());
    }
    Ok(())
}

fn missing_required_controller(values: &[String]) -> Option<&'static str> {
    REQUIRED_CGROUP_CONTROLLERS
        .iter()
        .find(|required| !values.iter().any(|value| value == **required))
        .copied()
}

fn safe_cgroup_path(value: &str) -> Option<String> {
    if !value.starts_with('/') || value.contains('\0') || value == "/" {
        return None;
    }
    if value.ends_with('/') {
        return None;
    }
    if value
        .split('/')
        .skip(1)
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return None;
    }
    Some(value.to_owned())
}

fn safe_executable_path(value: &str) -> bool {
    if !value.starts_with('/') || value.contains('\0') || value.ends_with('/') {
        return false;
    }
    if value
        .split('/')
        .skip(1)
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return false;
    }
    !value
        .chars()
        .any(|character| "$%'\"`\\;&|<>(){}[]*?~!#\t\n\r ".contains(character))
}

fn valid_invocation_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && value.bytes().any(|byte| byte != b'0')
}

fn valid_boot_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[18] == b'-'
        && bytes[23] == b'-'
        && bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 8 | 13 | 18 | 23)
                || byte.is_ascii_digit()
                || (b'a'..=b'f').contains(byte)
        })
        && bytes
            .iter()
            .enumerate()
            .any(|(index, byte)| !matches!(index, 8 | 13 | 18 | 23) && *byte != b'0')
}
fn valid_stable_id(value: &str) -> bool {
    let mut pieces = value.split('-');
    let Some(first) = pieces.next() else {
        return false;
    };
    !first.is_empty()
        && first
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && pieces.all(|piece| {
            !piece.is_empty()
                && piece
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

fn valid_qualified_name(value: &str) -> bool {
    let pieces: Vec<_> = value.split('.').collect();
    pieces.len() >= 2 && pieces.iter().all(|piece| valid_stable_id(piece))
}

fn valid_uuid_v7(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23]
            .into_iter()
            .all(|index| bytes[index] == b'-')
        && bytes
            .iter()
            .enumerate()
            .filter(|(index, _)| ![8, 13, 18, 23].contains(index))
            .all(|(_, byte)| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
        && bytes[14] == b'7'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
}

fn valid_unit_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    value.len() >= 9
        && value.len() <= 255
        && !bytes.is_empty()
        && bytes[0].is_ascii_alphanumeric()
        && value.ends_with(".service")
        && bytes.iter().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'.' | b'@' | b'-')
        })
}

fn valid_origin(origin: &InstalledComponentOrigin) -> bool {
    origin.schema == "dolly.installed-component-origin/v1"
        && origin.kind == "installed_product_component"
        && valid_qualified_name(&origin.component_id)
        && origin.component_revision >= 1
}

fn digest_without<T: Serialize>(
    value: &T,
    field: &str,
) -> Result<Sha256Digest, LinuxHostVerificationError> {
    let mut json = serde_json::to_value(value).map_err(|error| {
        LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::PremiseDigestMismatch,
            format!("authority record cannot be canonicalized: {error}"),
        )
    })?;
    let object = json.as_object_mut().ok_or_else(|| {
        LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::PremiseDigestMismatch,
            "authority record is not a canonical object",
        )
    })?;
    object.remove(field);
    canonicalize(&json)
        .map(|(_, digest)| digest)
        .map_err(|error| {
            LinuxHostVerificationError::refused(
                LinuxHostVerificationCode::PremiseDigestMismatch,
                format!("authority record cannot be canonicalized: {error}"),
            )
        })
}

fn observation_identity(observation: &LinuxHostObservation) -> LinuxHostObservation {
    let mut copy = observation.clone();
    copy.observed_at_unix_millis = 0;
    copy
}

#[cfg(target_os = "linux")]
fn observe_current_linux_host_for_candidate(
    candidate: &LinuxServiceCandidate,
) -> Result<LinuxHostObservation, LinuxHostVerificationError> {
    let properties = read_systemd_properties(&candidate.unit_name)?;
    let manager_mode = "user".to_owned();
    let unit_names = split_words(required_property(&properties, "Names")?);
    let unit_id = required_property(&properties, "Id")?.to_owned();
    let control_group = required_property(&properties, "ControlGroup")?.to_owned();
    let control_group = safe_cgroup_path(&control_group).ok_or_else(|| {
        LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::CgroupPathMismatch,
            "systemd returned an unsafe ControlGroup path",
        )
    })?;
    let self_cgroup_path = parse_process_cgroup(
        &fs::read_to_string("/proc/self/cgroup").map_err(observation_io_error)?,
    )
    .ok_or_else(|| {
        LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::CgroupPathMismatch,
            "the process is not on a pure cgroup version 2 hierarchy",
        )
    })?;
    let boot_id = fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .map_err(observation_io_error)?
        .trim()
        .to_ascii_lowercase();
    let invocation_id = required_property(&properties, "InvocationID")?
        .trim()
        .to_ascii_lowercase();
    let runtime = LinuxServiceRuntimeProfile {
        unit_type: required_property(&properties, "Type")?.to_owned(),
        restart: required_property(&properties, "Restart")?.to_owned(),
        start_limit_burst: parse_u64(
            required_property(&properties, "StartLimitBurst")?,
            "StartLimitBurst",
        )?,
        start_limit_interval_usec: parse_duration(
            required_property(&properties, "StartLimitIntervalUSec")?,
            "StartLimitIntervalUSec",
        )?,
        kill_mode: required_property(&properties, "KillMode")?.to_owned(),
        send_sigkill: parse_bool(
            required_property(&properties, "SendSIGKILL")?,
            "SendSIGKILL",
        )?,
        timeout_stop_usec: parse_duration(
            required_property(&properties, "TimeoutStopUSec")?,
            "TimeoutStopUSec",
        )?,
        delegate: parse_bool(required_property(&properties, "Delegate")?, "Delegate")?,
        delegate_subgroup: required_property(&properties, "DelegateSubgroup")?.to_owned(),
        exit_type: required_property(&properties, "ExitType")?.to_owned(),
        restart_mode: required_property(&properties, "RestartMode")?.to_owned(),
        remain_after_exit: parse_bool(
            required_property(&properties, "RemainAfterExit")?,
            "RemainAfterExit",
        )?,
        success_exit_status: split_words(required_property(&properties, "SuccessExitStatus")?),
        restart_prevent_exit_status: split_words(required_property(
            &properties,
            "RestartPreventExitStatus",
        )?),
        pass_environment: split_words(required_property(&properties, "PassEnvironment")?),
        environment_files: split_words(required_property(&properties, "EnvironmentFiles")?),
        exec_start: parse_exec_start(required_property(&properties, "ExecStartEx")?),
    };
    let mount_is_v2 = cgroup_mount_is_v2(CGROUP_V2_MOUNT_POINT)?;
    let root_filesystem_path = format!("{CGROUP_V2_MOUNT_POINT}{control_group}");
    let root_processes = parse_process_ids(
        &fs::read_to_string(format!("{root_filesystem_path}/cgroup.procs"))
            .map_err(observation_io_error)?,
    )?;
    let controllers = split_words(
        &fs::read_to_string(format!("{root_filesystem_path}/cgroup.controllers"))
            .map_err(observation_io_error)?,
    );
    let subtree_control = split_words(
        &fs::read_to_string(format!("{root_filesystem_path}/cgroup.subtree_control"))
            .map_err(observation_io_error)?,
    );
    let user_linger = read_user_linger()?;
    let observed_at_unix_millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| {
            LinuxHostVerificationError::refused(
                LinuxHostVerificationCode::ObservationUnavailable,
                "system clock is before Unix epoch",
            )
        })?
        .as_millis()
        .try_into()
        .map_err(|_| {
            LinuxHostVerificationError::refused(
                LinuxHostVerificationCode::ObservationUnavailable,
                "observation time exceeds the supported integer range",
            )
        })?;
    let observation_generation = u64::from_str_radix(&invocation_id[..16], 16).map_err(|_| {
        LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::ServiceInvocationInvalid,
            "service invocation identity cannot produce an observation generation",
        )
    })?;
    Ok(LinuxHostObservation {
        platform: "linux".into(),
        manager_mode,
        unit_name: candidate.unit_name.clone(),
        unit_id,
        unit_names,
        load_state: required_property(&properties, "LoadState")?.to_owned(),
        active_state: required_property(&properties, "ActiveState")?.to_owned(),
        sub_state: required_property(&properties, "SubState")?.to_owned(),
        result: required_property(&properties, "Result")?.to_owned(),
        self_pid: std::process::id(),
        main_pid: parse_u64(required_property(&properties, "MainPID")?, "MainPID")?
            .try_into()
            .map_err(|_| {
                LinuxHostVerificationError::refused(
                    LinuxHostVerificationCode::MainPidInvalid,
                    "MainPID exceeds the process identifier range",
                )
            })?,
        control_group: control_group.clone(),
        self_cgroup_path,
        invocation_id,
        boot_id,
        cgroup_v2: mount_is_v2,
        runtime,
        user_linger,
        delegated_root: LinuxDelegatedRootObservation {
            cgroup_path: control_group,
            filesystem_path: root_filesystem_path,
            owner_unit_name: candidate.unit_name.clone(),
            owner_manager_mode: "user".into(),
            process_ids: root_processes,
            controllers,
            subtree_control,
            cgroup_v2: mount_is_v2,
        },
        observation_generation,
        observed_at_unix_millis,
    })
}

#[cfg(not(target_os = "linux"))]
fn observe_current_linux_host_for_candidate(
    _candidate: &LinuxServiceCandidate,
) -> Result<LinuxHostObservation, LinuxHostVerificationError> {
    Err(LinuxHostVerificationError::refused(
        LinuxHostVerificationCode::PlatformUnsupported,
        "installed Linux Host observation requires Linux",
    ))
}

#[cfg(target_os = "linux")]
fn read_systemd_properties(
    unit_name: &str,
) -> Result<HashMap<String, String>, LinuxHostVerificationError> {
    let property_names = [
        "Id",
        "Names",
        "LoadState",
        "ActiveState",
        "SubState",
        "Result",
        "MainPID",
        "ControlGroup",
        "InvocationID",
        "Type",
        "Restart",
        "StartLimitBurst",
        "StartLimitIntervalUSec",
        "KillMode",
        "SendSIGKILL",
        "TimeoutStopUSec",
        "Delegate",
        "DelegateSubgroup",
        "ExitType",
        "RestartMode",
        "RemainAfterExit",
        "SuccessExitStatus",
        "RestartPreventExitStatus",
        "PassEnvironment",
        "EnvironmentFiles",
        "ExecStartEx",
    ];
    let mut command = Command::new("/usr/bin/systemctl");
    command
        .arg("--user")
        .arg("show")
        .arg("--no-pager")
        .arg(format!("--property={}", property_names.join(",")))
        .arg(unit_name)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = run_bounded(
        &mut command,
        Duration::from_secs(5),
        "systemd user-manager query",
    )?;
    if !output.status.success() {
        return Err(LinuxHostVerificationError::refused(
            if output.stderr.contains("not found") || output.stderr.contains("NoSuchUnit") {
                LinuxHostVerificationCode::UnitMissing
            } else {
                LinuxHostVerificationCode::ObservationUnavailable
            },
            format!(
                "systemd user-manager query failed: {}",
                output.stderr.trim()
            ),
        ));
    }
    parse_properties(&output.stdout)
}

#[cfg(target_os = "linux")]
fn read_user_linger() -> Result<Option<bool>, LinuxHostVerificationError> {
    let uid = unsafe { libc::geteuid() };
    let mut command = Command::new("/usr/bin/loginctl");
    command
        .arg("show-user")
        .arg(uid.to_string())
        .arg("--property=Linger")
        .arg("--value")
        .arg("--no-pager")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = run_bounded(
        &mut command,
        Duration::from_secs(5),
        "loginctl user lingering query",
    )?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(match output.stdout.trim().to_ascii_lowercase().as_str() {
        "yes" | "true" | "1" => Some(true),
        "no" | "false" | "0" => Some(false),
        _ => None,
    })
}

#[cfg(target_os = "linux")]
struct BoundedOutput {
    status: std::process::ExitStatus,
    stdout: String,
    stderr: String,
}

#[cfg(target_os = "linux")]
fn run_bounded(
    command: &mut Command,
    timeout: Duration,
    operation: &str,
) -> Result<BoundedOutput, LinuxHostVerificationError> {
    let start = Instant::now();
    let mut child = command.spawn().map_err(|error| {
        LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::ObservationUnavailable,
            format!("{operation} could not start: {error}"),
        )
    })?;
    loop {
        if let Some(status) = child.try_wait().map_err(|error| {
            LinuxHostVerificationError::refused(
                LinuxHostVerificationCode::ObservationUnavailable,
                format!("{operation} status could not be read: {error}"),
            )
        })? {
            let output = child.wait_with_output().map_err(|error| {
                LinuxHostVerificationError::refused(
                    LinuxHostVerificationCode::ObservationUnavailable,
                    format!("{operation} output could not be read: {error}"),
                )
            })?;
            if output.stdout.len() > 4 * 1024 * 1024 || output.stderr.len() > 4 * 1024 * 1024 {
                return Err(LinuxHostVerificationError::refused(
                    LinuxHostVerificationCode::ObservationUnavailable,
                    format!("{operation} exceeded the bounded output size"),
                ));
            }
            return Ok(BoundedOutput {
                status,
                stdout: String::from_utf8(output.stdout).map_err(|error| {
                    LinuxHostVerificationError::refused(
                        LinuxHostVerificationCode::ObservationUnavailable,
                        format!("{operation} returned non-UTF-8 output: {error}"),
                    )
                })?,
                stderr: String::from_utf8(output.stderr).map_err(|error| {
                    LinuxHostVerificationError::refused(
                        LinuxHostVerificationCode::ObservationUnavailable,
                        format!("{operation} returned non-UTF-8 errors: {error}"),
                    )
                })?,
            });
        }
        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(LinuxHostVerificationError::refused(
                LinuxHostVerificationCode::ObservationUnavailable,
                format!("{operation} exceeded its bounded timeout"),
            ));
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(target_os = "linux")]
fn parse_properties(value: &str) -> Result<HashMap<String, String>, LinuxHostVerificationError> {
    let mut properties = HashMap::new();
    for line in value.lines() {
        let Some((key, value)) = line.split_once('=') else {
            return Err(LinuxHostVerificationError::refused(
                LinuxHostVerificationCode::ObservationUnavailable,
                "systemd returned a malformed property line",
            ));
        };
        if key.is_empty()
            || properties
                .insert(key.to_owned(), value.to_owned())
                .is_some()
        {
            return Err(LinuxHostVerificationError::refused(
                LinuxHostVerificationCode::UnitAmbiguous,
                "systemd returned duplicate or empty property names",
            ));
        }
    }
    Ok(properties)
}

#[cfg(target_os = "linux")]
fn required_property<'a>(
    properties: &'a HashMap<String, String>,
    name: &str,
) -> Result<&'a str, LinuxHostVerificationError> {
    properties.get(name).map(String::as_str).ok_or_else(|| {
        LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::ObservationUnavailable,
            format!("systemd did not report required property {name}"),
        )
    })
}

#[cfg(target_os = "linux")]
fn parse_u64(value: &str, name: &str) -> Result<u64, LinuxHostVerificationError> {
    value.trim().parse::<u64>().map_err(|_| {
        LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::ObservationUnavailable,
            format!("systemd property {name} is not an unsigned integer"),
        )
    })
}

#[cfg(target_os = "linux")]
fn parse_duration(value: &str, name: &str) -> Result<u64, LinuxHostVerificationError> {
    let value = value.trim();
    if value.eq_ignore_ascii_case("infinity") {
        return Err(LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::RuntimeProfileInvalid,
            format!("systemd property {name} is infinite"),
        ));
    }
    if let Ok(raw) = value.parse::<u64>() {
        return Ok(raw);
    }
    let (number, multiplier) = if let Some(number) = value.strip_suffix("us") {
        (number, 1_u64)
    } else if let Some(number) = value.strip_suffix("ms") {
        (number, 1_000_u64)
    } else if let Some(number) = value.strip_suffix('s') {
        (number, 1_000_000_u64)
    } else if let Some(number) = value.strip_suffix("min") {
        (number, 60_000_000_u64)
    } else if let Some(number) = value.strip_suffix('h') {
        (number, 3_600_000_000_u64)
    } else {
        return Err(LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::ObservationUnavailable,
            format!("systemd property {name} is not a duration"),
        ));
    };
    number
        .parse::<u64>()
        .ok()
        .and_then(|number| number.checked_mul(multiplier))
        .ok_or_else(|| {
            LinuxHostVerificationError::refused(
                LinuxHostVerificationCode::ObservationUnavailable,
                format!("systemd property {name} exceeds the supported duration range"),
            )
        })
}

#[cfg(target_os = "linux")]
fn parse_bool(value: &str, name: &str) -> Result<bool, LinuxHostVerificationError> {
    match value.trim().to_ascii_lowercase().as_str() {
        "yes" | "true" | "1" => Ok(true),
        "no" | "false" | "0" => Ok(false),
        _ => Err(LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::ObservationUnavailable,
            format!("systemd property {name} is not a boolean"),
        )),
    }
}

#[cfg(target_os = "linux")]
fn split_words(value: &str) -> Vec<String> {
    value
        .split_whitespace()
        .filter(|word| !word.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

#[cfg(target_os = "linux")]
fn parse_exec_start(value: &str) -> Vec<LinuxExecStart> {
    let value = value.trim();
    if value.is_empty() {
        return Vec::new();
    }
    let mut commands = Vec::new();
    for entry in value.split("}, {") {
        let path = property_fragment(entry, "path=");
        let argv = property_fragment(entry, "argv[]=");
        let flags = property_fragment(entry, "flags=");
        if let Some(path) = path {
            commands.push(LinuxExecStart {
                path: path.to_owned(),
                arguments: argv.map(split_words).unwrap_or_default(),
                flags: flags.map(split_words).unwrap_or_default(),
            });
        }
    }
    commands
}

#[cfg(target_os = "linux")]
fn property_fragment<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    let start = value.find(prefix)? + prefix.len();
    let rest = &value[start..];
    let end = rest.find(" ;").unwrap_or(rest.len());
    Some(rest[..end].trim_matches(|character| character == '{' || character == '}'))
}

#[cfg(target_os = "linux")]
fn parse_process_cgroup(value: &str) -> Option<String> {
    let mut unified = None;
    for line in value.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let mut parts = line.splitn(3, ':');
        let hierarchy = parts.next()?;
        let controllers = parts.next()?;
        let path = parts.next()?;
        if hierarchy != "0" || !controllers.is_empty() || unified.is_some() {
            return None;
        }
        unified = safe_cgroup_path(path);
    }
    unified
}

#[cfg(target_os = "linux")]
fn parse_process_ids(value: &str) -> Result<Vec<u32>, LinuxHostVerificationError> {
    value
        .split_whitespace()
        .map(|pid| {
            pid.parse::<u32>().map_err(|_| {
                LinuxHostVerificationError::refused(
                    LinuxHostVerificationCode::DelegatedRootInvalid,
                    "delegated root cgroup.procs contains an invalid process identifier",
                )
            })
        })
        .collect()
}

#[cfg(target_os = "linux")]
fn cgroup_mount_is_v2(path: &str) -> Result<bool, LinuxHostVerificationError> {
    let c_path = std::ffi::CString::new(path).map_err(|_| {
        LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::CgroupVersionUnavailable,
            "cgroup mount path contains a NUL byte",
        )
    })?;
    let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
    let result = unsafe { libc::statfs(c_path.as_ptr(), stat.as_mut_ptr()) };
    if result != 0 {
        return Err(LinuxHostVerificationError::refused(
            LinuxHostVerificationCode::CgroupVersionUnavailable,
            format!(
                "could not stat cgroup mount: {}",
                io::Error::last_os_error()
            ),
        ));
    }
    let stat = unsafe { stat.assume_init() };
    Ok(stat.f_type as u64 == 0x6367_7270)
}

#[cfg(target_os = "linux")]
fn observation_io_error(error: io::Error) -> LinuxHostVerificationError {
    LinuxHostVerificationError::refused(
        LinuxHostVerificationCode::ObservationUnavailable,
        error.to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_authority::{
        ConfigRevisionMapping, HostAuthorityRevision, ModuleActivationPremises,
        ResolvedConfiguration, RuntimeAuthorityIdentity,
    };
    use dolly_canonical_json::CanonicalJsonValue;
    use serde_json::{Value, json};
    use tempfile::{TempDir, tempdir};

    fn digest(value: &Value) -> Sha256Digest {
        canonicalize(value).unwrap().1
    }

    fn without(value: &Value, field: &str) -> Value {
        let mut object = value.as_object().unwrap().clone();
        object.remove(field);
        Value::Object(object)
    }

    fn authority_with_instance(instance_id: &str) -> CurrentAuthoritySnapshot {
        let origin = InstalledComponentOrigin {
            schema: "dolly.installed-component-origin/v1".into(),
            kind: "installed_product_component".into(),
            component_id: "org.dolly.host-runtime".into(),
            component_revision: 1,
            component_digest: digest(&json!({"component": "host-runtime"})),
        };
        let mut candidate_record = json!({
            "schema": "dolly.linux-service-candidate/v1",
            "origin": serde_json::to_value(&origin).unwrap(),
            "unit_name": "dollyd@main.service",
            "mode": "user",
            "candidate_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
        });
        candidate_record["candidate_digest"] =
            json!(digest(&without(&candidate_record, "candidate_digest")).to_string());
        let candidate: LinuxServiceCandidate = serde_json::from_value(candidate_record).unwrap();
        let config = ResolvedConfiguration {
            runtime_config: CanonicalJsonValue::try_from(json!({"modules": ["installed"]}))
                .unwrap(),
            permission_policy_selections: Vec::new(),
            service_candidate: Some(candidate.clone()),
        };
        let config_digest = canonicalize(&config).unwrap().1;
        let mut premise_record = json!({
            "schema": "dolly.module-activation-premises/v1",
            "daemon_installation_id": "0198ab31-6c44-7e8a-b2bb-000000000001",
            "instance_id": instance_id,
            "config_revision": 1,
            "config_digest": config_digest,
            "permission_policy_definitions": [],
            "permission_policy_backend_bindings": [],
            "service_candidate": serde_json::to_value(&candidate).unwrap(),
            "premises_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
        });
        premise_record["premises_digest"] =
            json!(digest(&without(&premise_record, "premises_digest")).to_string());
        let premise: ModuleActivationPremises = serde_json::from_value(premise_record).unwrap();
        CurrentAuthoritySnapshot {
            mapping: ConfigRevisionMapping {
                schema: "dolly.config-revision-mapping/v1".into(),
                daemon_installation_id: premise.daemon_installation_id.clone(),
                instance_id: premise.instance_id.clone(),
                config_revision: 1,
                config_digest,
                canonical_config: config,
            },
            premise: Some(premise),
        }
    }

    fn authority() -> CurrentAuthoritySnapshot {
        authority_with_instance("instance-one")
    }

    fn good_observation() -> LinuxHostObservation {
        LinuxHostObservation {
            platform: "linux".into(),
            manager_mode: "user".into(),
            unit_name: "dollyd@main.service".into(),
            unit_id: "dollyd@main.service".into(),
            unit_names: vec!["dollyd@main.service".into()],
            load_state: "loaded".into(),
            active_state: "active".into(),
            sub_state: "running".into(),
            result: "success".into(),
            self_pid: 4242,
            main_pid: 4242,
            control_group: "/user.slice/dollyd@main.service".into(),
            self_cgroup_path: "/user.slice/dollyd@main.service/core".into(),
            invocation_id: "2812432ad29e4d3bbd6776c62cafa929".into(),
            boot_id: "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9".into(),
            cgroup_v2: true,
            runtime: LinuxServiceRuntimeProfile {
                unit_type: "exec".into(),
                restart: "on-failure".into(),
                start_limit_burst: 5,
                start_limit_interval_usec: 20_000_000,
                kill_mode: "control-group".into(),
                send_sigkill: true,
                timeout_stop_usec: 20_000_000,
                delegate: true,
                delegate_subgroup: "core".into(),
                exit_type: "main".into(),
                restart_mode: "normal".into(),
                remain_after_exit: false,
                success_exit_status: Vec::new(),
                restart_prevent_exit_status: Vec::new(),
                pass_environment: Vec::new(),
                environment_files: Vec::new(),
                exec_start: vec![LinuxExecStart {
                    path: "/usr/bin/dollyd".into(),
                    arguments: vec!["/usr/bin/dollyd".into()],
                    flags: vec!["no-env-expand".into()],
                }],
            },
            user_linger: Some(true),
            delegated_root: LinuxDelegatedRootObservation {
                cgroup_path: "/user.slice/dollyd@main.service".into(),
                filesystem_path: "/sys/fs/cgroup/user.slice/dollyd@main.service".into(),
                owner_unit_name: "dollyd@main.service".into(),
                owner_manager_mode: "user".into(),
                process_ids: Vec::new(),
                controllers: vec!["cpu".into(), "memory".into(), "pids".into()],
                subtree_control: vec!["cpu".into(), "memory".into(), "pids".into()],
                cgroup_v2: true,
            },
            observation_generation: 7,
            observed_at_unix_millis: 1_755_876_800_000,
        }
    }

    fn durable_database() -> (TempDir, crate::Database) {
        let directory = tempdir().unwrap();
        let suffix = directory
            .path()
            .file_name()
            .expect("temp directory name")
            .to_string_lossy()
            .replace('.', "d")
            .to_ascii_lowercase();
        let instance_id = format!("instance-{suffix}");
        let path = directory.path().join("runtime.sqlite3");
        let snapshot = authority_with_instance(&instance_id);
        let db = crate::Database::open_for_migration(&path)
            .unwrap()
            .install_host_authority_revision(HostAuthorityRevision {
                identity: RuntimeAuthorityIdentity {
                    daemon_installation_id: snapshot.mapping.daemon_installation_id.clone(),
                    instance_id: snapshot.mapping.instance_id.clone(),
                },
                mapping: snapshot.mapping,
                premise: snapshot.premise,
            })
            .unwrap();
        (directory, db)
    }

    #[test]
    fn complete_observation_mints_only_private_test_proof() {
        let proof = verify_linux_host_observation(&authority(), good_observation()).unwrap();
        assert_eq!(proof.schema(), LINUX_HOST_VERIFICATION_PROOF_SCHEMA);
        assert_eq!(proof.config_revision(), 1);
        assert_eq!(proof.instance_id(), "instance-one");
        assert_eq!(
            proof.delegated_root().cgroup_path,
            "/user.slice/dollyd@main.service"
        );
    }

    #[test]
    fn service_and_root_mismatches_fail_closed() {
        let snapshot = authority();
        for mutate in [
            |observation: &mut LinuxHostObservation| observation.manager_mode = "system".into(),
            |observation: &mut LinuxHostObservation| observation.active_state = "failed".into(),
            |observation: &mut LinuxHostObservation| observation.main_pid = 0,
            |observation: &mut LinuxHostObservation| observation.self_cgroup_path = "/wrong".into(),
            |observation: &mut LinuxHostObservation| {
                observation.delegated_root.process_ids = vec![7]
            },
            |observation: &mut LinuxHostObservation| {
                observation.delegated_root.subtree_control = vec!["cpu".into()]
            },
        ] {
            let mut observation = good_observation();
            mutate(&mut observation);
            assert!(verify_linux_host_observation(&snapshot, observation).is_err());
        }
    }

    #[test]
    fn missing_or_stale_premise_never_reaches_private_observer() {
        let mut missing = authority();
        missing.premise = None;
        let error = verify_linux_host_observation(&missing, good_observation()).unwrap_err();
        assert_eq!(error.code, LinuxHostVerificationCode::PremiseMissing);

        let mut stale = authority();
        stale.mapping.config_digest = digest(&json!({"changed": true}));
        let error = verify_linux_host_observation(&stale, good_observation()).unwrap_err();
        assert_eq!(error.code, LinuxHostVerificationCode::PremiseDigestMismatch);
    }

    #[test]
    fn current_pointer_change_after_observation_never_mints_proof() {
        let (_directory, db) = durable_database();
        let connection = db.connection();
        let mut calls = 0;
        let result = verify_current_linux_host_with_observer(connection, |_candidate| {
            calls += 1;
            if calls == 2 {
                connection
                    .execute(
                        "UPDATE runtime_authority_state SET instance_id = 'changed-instance'",
                        [],
                    )
                    .unwrap();
            }
            Ok(good_observation())
        });
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err().code,
            LinuxHostVerificationCode::PremiseStale | LinuxHostVerificationCode::ObservationChanged
        ));
    }
}
