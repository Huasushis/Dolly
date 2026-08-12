export interface AetherConfiguration {
  readonly baseUrl: URL;
  readonly apiKey: string;
  readonly publicSummary?: Record<string, unknown>;
}

export function loadAetherConfiguration(): AetherConfiguration;
export function probeAetherModels(configuration: AetherConfiguration): Promise<Record<string, unknown>>;
export function buildAetherChatRequest(
  messages: readonly Record<string, unknown>[],
  maximumOutputTokens?: number,
): Record<string, unknown>;

export function callAetherChat(
  configuration: AetherConfiguration,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>>;
