/** Copilot adapter — wraps the existing token-exchange flow (Phase 1) as an HttpAdapter. */

import { getCopilotToken } from '../copilot-auth';
import type { HttpAdapter } from './types';

export function makeCopilotAdapter(integrationId: string): HttpAdapter {
  return {
    kind: 'http',
    async getBaseUrl() {
      const { baseUrl } = await getCopilotToken();
      return baseUrl;
    },
    async getAuthHeaders() {
      const { token } = await getCopilotToken();
      return {
        'copilot-integration-id': integrationId,
        'editor-version': 'vscode/1.99.0',
        'x-github-api-version': '2025-04-01',
        Authorization: `Bearer ${token}`,
      };
    },
    stripStreamOptionsFor(model: string) {
      return model.toLowerCase().includes('claude');
    },
  };
}
