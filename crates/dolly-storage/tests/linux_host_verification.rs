use dolly_canonical_json::{CanonicalJsonValue, Sha256Digest, canonicalize};
use dolly_storage::host_authority::{
    ConfigRevisionMapping, CurrentAuthoritySnapshot, InstalledComponentOrigin,
    LinuxServiceCandidate, ModuleActivationPremises, ResolvedConfiguration,
};
use dolly_storage::linux_host_verification::{
    LinuxDelegatedRootObservation, LinuxExecStart, LinuxHostObservation,
    LinuxServiceRuntimeProfile, VerifiedLinuxHostProof, verify_current_linux_host,
    verify_linux_host_observation,
};
use serde_json::{Value, json};

fn digest(value: &Value) -> Sha256Digest {
    canonicalize(value).unwrap().1
}

fn without(value: &Value, field: &str) -> Value {
    let mut object = value.as_object().unwrap().clone();
    object.remove(field);
    Value::Object(object)
}

fn authority() -> CurrentAuthoritySnapshot {
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
        runtime_config: CanonicalJsonValue::try_from(json!({"modules": ["installed"]})).unwrap(),
        permission_policy_selections: Vec::new(),
        service_candidate: Some(candidate.clone()),
    };
    let config_digest = canonicalize(&config).unwrap().1;
    let mut premise_record = json!({
        "schema": "dolly.module-activation-premises/v1",
        "daemon_installation_id": "0198ab31-6c44-7e8a-b2bb-000000000001",
        "instance_id": "instance-one",
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

#[test]
fn complete_observation_mints_only_live_host_proof() {
    let proof = verify_linux_host_observation(&authority(), good_observation()).unwrap();
    let _: &VerifiedLinuxHostProof = &proof;
    assert_eq!(
        proof.schema(),
        dolly_storage::linux_host_verification::LINUX_HOST_VERIFICATION_PROOF_SCHEMA
    );
    assert_eq!(proof.config_revision(), 1);
    assert_eq!(proof.instance_id(), "instance-one");
    assert_eq!(
        proof.service_candidate_digest().to_string(),
        authority()
            .premise
            .unwrap()
            .service_candidate
            .candidate_digest
            .to_string()
    );
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
        |observation: &mut LinuxHostObservation| observation.delegated_root.process_ids = vec![7],
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
fn missing_or_stale_premise_never_reaches_live_observation() {
    let mut missing = authority();
    missing.premise = None;
    let error = verify_linux_host_observation(&missing, good_observation()).unwrap_err();
    assert_eq!(
        error.code,
        dolly_storage::linux_host_verification::LinuxHostVerificationCode::PremiseMissing
    );

    let mut stale = authority();
    stale.mapping.config_digest = digest(&json!({"changed": true}));
    let error = verify_linux_host_observation(&stale, good_observation()).unwrap_err();
    assert_eq!(
        error.code,
        dolly_storage::linux_host_verification::LinuxHostVerificationCode::PremiseDigestMismatch
    );
}

#[cfg(target_os = "linux")]
#[test]
fn production_linux_seam_fails_closed_for_absent_candidate_unit() {
    let error = verify_current_linux_host(&authority()).unwrap_err();
    assert!(matches!(
        error.code,
        dolly_storage::linux_host_verification::LinuxHostVerificationCode::UnitMissing
            | dolly_storage::linux_host_verification::LinuxHostVerificationCode::ObservationUnavailable
            | dolly_storage::linux_host_verification::LinuxHostVerificationCode::CgroupPathMismatch
    ));
}
