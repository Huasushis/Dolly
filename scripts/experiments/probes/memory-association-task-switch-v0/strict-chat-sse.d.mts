export interface StrictChatCompletionSseResult {
  readonly body: {
    readonly model: string | null;
    readonly choices: readonly [{
      readonly index: 0;
      readonly message: {
        readonly role: "assistant";
        readonly content: string;
        readonly reasoning_content: string;
      };
      readonly finish_reason: string | null;
    }];
    readonly usage: unknown;
    readonly error: null;
  };
  readonly evidence: {
    readonly contentType: string;
    readonly responseBytes: number;
    readonly eventCount: number;
    readonly usageEventCount: 1;
    readonly doneCount: 1;
    readonly providerIdObserved: boolean;
  };
}

export function readStrictChatCompletionSse(
  response: Response,
  options?: {
    readonly maximumResponseBytes?: number;
    readonly maximumBufferedBytes?: number;
    readonly maximumOutputBytes?: number;
    readonly maximumEvents?: number;
  },
): Promise<StrictChatCompletionSseResult>;

export function readBoundedResponseText(
  response: Response,
  maximumBytes?: number,
): Promise<string>;
