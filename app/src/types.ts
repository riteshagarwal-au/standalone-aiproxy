/** Shared TypeScript interfaces for Standalone AI Proxy. */

export interface SessionMetrics {
  total_requests: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  uptime_seconds: number;
  per_model: Record<string, ModelMetrics>;
}

export interface ModelMetrics {
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  avg_latency_ms: number;
  first_seen: number | null;
  last_seen: number | null;
  _latency_sum: number;
}

export interface CumulativeMetrics extends Omit<SessionMetrics, 'uptime_seconds'> {
  per_model: Record<string, ModelMetrics>;
}

export interface ExchangeEntry {
  request_id: string;
  model: string;
  input: string;
  output: string;
  prompt_tokens: number;
  timestamp: string;
}

/** Standalone proxy config — loaded from environment variables. */
export interface ProxyConfig {
  port: number;
  host: string;
  rateLimitSeconds: number;
  rateLimitWait: boolean;
  logRequests: boolean;
  showToken: boolean;
  storageDir: string;
  integrationId: string;
}
