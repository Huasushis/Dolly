import type { JsonValue } from "../../schema-bundle/index.js";
import type { JsonObject } from "./types.js";

/**
 * Neighbor Descriptor projection for `BuildManifest` construction.
 *
 * Implements the frozen neighbor-snapshot rules of dolly-spec
 * `06-module-descriptor.md` ("Frozen neighbor snapshot"): for the receiving
 * Module, every input-Page producer contributes an `input_producer`
 * relationship and its `emits` contract; every subscribed Module on an output
 * Page contributes an `output_consumer` relationship plus its `accepts`
 * contract and targetable Actions. Neighbors are deduplicated by Module ID
 * with both relationship labels and both authorized field sets, the wrapper
 * excludes the source Descriptor's own identity (`schema`) and any metadata
 * outside the authorized namespaces, and entries are ordered by
 * `(module_id, descriptor_revision)`.
 *
 * The wrapper is not a `dolly.module-descriptor/v1` record; it carries only
 * the projected relationship and authorization fields. The receiving Module
 * itself is never included as a neighbor here; a real self-delivery path
 * (spec step 4) is not exercised by any current vector.
 */

export interface NeighborGraphInput {
  /** Module whose Activation manifest is being built. */
  receiving_module: string;
  /** Module ID to the IDs of the input Pages it consumes. */
  input_pages: Record<string, string[]>;
  /** Module ID to the IDs of the Pages it produces into. */
  output_pages: Record<string, string[]>;
  /** Page ID to the Module IDs subscribed to that Page. */
  subscriptions: Record<string, string[]>;
  /** Neighbor Module ID to its frozen `dolly.module-descriptor/v1` value. */
  descriptors: Record<string, JsonObject>;
  /** Namespaces the receiving Module is authorized to see in neighbor metadata. */
  authorized_metadata_namespaces: string[];
}

export interface NeighborDescriptor {
  module_id: string;
  descriptor_revision: number;
  relationships: string[];
  projection: JsonObject;
}

const INPUT_PRODUCER = "input_producer";
const OUTPUT_CONSUMER = "output_consumer";

interface Relationship {
  inputProducer: boolean;
  outputConsumer: boolean;
}

export function buildNeighborDescriptors(graph: NeighborGraphInput): NeighborDescriptor[] {
  const receivingPages = new Set(graph.input_pages[graph.receiving_module] ?? []);
  const receivingOutputPages = new Set(graph.output_pages[graph.receiving_module] ?? []);
  const relationships = new Map<string, Relationship>();

  for (const [moduleId, pages] of Object.entries(graph.output_pages)) {
    if (moduleId === graph.receiving_module) continue;
    if (!pages.some((page) => receivingPages.has(page))) continue;
    const relation = relationships.get(moduleId) ?? { inputProducer: false, outputConsumer: false };
    relation.inputProducer = true;
    relationships.set(moduleId, relation);
  }
  for (const [page, subscribers] of Object.entries(graph.subscriptions)) {
    if (!receivingOutputPages.has(page)) continue;
    for (const moduleId of subscribers) {
      if (moduleId === graph.receiving_module) continue;
      const relation = relationships.get(moduleId) ?? { inputProducer: false, outputConsumer: false };
      relation.outputConsumer = true;
      relationships.set(moduleId, relation);
    }
  }

  return [...relationships.entries()]
    .map(([moduleId, relation]) => projectNeighbor(moduleId, relation, graph))
    .filter((neighbor): neighbor is NeighborDescriptor => neighbor !== null)
    .sort((left, right) => left.module_id.localeCompare(right.module_id) || left.descriptor_revision - right.descriptor_revision);
}

function projectNeighbor(moduleId: string, relation: Relationship, graph: NeighborGraphInput): NeighborDescriptor | null {
  const descriptor = graph.descriptors[moduleId];
  if (descriptor === undefined || typeof descriptor.descriptor_revision !== "number") return null;
  const labels: string[] = [];
  if (relation.inputProducer) labels.push(INPUT_PRODUCER);
  if (relation.outputConsumer) labels.push(OUTPUT_CONSUMER);

  const projection: JsonObject = {};
  if (relation.inputProducer) projection.emits = descriptor.emits;
  if (relation.outputConsumer) {
    projection.accepts = descriptor.accepts;
    projection.actions = descriptor.actions;
  }
  projection.metadata = authorizedMetadata(descriptor.metadata, graph.authorized_metadata_namespaces);
  return { module_id: moduleId, descriptor_revision: descriptor.descriptor_revision, relationships: labels, projection };
}

function authorizedMetadata(metadata: JsonValue, namespaces: string[]): JsonObject {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const source = metadata as JsonObject;
  const filtered: JsonObject = {};
  for (const namespace of namespaces) {
    if (namespace in source) filtered[namespace] = source[namespace];
  }
  return filtered;
}