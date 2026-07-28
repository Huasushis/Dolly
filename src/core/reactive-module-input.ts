import {
  assertJsonValue,
  canonicalJsonByteLength,
  deepFreeze,
} from "./canonical-json.js";
import type { Block } from "./block-store.js";

export interface ReactiveModuleInputBlockGroup {
  readonly block: Block;
  readonly deliveryIds: readonly string[];
  readonly occurrenceCount: number;
  readonly firstGlobalSequence: string;
  readonly lastGlobalSequence: string;
}

export interface ReactiveModuleInput {
  readonly schemaVersion: "dolly.reactive-module-input/2";
  readonly claimedDeliveryIds: readonly string[];
  readonly blockGroups: readonly ReactiveModuleInputBlockGroup[];
  readonly hasMore: boolean;
}

export interface ReactiveModuleInputParts {
  readonly claimedDeliveryIds: readonly string[];
  readonly blockGroups: readonly ReactiveModuleInputBlockGroup[];
  readonly hasMore: boolean;
}

export function buildReactiveModuleInput(
  parts: ReactiveModuleInputParts,
): ReactiveModuleInput {
  const input: ReactiveModuleInput = {
    schemaVersion: "dolly.reactive-module-input/2",
    claimedDeliveryIds: [...parts.claimedDeliveryIds],
    blockGroups: parts.blockGroups.map((group) => ({
      block: group.block,
      deliveryIds: [...group.deliveryIds],
      occurrenceCount: group.occurrenceCount,
      firstGlobalSequence: group.firstGlobalSequence,
      lastGlobalSequence: group.lastGlobalSequence,
    })),
    hasMore: parts.hasMore,
  };
  assertJsonValue(input);
  return deepFreeze(input);
}

export function measureReactiveModuleInput(input: ReactiveModuleInput): number {
  return canonicalJsonByteLength(input);
}
