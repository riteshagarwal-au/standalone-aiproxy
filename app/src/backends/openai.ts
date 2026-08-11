/** OpenAI adapter — Phase 2. Plain passthrough to the OpenAI Chat Completions API. */

import type { HttpAdapter } from './types';

export function makeOpenAIAdapter(): HttpAdapter {
  return {
    kind: 'http',
    async getBaseUrl() {
      return process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
    },
    async getAuthHeaders() {
      const key = process.env.LLM_API_KEY;
      if (!key) throw new Error('LLM_API_KEY must be set for the "openai" backend');
      return { Authorization: `Bearer ${key}` };
    },
  };
}
