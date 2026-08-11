/** Native Anthropic Messages API adapter — Phase 2. Converts OpenAI wire format ⇄ Anthropic. */

import type { NativeAdapter } from './types';
import { openAIRequestToAnthropic, anthropicResponseToOpenAI, openAIStreamChunk } from './anthropic-format';

const ANTHROPIC_VERSION = '2023-06-01';

function getApiKey(): string {
  const key = process.env.LLM_API_KEY;
  if (!key) throw new Error('LLM_API_KEY must be set for the "anthropic" backend');
  return key;
}

function getBaseUrl(): string {
  return process.env.LLM_BASE_URL || 'https://api.anthropic.com/v1';
}

function headers(): Record<string, string> {
  return {
    'x-api-key': getApiKey(),
    'anthropic-version': ANTHROPIC_VERSION,
    'Content-Type': 'application/json',
  };
}

export function makeAnthropicAdapter(): NativeAdapter {
  return {
    kind: 'native',

    async chat(body) {
      const anthropicBody = openAIRequestToAnthropic(body);
      const resp = await fetch(`${getBaseUrl()}/messages`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(anthropicBody),
      });
      const data = await resp.json() as Record<string, unknown>;
      if (!resp.ok) return { status: resp.status, data };
      return { status: 200, data: anthropicResponseToOpenAI(data, String(body.model ?? '')) };
    },

    async chatStream(body, onSSE) {
      const model = String(body.model ?? '');
      const anthropicBody = { ...openAIRequestToAnthropic(body), stream: true };
      const resp = await fetch(`${getBaseUrl()}/messages`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(anthropicBody),
      });

      if (!resp.ok || !resp.body) {
        const errText = await resp.text();
        onSSE(`data: ${JSON.stringify({ error: { message: errText, code: String(resp.status) } })}\n\n`);
        onSSE('data: [DONE]\n\n');
        return { promptTokens: 0, completionTokens: 0, responseText: '' };
      }

      let promptTokens = 0;
      let completionTokens = 0;
      const parts: string[] = [];
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            const evt = JSON.parse(payload) as Record<string, unknown>;
            if (evt.type === 'content_block_delta') {
              const delta = (evt.delta as Record<string, unknown>) ?? {};
              const text = String(delta.text ?? '');
              if (text) { parts.push(text); onSSE(openAIStreamChunk(model, { content: text })); }
            } else if (evt.type === 'message_start') {
              const usage = ((evt.message as Record<string, unknown>)?.usage as Record<string, number>) ?? {};
              promptTokens = usage.input_tokens ?? promptTokens;
            } else if (evt.type === 'message_delta') {
              const usage = (evt.usage as Record<string, number>) ?? {};
              completionTokens = usage.output_tokens ?? completionTokens;
            } else if (evt.type === 'message_stop') {
              onSSE(openAIStreamChunk(model, {}, 'stop'));
              onSSE('data: [DONE]\n\n');
            }
          } catch { /* ignore malformed SSE line */ }
        }
      }

      return { promptTokens, completionTokens, responseText: parts.join('') };
    },

    async listModels() {
      // Anthropic has no public /models list endpoint — return the known Claude family.
      const ids = ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'];
      return { object: 'list', data: ids.map(id => ({ id, object: 'model', created: 1700000000, owned_by: 'anthropic' })) };
    },
  };
}
