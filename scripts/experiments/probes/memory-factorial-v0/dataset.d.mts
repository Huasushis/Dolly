import type {
  Checkpoint,
  EvidenceEntry,
  Scenario,
  SourceRecord,
} from "./types.d.mts";

export function generateDataset(): Scenario[];
export function retrieveContentRecords(scenario: Scenario): SourceRecord[];
export function buildRepeatedPositionEdges(records: SourceRecord[]): Array<{
  terms: string[];
  distinctEpisodes: number;
}>;
export function retrieveAssociationRecords(scenario: Scenario): SourceRecord[];
export function constructDeterministicCheckpoint(
  scenario: Scenario,
  associationRecords: SourceRecord[],
): Checkpoint;
export function buildCellEvidence(
  scenario: Scenario,
  cellId: string,
  checkpoint?: Checkpoint,
): EvidenceEntry[];
export function assertDatasetStructure(dataset: Scenario[]): true;
