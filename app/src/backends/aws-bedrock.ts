/**
 * AWS Bedrock adapter — uses Bedrock's Converse/ConverseStream API, which is a single
 * request/response schema that works across model families (Nova, Claude, Gemma, Llama,
 * Mistral, etc.), instead of each family's own native wire format.
 */

import type { NativeAdapter } from './types';
import { openAIStreamChunk } from './anthropic-format';

// Friendly model id -> actual Bedrock modelId/inference-profile-id. This is what powers per-request
// model selection (e.g. from AItutor's admin dropdown) instead of always using one fixed model.
const BEDROCK_MODEL_CATALOG: Record<string, string> = {
  'claude-haiku-4.5': 'au.anthropic.claude-haiku-4-5-20251001-v1:0',
  'gemma-3-27b': 'google.gemma-3-27b-it',
};

/** Resolve the Bedrock modelId to use for a request: the catalog entry for the requested
 * friendly model name if known, otherwise AWS_BEDROCK_MODEL_ID if set, otherwise the first
 * catalog entry — so no model ever needs to be hardcoded in tfvars/env just to boot the backend. */
function getModelId(requestedModel?: string): string {
  if (requestedModel && BEDROCK_MODEL_CATALOG[requestedModel]) return BEDROCK_MODEL_CATALOG[requestedModel];
  if (process.env.AWS_BEDROCK_MODEL_ID) return process.env.AWS_BEDROCK_MODEL_ID;
  const fallback = Object.values(BEDROCK_MODEL_CATALOG)[0];
  if (!fallback) throw new Error('No Bedrock model configured: set AWS_BEDROCK_MODEL_ID or populate BEDROCK_MODEL_CATALOG');
  return fallback;
}

function getRegion(): string {
  return process.env.AWS_REGION ?? 'ap-southeast-2';
}

// Lazily import + construct the client so the SDK dependency is only required when this backend is selected.
async function getClient() {
  const { BedrockRuntimeClient } = await import('@aws-sdk/client-bedrock-runtime');
  // No explicit `credentials` — uses the AWS SDK default credential provider chain
  // (env vars → shared profile/AWS_PROFILE → SSO → instance role). See docs/PLAN.md Step 10.
  return new BedrockRuntimeClient({ region: getRegion() });
}

interface ConverseMessage {
  role: 'user' | 'assistant';
  content: Array<{ text: string }>;
}

/** Convert an OpenAI chat-completion request body into Converse API params. */
function openAIRequestToConverse(body: Record<string, unknown>) {
  const messages = (body.messages as Array<Record<string, unknown>>) ?? [];
  let system: Array<{ text: string }> | undefined;
  const converted: ConverseMessage[] = [];

  for (const m of messages) {
    const text = Array.isArray(m.content)
      ? (m.content as Array<Record<string, unknown>>).filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('\n')
      : String(m.content ?? '');
    if (m.role === 'system') {
      system = [...(system ?? []), { text }];
      continue;
    }
    // Converse only accepts 'user'/'assistant' roles.
    converted.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: [{ text }] });
  }

  const inferenceConfig: Record<string, unknown> = {};
  if (body.max_tokens !== undefined) inferenceConfig.maxTokens = Number(body.max_tokens);
  if (body.temperature !== undefined) inferenceConfig.temperature = body.temperature;
  if (body.top_p !== undefined) inferenceConfig.topP = body.top_p;
  if (body.stop !== undefined) inferenceConfig.stopSequences = Array.isArray(body.stop) ? body.stop : [String(body.stop)];

  return { messages: converted, system, inferenceConfig };
}

/** Convert a Converse API response into an OpenAI chat-completion response. */
function converseResponseToOpenAI(data: Record<string, unknown>, model: string): Record<string, unknown> {
  const message = ((data.output as Record<string, unknown>)?.message as Record<string, unknown>) ?? {};
  const blocks = (message.content as Array<Record<string, unknown>>) ?? [];
  const text = blocks.map(b => String(b.text ?? '')).join('');
  const usage = (data.usage as Record<string, number>) ?? {};
  const finishReason = data.stopReason === 'max_tokens' ? 'length' : 'stop';

  return {
    id: '',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finishReason }],
    usage: {
      prompt_tokens: usage.inputTokens ?? 0,
      completion_tokens: usage.outputTokens ?? 0,
      total_tokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    },
  };
}

export function makeBedrockAdapter(): NativeAdapter {
  return {
    kind: 'native',

    async chat(body) {
      const { ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime');
      const client = await getClient();
      const { system, messages, inferenceConfig } = openAIRequestToConverse(body);

      const command = new ConverseCommand({
        modelId: getModelId(String(body.model ?? '')),
        messages,
        system,
        inferenceConfig,
      });

      try {
        const resp = await client.send(command);
        return { status: 200, data: converseResponseToOpenAI(resp as unknown as Record<string, unknown>, String(body.model ?? '')) };
      } catch (err) {
        return { status: 502, data: { error: { message: String(err), type: 'bedrock_error' } } };
      }
    },

    async chatStream(body, onSSE) {
      const model = String(body.model ?? '');
      const { ConverseStreamCommand } = await import('@aws-sdk/client-bedrock-runtime');
      const client = await getClient();
      const { system, messages, inferenceConfig } = openAIRequestToConverse(body);

      const command = new ConverseStreamCommand({
        modelId: getModelId(model),
        messages,
        system,
        inferenceConfig,
      });

      let promptTokens = 0;
      let completionTokens = 0;
      const parts: string[] = [];

      try {
        const resp = await client.send(command);
        for await (const event of resp.stream ?? []) {
          if (event.contentBlockDelta?.delta?.text) {
            const text = event.contentBlockDelta.delta.text;
            parts.push(text);
            onSSE(openAIStreamChunk(model, { content: text }));
          } else if (event.metadata?.usage) {
            promptTokens = event.metadata.usage.inputTokens ?? promptTokens;
            completionTokens = event.metadata.usage.outputTokens ?? completionTokens;
          } else if (event.messageStop) {
            onSSE(openAIStreamChunk(model, {}, 'stop'));
            onSSE('data: [DONE]\n\n');
          }
        }
      } catch (err) {
        onSSE(`data: ${JSON.stringify({ error: { message: String(err), type: 'bedrock_error' } })}\n\n`);
        onSSE('data: [DONE]\n\n');
      }

      return { promptTokens, completionTokens, responseText: parts.join('') };
    },

    async listModels() {
      // Curated list of friendly model names selectable via the admin dropdown, filtered by
      // AWS_BEDROCK_MODELS_ALLOWLIST (comma-separated) if set, otherwise the full catalog.
      const allowlist = process.env.AWS_BEDROCK_MODELS_ALLOWLIST?.split(',').map(s => s.trim()).filter(Boolean);
      const ids = allowlist && allowlist.length > 0
        ? allowlist.filter(id => BEDROCK_MODEL_CATALOG[id])
        : Object.keys(BEDROCK_MODEL_CATALOG);
      return { object: 'list', data: ids.map(id => ({ id, object: 'model', created: 1700000000, owned_by: 'aws-bedrock' })) };
    },
  };
}
