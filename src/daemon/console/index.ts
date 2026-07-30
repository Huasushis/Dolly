/**
 * The daemon's management console: one control-plane operation layer plus two
 * equivalent exposures over it.
 *
 * `instance-topology.md` Section 5 defines the contract this directory
 * implements — one pipeline, two editing interfaces, and a capability parity
 * that a test can falsify. `security-operations.md` Sections 3, 4, 11, and 13.1
 * define the private binding, authentication, audit, and unknown-outcome rules
 * the Hypertext Transfer Protocol (HTTP) exposure enforces.
 */

export {
  AdminHttpServer,
  DEFAULT_ADMIN_HTTP_LIMITS,
  type AdminHttpLimits,
  type AdminHttpServerOptions,
} from "./admin-http-server.js";

export {
  ADMIN_SESSION_COOKIE,
  AdminSessionError,
  AdminSessionStore,
  DEFAULT_ADMIN_SESSION_LIMITS,
  parseCookieHeader,
  type AdminPairingHandle,
  type AdminSession,
  type AdminSessionErrorCode,
  type AdminSessionGrant,
  type AdminSessionLimits,
  type AdminSessionStoreOptions,
} from "./admin-sessions.js";

export {
  buildConsoleAuditEvent,
  type ConsoleActor,
  type ConsoleAuditEvent,
  type ConsoleAuditEventInput,
  type ConsoleAuditSink,
  type ConsoleInterfaceKind,
} from "./console-audit.js";

export {
  CONSOLE_CLI_COMMANDS,
  CONSOLE_CLI_HELP,
  ConsoleCliArgumentError,
  consoleCliExposedOperations,
  runConsoleCliCommand,
  type ConsoleCliContext,
  type ConsoleCliResult,
} from "./console-cli.js";

export {
  ConsoleOperations,
  type ConsoleOperationsOptions,
  type InstanceConfigurationView,
  type InstanceLifecycleControl,
  type TopologyCommitRequest,
  type TopologyCommitResult,
  type UnknownOutcomeDispositionRequestInput,
  type UnknownOutcomeDispositionResult,
} from "./console-operations.js";

export {
  deliveryStoreObligations,
  noRecordedObligations,
  pageObligationTotals,
  type ContractOwnedModule,
  type DeliveryStoreObligationOptions,
  type InstanceObligationSource,
  type InstanceObligations,
  type ModuleRuntimeObligation,
  type PageConsumerObligation,
  type PageRetentionFrontier,
} from "./instance-obligations.js";

export {
  CONSOLE_OPERATION_CATALOG,
  CONSOLE_OPERATION_CATALOG_VERSION,
  CONSOLE_OPERATION_NAMES,
  ConsoleOperationError,
  consoleErrorStatus,
  consoleOperationDeclaration,
  describeExposure,
  type ConsoleOperationDeclaration,
  type ConsoleOperationErrorCode,
} from "./operation-catalog.js";

export {
  buildTopologyCandidate,
  computeTopologyPlan,
  firstRejectedEntry,
  parseDispositions,
  parseModulePrivateStorage,
  parseStartPositions,
  parseTopologyProposal,
  type ModulePrivateStorageDecision,
  type ObligationDisposition,
  type TopologyCandidate,
  type TopologyChangeClassification,
  type TopologyChangePlan,
  type TopologyDispositionChoice,
  type TopologyPlanEntry,
  type TopologyPlanInput,
  type TopologyProposal,
  type TopologyStartPosition,
  type TopologyStartPositionChoice,
  type TopologySubmission,
} from "./topology-revision.js";

export {
  assertUnknownOutcomeDisposition,
  buildForcedReleaseWarning,
  buildPreservedClaim,
  deliveryClaimDispositionApplier,
  describeOfferedDispositions,
  evidenceDigest,
  externalEffectsThatMayRepeat,
  unprovenExternalEffects,
  type DeliveryClaimDispositionOperations,
  type ExternalEffectIntentEvidence,
  type PreservedUnknownOutcomeClaim,
  type UnknownOutcomeClaimStore,
  type UnknownOutcomeDisposition,
  type UnknownOutcomeDispositionOffer,
  type UnknownOutcomeDispositionOutcome,
  type UnknownOutcomeDispositionRequest,
  type UnknownOutcomeEvidence,
  type UnknownOutcomeWarning,
} from "./unknown-outcome.js";
