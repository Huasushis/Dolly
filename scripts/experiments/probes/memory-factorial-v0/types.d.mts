export interface ClosedAction {
  operation: string;
  arguments: Record<string, string>;
}

export interface SourceRecord {
  id: string;
  episodeId: string;
  position: number;
  sequence: number;
  role: string;
  text: string;
}

export interface ClaimGroup {
  required: boolean;
  sufficientSourceSets: string[][];
}

export interface GroundTruth {
  decision: "resume" | "abstain";
  decisionReason: string;
  taskId: string;
  taskState: "active" | "cancelled" | "unknown";
  action: ClosedAction | null;
  constraints: { retentionDays: number | null };
  uncertain: boolean;
  initialAction: ClosedAction;
  replacementAction: ClosedAction;
  claimGroups: Record<"taskState" | "action" | "constraints", ClaimGroup>;
  forbiddenSourceIds: string[];
}

export interface Scenario {
  schemaVersion: string;
  scenarioId: string;
  split: string;
  seed: number;
  taskFamily: string;
  cueType: string;
  records: SourceRecord[];
  activeContext: Array<{ id: string; role: string; text: string }>;
  query: string;
  groundTruth: GroundTruth;
}

export interface EvidenceEntry {
  id: string;
  kind: "raw-record" | "deterministic-checkpoint";
  text: string;
  sourceRecordIds: string[];
}

export interface Checkpoint {
  schemaVersion: string;
  checkpointId: string;
  scenarioId: string;
  taskId: string;
  taskState: "active" | "cancelled" | "unknown";
  action: ClosedAction | null;
  constraints: { retentionDays: number | null };
  support: Record<"taskState" | "action" | "constraints", string[]>;
  sourceRecordIds: string[];
  construction: { kind: string; inputRecordIds: string[] };
}

export interface DecisionOutput {
  schemaVersion: string;
  decision: "resume" | "abstain";
  decisionReason: string;
  taskId: string;
  taskState: "active" | "cancelled" | "unknown";
  action: ClosedAction | null;
  constraints: { retentionDays: number | null };
  support: Record<"taskState" | "action" | "constraints", string[]>;
  uncertain: boolean;
}

export interface CaseMetrics {
  semanticCaseSuccess: number;
  formatValid: number;
  formatErrors: string[];
  fields: Record<string, number>;
  claimCoverage: Record<string, number>;
  citationPrecision: number;
  invalidCitationCount: number;
  unrelatedRecordUse: number;
  falseResume: number;
  oldActionUse: number;
  corroboratingConstraintSources: number;
}

export interface CaseRow {
  schemaVersion: string;
  caseId: string;
  scenarioId: string;
  seed: number;
  taskFamily: string;
  cueType: string;
  cellId: string;
  evidence: EvidenceEntry[];
  evidenceBytes: number;
  output: DecisionOutput;
  metrics: CaseMetrics;
}

export interface ArtifactBundle {
  freeze: Record<string, unknown>;
  preregistration: Record<string, unknown> & {
    domainDesign: {
      datasetSha256: string;
      implementationFiles: Array<{ path: string; sha256: string }>;
    };
  };
  dataset: Scenario[];
  checkpoints: Checkpoint[];
  cases: CaseRow[];
  analysis: Record<string, unknown>;
  manifest: Record<string, unknown>;
  checksums: Record<string, string>;
}

export interface ValidationResult {
  valid: boolean;
  schemaVersion: string;
  experimentId: string;
  experimentVersion: number;
  checks: Record<string, number>;
  errors: string[];
  recomputedAnalysis: Record<string, unknown>;
}
