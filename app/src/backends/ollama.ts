/** Ollama adapter — Phase 2. OpenAI-compatible local endpoint, no auth. */

import type { HttpAdapter } from './types';

export function makeOllamaAdapter(): HttpAdapter {
  return {
    kind: 'http',
    async getBaseUrl() {
      return process.env.LLM_BASE_URL || 'http://localhost:11434/v1';
    },
    async getAuthHeaders() {
      return {};
    },
  };
}
