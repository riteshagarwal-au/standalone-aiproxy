/** Azure AI Foundry (Azure OpenAI) adapter — Phase 3, Step 9. */

import type { HttpAdapter } from './types';

export function makeAzureOpenAIAdapter(): HttpAdapter {
  return {
    kind: 'http',
    async getBaseUrl() {
      const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
      const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
      if (!endpoint || !deployment) {
        throw new Error('AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_DEPLOYMENT must be set for the "azure-openai" backend');
      }
      return `${endpoint.replace(/\/$/, '')}/openai/deployments/${deployment}`;
    },
    async getAuthHeaders() {
      const key = process.env.AZURE_OPENAI_API_KEY;
      if (!key) throw new Error('AZURE_OPENAI_API_KEY must be set for the "azure-openai" backend');
      return { 'api-key': key };
    },
    getQuerySuffix() {
      const version = process.env.AZURE_OPENAI_API_VERSION ?? '2024-02-01';
      return `?api-version=${version}`;
    },
  };
}
