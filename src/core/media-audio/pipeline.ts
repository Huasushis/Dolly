import {
  AudioSegmenter,
  type AudioSegmentationOptions,
  type AudioSegment,
} from "./segmentation.js";
import type { Transcriber, TranscribedSegment } from "./transcriber.js";

export interface AudioTranscriptionPipelineOptions {
  readonly segmentation: AudioSegmentationOptions;
  readonly transcriber: Transcriber;
}

export interface AudioTranscriptionResult {
  readonly segments: readonly AudioSegment[];
  readonly transcriptions: readonly TranscribedSegment[];
}

/**
 * Composes deterministic audio segmentation with a transcriber.
 *
 * Segmentation runs first and synchronously; transcription follows in
 * segment order. Results carry both the segments and their transcriptions so
 * a caller can map text back to byte offsets and times.
 */
export class AudioTranscriptionPipeline {
  readonly #segmenter: AudioSegmenter;
  readonly #transcriber: Transcriber;

  constructor(options: AudioTranscriptionPipelineOptions) {
    this.#segmenter = new AudioSegmenter(options.segmentation);
    this.#transcriber = options.transcriber;
  }

  async transcribe(input: Uint8Array): Promise<AudioTranscriptionResult> {
    const segments = this.#segmenter.segment(input);
    const transcriptions = await this.#transcriber.transcribe(segments);
    return { segments, transcriptions };
  }
}