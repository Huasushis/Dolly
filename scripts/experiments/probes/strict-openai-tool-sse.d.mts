export interface StrictOpenAiToolSseOptions {
  readonly maximumResponseBytes?: number;
  readonly maximumBufferedBytes?: number;
  readonly maximumOutputBytes?: number;
  readonly maximumEvents?: number;
  readonly maximumToolCalls?: number;
}

export interface StrictOpenAiToolSseResult {
  readonly body: {
    readonly model: string;
    readonly choices: readonly [{
      readonly index: 0;
      readonly message: {
        readonly role: "assistant";
        readonly content: string | null;
        readonly reasoning_content: string;
        readonly tool_calls?: readonly unknown[];
      };
      readonly finish_reason: string;
    }];
    readonly usage: Record<string, unknown>;
  };
  readonly evidence: {
    readonly contentType: string;
    readonly responseBytes: number;
    readonly eventCount: number;
    readonly usageEventCount: number;
    readonly doneCount: number;
    readonly toolCallCount: number;
    readonly providerIdObserved: boolean;
  };
}

export function readStrictOpenAiToolSse(
  response: Response,
  options?: StrictOpenAiToolSseOptions,
): Promise<StrictOpenAiToolSseResult>;
