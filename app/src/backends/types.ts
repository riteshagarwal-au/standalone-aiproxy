/** Backend adapter contracts — Phase 2/3 multi-backend support. */

export type BackendName = 'copilot' | 'openai' | 'anthropic' | 'ollama' | 'azure-openai' | 'aws-bedrock';

export const BACKEND_NAMES: BackendName[] = ['copilot', 'openai', 'anthropic', 'ollama', 'azure-openai', 'aws-bedrock'];

export function isBackendName(v: unknown): v is BackendName {
  return typeof v === 'string' && (BACKEND_NAMES as string[]).includes(v);
}

/**
 * OpenAI-wire-compatible backends — the proxy builds the HTTP request itself
 * (base URL + auth headers) and reuses the existing fetch/streaming logic.
 */
export interface HttpAdapter {
  kind: 'http';
  getBaseUrl(): Promise<string>;
  getAuthHeaders(): Promise<Record<string, string>>;
  /** Optional query string appended after the path, e.g. Azure's `?api-version=...`. */
  getQuerySuffix?(): string;
  /** Whether this backend rejects OpenAI's `stream_options` field for a given model. */
  stripStreamOptionsFor?(model: string): boolean;
}

/**
 * Backends that don't speak the OpenAI HTTP wire format and must do their own
 * request/response translation (e.g. native Anthropic Messages API, AWS Bedrock).
 */
export interface NativeAdapter {
  kind: 'native';
  /** Non-streaming chat completion. `body`/return value are OpenAI chat-completion shaped. */
  chat(body: Record<string, unknown>): Promise<{ status: number; data: Record<string, unknown> }>;
  /** Streaming chat completion. Emits raw `data: ...\n\n` SSE lines via `onSSE`. */
  chatStream(
    body: Record<string, unknown>,
    onSSE: (line: string) => void,
  ): Promise<{ promptTokens: number; completionTokens: number; responseText: string }>;
  listModels(): Promise<Record<string, unknown>>;
}

export type BackendAdapter = HttpAdapter | NativeAdapter;
