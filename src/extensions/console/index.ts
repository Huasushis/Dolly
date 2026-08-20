/**
 * The Dolly Console extension: the channel through which outside messages
 * enter the Block loop and Module output leaves it.
 *
 * Scope of this package, from `docs/spec/console-extension.md`:
 *
 * - external ingress becomes exactly one `dolly.content/1` BlockProposal per
 *   dispatched action, with one identifier-free message boundary per message
 *   (sections 5.3 and 5.5);
 * - every session owns its ingress queue, display stream, and cursor, and a
 *   new session chooses its start explicitly (sections 4.3 and 6.2);
 * - the egress role returns no BlockProposal and prepares one display handoff
 *   per frozen member (section 6.1); and
 * - browser and CLI clients share one validator, one envelope, and one set of
 *   error codes (section 8).
 *
 * Deliberately not in this package:
 *
 * - the HTTP/WebSocket listener, pairing, cookie, Origin, CSRF, and pre-parse
 *   size limits, which belong to the host gateway in
 *   `src/core/console-gateway.ts` and are used, not reimplemented, here;
 * - the browser front end (HTML, CSS, client script, Playwright baselines) of
 *   `console-extension.md` sections 11, 12, and 15.4;
 * - the upload streaming endpoints of section 7.1, which are represented here
 *   only by the `UploadGrantResolver` and `ConsoleAttachmentBinding` ports; and
 * - durable persistence. This implementation declares `volatile` durability and
 *   never reports a queue acceptance or display handoff as restart-safe.
 */

export { ConsoleExtensionError, consoleError, type ConsoleErrorCode } from "./errors.js";

export {
  parseExternalMessage,
  externalMessageDigest,
  externalChannelBoundarySchema,
  CONSOLE_CHANNEL_KIND,
  DEFAULT_EXTERNAL_MESSAGE_LIMITS,
  EXTERNAL_MESSAGE_SCHEMA,
  EXTERNAL_MESSAGE_TYPE,
  EXTERNAL_MESSAGE_VERSION,
  MESSAGE_BOUNDARY_FALLBACK_TEXT,
  MESSAGE_BOUNDARY_SCHEMA,
  type ConsoleExternalMessage,
  type ExternalAttachmentReference,
  type ExternalChannelKind,
  type ExternalMessageLimits,
} from "./external-message.js";

export {
  acceptedMessageRecord,
  ingressSnapshotDigest,
  type ConsoleAcceptedMessage,
  type ConsoleIngressSnapshot,
  type ConsoleResolvedMediaOccurrence,
} from "./ingress-records.js";

export {
  buildIngressProposal,
  ingressContentItems,
  measureIngressProposalBytes,
  messageBoundaryItem,
  verifyIngressProposal,
  BLOCK_CONTENT_SCHEMA,
  type IngressProposalVerification,
} from "./ingress-proposal.js";

export {
  freezeIngressSnapshot,
  DEFAULT_BATCH_LIMITS,
  type ConsoleBatchLimits,
  type FreezeIngressSnapshotInput,
} from "./ingress-snapshot.js";

export {
  authorizeDeliveredMediaDisplay,
  deriveDeliveredMediaScope,
  resolveAttachmentMedia,
  type DeliveredBlockGroup,
  type DeliveredMediaEntry,
  type UploadGrantResolution,
  type UploadGrantResolver,
} from "./media-contract.js";

export {
  presentBlock,
  DEFAULT_PRESENTATION_LIMITS,
  DISPLAY_ITEM_SCHEMA,
  type ConsolePresentationItem,
  type PresentationLimits,
} from "./presentation.js";

export {
  ConsoleSessionStore,
  DEFAULT_SESSION_LIMITS,
  type ConsoleAcceptanceReceipt,
  type ConsoleConsumerStart,
  type ConsoleDisplayItem,
  type ConsoleDisplayStart,
  type ConsoleRoute,
  type ConsoleRouteVisibility,
  type ConsoleSessionLimits,
  type ConsoleSessionState,
  type ConsoleSessionStoreOptions,
} from "./session-store.js";

export {
  ConsoleEgressCoordinator,
  assertEgressResultHasNoProposal,
  type EgressDisplayHandoffRecord,
  type EgressPreparedBlock,
  type PrepareDisplayInput,
  type PrepareDisplayOutcome,
} from "./egress-display.js";

export {
  ConsoleHttpChannel,
  assertLoopbackBinding,
  externalMessageFromGatewayQueue,
  startLoopbackGateway,
  type ConsoleAttachmentBinding,
  type ConsoleHttpChannelOptions,
  type IngestedMessage,
} from "./http-channel.js";

export {
  ConsoleWebChannel,
  loadConsoleClientApplication,
  type ConsoleWebChannelDisplayInput,
  type ConsoleWebChannelOptions,
} from "./web-channel.js";

export {
  buildCliExternalMessage,
  runConsoleCli,
  type ConsoleCliDependencies,
  type ConsoleCliIdentity,
  type ConsoleCliResult,
  type ConsoleCredentialSource,
} from "./cli-channel.js";
