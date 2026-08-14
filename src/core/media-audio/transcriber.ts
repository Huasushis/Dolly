import type { AudioSegment } from "./segmentation.js";

/**
 * One transcription result for one audio segment, keeping the segment's
 * position so a caller can reassemble the ordered transcript.
 */
export interface TranscribedSegment {
  /** Segment ordinal from the input segmentation. */
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
  /** Transcribed text for the segment. */
  readonly text: string;
}

/**
 * The injected speech-to-text boundary for the audio transcription path.
 *
 * A real implementation would call a model or local engine; this slice only
 * defines the contract. Implementations MUST return one result per input
 * segment, in input order, with position fields copied from the segment.
 */
export interface Transcriber {
  transcribe(segments: readonly AudioSegment[]): Promise<readonly TranscribedSegment[]>;
}