/** Backend registry, runtime selection (Step 8b admin switcher), and disk persistence. */

import * as fs from 'fs';
import * as path from 'path';
import type { BackendAdapter, BackendName } from './types';
import { isBackendName, BACKEND_NAMES } from './types';
import { makeCopilotAdapter } from './copilot';
import { makeOpenAIAdapter } from './openai';
import { makeOllamaAdapter } from './ollama';
import { makeAnthropicAdapter } from './anthropic';
import { makeAzureOpenAIAdapter } from './azure-openai';
import { makeBedrockAdapter } from './aws-bedrock';

export type { BackendAdapter, BackendName } from './types';
export { BACKEND_NAMES, isBackendName } from './types';

let _currentBackend: BackendName = isBackendName(process.env.LLM_BACKEND) ? process.env.LLM_BACKEND : 'copilot';
let _overrideFilePath: string | undefined;

/** Load a persisted backend override (if any) — falls back to LLM_BACKEND env var / 'copilot'. */
export function initBackendPersistence(storageDir: string): void {
  _overrideFilePath = path.join(storageDir, 'backend-override.json');
  try {
    if (fs.existsSync(_overrideFilePath)) {
      const data = JSON.parse(fs.readFileSync(_overrideFilePath, 'utf8')) as { backend?: string };
      if (isBackendName(data.backend)) _currentBackend = data.backend;
    }
  } catch { /* ignore — keep env-var default */ }
}

export function getCurrentBackend(): BackendName {
  return _currentBackend;
}

/** Switch the active backend at runtime and persist the choice to disk (survives restarts/redeploys). */
export function setCurrentBackend(name: BackendName): void {
  _currentBackend = name;
  if (_overrideFilePath) {
    try {
      fs.mkdirSync(path.dirname(_overrideFilePath), { recursive: true });
      fs.writeFileSync(_overrideFilePath, JSON.stringify({ backend: name }, null, 2), 'utf8');
    } catch { /* ignore — in-memory selection still applies */ }
  }
}

export function getAdapter(integrationId: string): BackendAdapter {
  switch (_currentBackend) {
    case 'openai': return makeOpenAIAdapter();
    case 'anthropic': return makeAnthropicAdapter();
    case 'ollama': return makeOllamaAdapter();
    case 'azure-openai': return makeAzureOpenAIAdapter();
    case 'aws-bedrock': return makeBedrockAdapter();
    case 'copilot':
    default: return makeCopilotAdapter(integrationId);
  }
}

/** Env vars each backend needs already present before it can be switched to (Step 8b validation). */
export function missingRequiredEnv(name: BackendName): string[] {
  const need: Record<BackendName, string[]> = {
    copilot: [], // GHU_APP_TOKEN resolved via device flow if absent
    openai: ['LLM_API_KEY'],
    anthropic: ['LLM_API_KEY'],
    ollama: [],
    'azure-openai': ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT'],
    'aws-bedrock': [], // model resolved from BEDROCK_MODEL_CATALOG / AWS_BEDROCK_MODEL_ID (both optional, see aws-bedrock.ts)
  };
  return (need[name] ?? []).filter(k => !process.env[k]);
}

export { BACKEND_NAMES as ALL_BACKENDS };
