/**
 * The Dolly daemon: one supervisor process that owns many instances.
 *
 * The pieces here are deliberately separate so each one can be tested against
 * the contract it implements: the total configuration and its loopback-only
 * listener (`security-operations.md` Sections 3 and 6), the instance registry
 * and its evidence (Sections 9 and 13), durable process records and identity
 * (Section 7.4), and the manager that composes `ProcessSupervisor` into
 * multi-instance lifecycle control (Sections 7.1 to 7.5 and 11).
 */

export {
  ALLOWED_DAEMON_LISTEN_HOSTS,
  DaemonConfigError,
  DaemonConfigStore,
  assertDaemonListenHost,
  daemonExposurePolicy,
  parseDaemonConfigDocument,
  redactDaemonConfig,
  verifyDaemonCredential,
  type DaemonConfigDocument,
  type DaemonConfigErrorCode,
  type DaemonConfigStoreOptions,
  type DaemonCredentialRecord,
  type DaemonListenHost,
  type InitializeDaemonConfigOptions,
  type LoadedDaemonConfig,
} from "./daemon-config.js";

export {
  DaemonInstanceManager,
  DaemonInstanceManagerError,
  type DaemonAuditEvent,
  type DaemonInstanceEvidence,
  type DaemonInstanceManagerErrorCode,
  type DaemonInstanceManagerOptions,
  type DaemonInstanceReport,
  type DaemonInstanceStatus,
} from "./daemon-instance-manager.js";

export {
  InstanceProcessRecordError,
  InstanceProcessRecordStore,
  deriveIpcSessionId,
  parseInstanceProcessRecord,
  type InstanceProcessRecord,
  type InstanceProcessRecordErrorCode,
  type InstanceProcessRecordState,
} from "./instance-process-record-store.js";

export {
  InstanceRegistryError,
  evaluateProcessRecord,
  instanceRecordsDirectory,
  probeInstanceControllerLock,
  provesRecordedProcessExited,
  readInstanceRegistry,
  type ControllerLockObservation,
  type InstanceRegistryErrorCode,
  type ProcessRecordEvidence,
  type RegisteredInstance,
} from "./instance-registry.js";

export {
  DaemonListenError,
  bindLoopbackServer,
  type BoundLoopbackAddress,
  type DaemonListenErrorCode,
} from "./loopback-listener.js";

export {
  LinuxProcIdentityProbe,
  PortableLivenessIdentityProbe,
  ProcessIdentityError,
  assertSignallablePid,
  createOsProcessIdentityProbe,
  observeProcessLiveness,
  parseProcStatStartTime,
  type ProcessIdentityObservation,
  type ProcessIdentityProbe,
  type ProcessLiveness,
} from "./process-identity.js";

export {
  ProcessGenerationError,
  ProcessGenerationSequence,
  formatProcessGenerationToken,
  parseProcessGenerationToken,
  type ProcessGenerationErrorCode,
  type ProcessGenerationSequenceOptions,
  type ProcessGenerationToken,
} from "./process-generation.js";
