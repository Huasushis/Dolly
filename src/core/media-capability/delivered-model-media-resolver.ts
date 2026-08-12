import {
  contentReferences,
  parseBlockContent,
  type MediaReferenceItem,
} from "../block-content.js";
import type { ExtensionSessionIdentity } from "../extension-capability.js";
import type {
  ModelInvocationContext,
  ModelMediaResolutionRequest,
  ModelMediaResolver,
  ModelResolvedMedia,
} from "../model-provider-broker.js";
import type {
  Media,
  MediaAccessGrant,
  ProviderAccessRequest,
} from "../media-store.js";
import type { DeliveredMediaClaim } from "./delivered-media-read-capability.js";

export interface InlineModelMediaSource {
  getMedia(mediaId: string): Media | null;
  resolveProviderAccess(request: ProviderAccessRequest): Promise<MediaAccessGrant>;
}

export interface DeliveredModelMediaResolverOptions {
  readonly claim: DeliveredMediaClaim;
  readonly session: ExtensionSessionIdentity;
  readonly source: InlineModelMediaSource;
  /** Re-checks the host's active-Run registry before and after the byte copy. */
  readonly isActiveRun: (context: ModelInvocationContext) => boolean;
  readonly now: () => string;
}

export class DeliveredModelMediaResolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveredModelMediaResolverError";
  }
}

function denied(): DeliveredModelMediaResolverError {
  return new DeliveredModelMediaResolverError(
    "Model Media is not authorized for the active delivered Module Run",
  );
}

function deliveredFullMediaIds(claim: DeliveredMediaClaim): ReadonlySet<string> {
  const mediaIds = new Set<string>();
  for (const group of claim.blockGroups) {
    let references: readonly MediaReferenceItem[];
    try {
      references = contentReferences(parseBlockContent(group.block.payload.value)).media;
    } catch {
      continue;
    }
    for (const reference of references) {
      if (reference.crop === undefined) mediaIds.add(reference.mediaId);
    }
  }
  return mediaIds;
}

function sameRun(
  context: ModelInvocationContext,
  claim: DeliveredMediaClaim,
  session: ExtensionSessionIdentity,
): boolean {
  return (
    context.instanceId === session.instanceId &&
    context.sessionId === session.sessionId &&
    context.moduleId === session.moduleId &&
    context.moduleGenerationId === session.moduleGenerationId &&
    context.moduleJobId === claim.moduleJobId &&
    context.runId === claim.runId &&
    context.attempt !== undefined
  );
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("cancelled");
}

async function waitWithSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return operation;
  throwIfCancelled(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Binds the broker's Host-only Media resolver to one authenticated Module Run
 * and the Media references in its immutable Delivery Claim.
 *
 * It deliberately supports only a full, inline PNG copy. URL delivery and
 * cropped access have different lifetime/outcome rules and are not silently
 * enabled here.
 */
export function createDeliveredModelMediaResolver(
  options: DeliveredModelMediaResolverOptions,
): ModelMediaResolver {
  const delivered = deliveredFullMediaIds(options.claim);
  return {
    async resolve(request, callOptions): Promise<ModelResolvedMedia> {
      const signal = callOptions.signal;
      throwIfCancelled(signal);
      if (
        request.schemaVersion !== "dolly.model.media-resolution-request/1" ||
        !sameRun(request.context, options.claim, options.session) ||
        !options.isActiveRun(request.context) ||
        !Number.isFinite(Date.parse(request.deadline)) ||
        Date.parse(request.deadline) > Date.parse(request.context.deadline) ||
        Date.parse(request.deadline) <= Date.parse(options.now()) ||
        request.mediaReference.type !== "media-reference" ||
        request.mediaReference.crop !== undefined ||
        !delivered.has(request.mediaReference.mediaId) ||
        request.acceptedAccessModes.length !== 1 ||
        request.acceptedAccessModes[0] !== "inline" ||
        request.requirement.modality !== "image" ||
        request.requirement.mimeTypes.length !== 1 ||
        request.requirement.mimeTypes[0] !== "image/png" ||
        request.requirement.deliveryModes.length !== 1 ||
        request.requirement.deliveryModes[0] !== "inline" ||
        request.requirement.providerFetchesAfterAcceptance ||
        request.requirement.lifetimeStrategyId !== "media.inline-copy.v1" ||
        request.requirement.placementStrategyId !==
          "openai.chat.media.inline-image-url.v1"
      ) {
        throw denied();
      }

      const media = options.source.getMedia(request.mediaReference.mediaId);
      if (
        !media ||
        media.mimeType !== "image/png" ||
        !Number.isSafeInteger(media.width) ||
        media.width === undefined ||
        media.width <= 0 ||
        !Number.isSafeInteger(media.height) ||
        media.height === undefined ||
        media.height <= 0 ||
        media.byteLength > request.limits.maxBytesForItem ||
        media.byteLength > request.limits.maxResolvedBytesRemaining
      ) {
        throw denied();
      }

      const grant = await waitWithSignal(
        options.source.resolveProviderAccess({
          mediaId: media.mediaId,
          requestId: request.mediaRequestId,
          recipientId: request.recipientId,
          acceptedAccessModes: ["inline"],
        }),
        signal,
      );
      throwIfCancelled(signal);
      if (!options.isActiveRun(request.context)) throw denied();
      if (
        grant.accessMode !== "inline" ||
        grant.mediaId !== media.mediaId ||
        grant.recipientId !== request.recipientId ||
        grant.inline.encoding !== "base64" ||
        grant.inline.byteLength !== media.byteLength ||
        grant.inline.mimeType !== media.mimeType
      ) {
        throw denied();
      }
      return Object.freeze({
        schemaVersion: "dolly.model.resolved-media/1" as const,
        modelRequestId: request.modelRequestId,
        mediaRequestId: request.mediaRequestId,
        recipientId: request.recipientId,
        descriptorDigest: request.descriptor.descriptorDigest,
        bindingRevision: request.binding.bindingRevision,
        messageIndex: request.messageIndex,
        partIndex: request.partIndex,
        requirementId: request.requirement.requirementId,
        mediaId: media.mediaId,
        digest: media.digest,
        mimeType: "image/png" as const,
        byteLength: media.byteLength,
        width: media.width,
        height: media.height,
        accessMode: "inline" as const,
        inline: {
          encoding: "base64" as const,
          data: grant.inline.data,
        },
      });
    },
  };
}
