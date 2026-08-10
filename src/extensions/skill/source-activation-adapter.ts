import type { SourceActivationQueue } from "../../core/source-activation-queue.js";
import type { SkillSourceActivationRequest } from "./skill-refresh.js";

export type SkillSourceActivationSubmissionErrorCode =
  | "SKILL_SOURCE_ACTIVATION_MODULE_MISMATCH"
  | "SKILL_SOURCE_ACTIVATION_BACKPRESSURED";

export class SkillSourceActivationSubmissionError extends Error {
  constructor(
    readonly code: SkillSourceActivationSubmissionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SkillSourceActivationSubmissionError";
  }
}

/**
 * Converts the Skill watcher's typed hint into the generic Core source request.
 * A full queue is reported by throwing so `SkillRefreshScheduler` restores the
 * pending debounce window instead of marking a request live that was never
 * durably admitted.
 */
export function createSkillSourceActivationSubmitter(
  queue: SourceActivationQueue,
): (request: SkillSourceActivationRequest) => void {
  return (request) => {
    if (request.moduleId !== queue.moduleId) {
      throw new SkillSourceActivationSubmissionError(
        "SKILL_SOURCE_ACTIVATION_MODULE_MISMATCH",
        "The Skill refresh request does not belong to the source activation queue's Module",
      );
    }
    const result = queue.submit({
      idempotencyKey: request.idempotencyKey,
      body: {
        kind: "skill.refresh/1",
        reason: request.reason,
        requestedAt: request.requestedAt,
        signalCount: request.signalCount,
      },
    });
    if (result.status === "backpressured") {
      throw new SkillSourceActivationSubmissionError(
        "SKILL_SOURCE_ACTIVATION_BACKPRESSURED",
        "The Skill refresh remains pending because the source activation queue is at capacity",
      );
    }
  };
}
