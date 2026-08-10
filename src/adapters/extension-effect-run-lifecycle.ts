/**
 * Connects Extension process capability admission to the durable effect
 * journal. It records only identities and digests; capability arguments and
 * results are never written to the journal document.
 */

import {
  canonicalJsonDigest,
  type JsonValue,
} from "../core/canonical-json.js";
import {
  EffectIntentError,
  EffectIntentJournal,
  type EffectOutcome,
} from "../core/capabilities/effect-intent-journal.js";
import {
  ExtensionCapabilityError,
  isExtensionCapabilityPreflightRefusal,
} from "../core/extension-capability.js";
import type {
  ExtensionCapabilityEffectInvocation,
  ExtensionEffectRunLifecycle,
  ExtensionEffectRunRequest,
} from "../core/extension-process-host.js";
import type { DeliveryClaimIdentity } from "../core/delivery-store.js";
import {
  assertValidModuleSubmissionRecord,
  type ModuleSubmissionRecord,
} from "../core/module-process-records.js";

export interface ExtensionEffectJournalLifecycleOptions {
  readonly journal: EffectIntentJournal;
  /** Reads the exact submission Runtime persisted before actor execution. */
  readonly getModuleSubmissionRecord: (
    runId: string,
  ) => ModuleSubmissionRecord | undefined;
}

function unknownFailure(): EffectOutcome {
  return {
    kind: "unknown",
    reason: "the capability invocation did not settle a durable result",
  };
}

function provenNoEffect(): EffectOutcome {
  return {
    kind: "no-effect",
    detail: "the capability authority refused the invocation before its handler started",
  };
}

function resolveSubmittedRun(
  options: ExtensionEffectJournalLifecycleOptions,
  request: ExtensionEffectRunRequest,
): DeliveryClaimIdentity {
  const submission = options.getModuleSubmissionRecord(request.runId);
  assertValidModuleSubmissionRecord(submission);
  if (
    submission.moduleJobId !== request.moduleJobId ||
    submission.runId !== request.runId ||
    submission.attempt !== request.attempt ||
    submission.moduleGenerationId !== request.moduleGenerationId ||
    submission.processGenerationId !== request.processGenerationId
  ) {
    throw new Error("Module submission does not match the Host execution identity");
  }
  return {
    moduleJobId: submission.moduleJobId,
    runId: submission.runId,
    attempt: submission.attempt,
    claimToken: submission.claimToken,
    moduleGenerationId: submission.moduleGenerationId,
  };
}

/**
 * Builds the conservative product-before-bootstrap effect boundary.
 *
 * Every invocation needs a stable idempotency key. A successful invocation is
 * recorded as terminal, which proves its result but deliberately does not make
 * a failed Module Run retry-safe. Until a result journal or provider query can
 * recover that result, a later Run is denied rather than repeating the same
 * effect. A rejected invocation remains unknown because this generic adapter
 * cannot infer where an arbitrary handler's effect boundary lies.
 */
export function createExtensionEffectJournalLifecycle(
  options: ExtensionEffectJournalLifecycleOptions,
): ExtensionEffectRunLifecycle {
  return Object.freeze({
    resolveRunIdentity: (request: ExtensionEffectRunRequest) =>
      resolveSubmittedRun(options, request),
    openRun(identity: DeliveryClaimIdentity): void {
      options.journal.openRun(identity);
    },
    async invokeCapability(
      invocation: ExtensionCapabilityEffectInvocation,
      execute: () => Promise<JsonValue>,
    ) {
      if (invocation.idempotencyKey === undefined) {
        throw new ExtensionCapabilityError(
          "CAPABILITY_DENIED",
          "Durable capability effects require a stable idempotency key",
        );
      }
      let record;
      try {
        record = options.journal.recordNewIntent({
          ...invocation.identity,
          idempotencyKey: invocation.idempotencyKey,
          capabilityType: invocation.capabilityType,
          operation: invocation.operation,
          intent: {
            capabilityVersion: invocation.capabilityVersion,
            arguments: invocation.arguments,
          },
        });
      } catch (error) {
        if (error instanceof EffectIntentError) {
          throw new ExtensionCapabilityError(
            "CAPABILITY_DENIED",
            "Durable effect authorization was refused before input/output",
          );
        }
        throw error;
      }
      let result: Awaited<ReturnType<typeof execute>>;
      try {
        result = await execute();
      } catch (error) {
        options.journal.recordOutcome(
          invocation.identity,
          record.idempotencyKey,
          isExtensionCapabilityPreflightRefusal(error) ? provenNoEffect() : unknownFailure(),
        );
        throw error;
      }
      options.journal.recordOutcome(invocation.identity, record.idempotencyKey, {
        kind: "terminal",
        resultDigest: canonicalJsonDigest(result),
      });
      return result;
    },
    closeRun(identity: DeliveryClaimIdentity): void {
      options.journal.closeRun(identity);
    },
  });
}
