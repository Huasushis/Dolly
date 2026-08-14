import type { AudioSegment } from "./segmentation.js";
import type { Transcriber, TranscribedSegment } from "./transcriber.js";

/**
 * 32-bit Fowler–Noll–Vo variant 1a (FNV-1a) hash rendered as lowercase hex.
 * Deterministic across every JavaScript engine; used only to derive stable
 * fake transcription text from segment bytes.
 */
function fnv1aHex(bytes: Uint8Array): string {
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Deterministic stand-in for a real speech-to-text backend, for tests.
 *
 * The produced text is derived purely from each segment's bytes, so equal
 * input always yields equal output and different audio yields different
 * text (up to hash collision). It performs no I/O and allocates one string
 * per segment.
 */
export class DeterministicTranscriber implements Transcriber {
  async transcribe(
    segments: readonly AudioSegment[],
  ): Promise<readonly TranscribedSegment[]> {
    const results: TranscribedSegment[] = new Array(segments.length);
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      results[i] = {
        index: segment.index,
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: `segment ${segment.index}: ${fnv1aHex(segment.data)}`,
      };
    }
    return results;
  }
}