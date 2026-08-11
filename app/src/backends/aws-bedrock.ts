/** AWS Bedrock adapter — Phase 3, Step 10. Currently supports Anthropic Claude models via Bedrock's InvokeModel API. */

import type { NativeAdapter } from './types';
import { openAIRequestToAnthropic, anthropicResponseToOpenAI, openAIStreamChunk } from './anthropic-format';

const BEDROCK_ANTHROPIC_VERSION = 'bedrock-2023-05-31';

function getModelId(): string {
  const id = process.env.AWS_BEDROCK_MODEL_ID;
  if (!id) throw new Error('AWS_BEDROCK_MODEL_ID must be set for the "aws-bedrock" backend');
  return id;
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

export function makeBedrockAdapter(): NativeAdapter {
  return {
    kind: 'native',

    async chat(body) {
      const { InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');
      const client = await getClient();
      const { model: _model, ...anthropicBody } = openAIRequestToAnthropic(body);
      const payload = { anthropic_version: BEDROCK_ANTHROPIC_VERSION, ...anthropicBody };

      const command = new InvokeModelCommand({
        modelId: getModelId(),
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(payload),
      });

      try {
        const resp = await client.send(command);
        const data = JSON.parse(Buffer.from(resp.body as Uint8Array).toString('utf8')) as Record<string, unknown>;
        return { status: 200, data: anthropicResponseToOpenAI(data, String(body.model ?? '')) };
      } catch (err) {
        return { status: 502, data: { error: { message: String(err), type: 'bedrock_error' } } };
      }
    },

    async chatStream(body, onSSE) {
      const model = String(body.model ?? '');
      const { InvokeModelWithResponseStreamCommand } = await import('@aws-sdk/client-bedrock-runtime');
      const client = await getClient();
      const { model: _model, ...anthropicBody } = openAIRequestToAnthropic(body);
      const payload = { anthropic_version: BEDROCK_ANTHROPIC_VERSION, ...anthropicBody };

      const command = new InvokeModelWithResponseStreamCommand({
        modelId: getModelId(),
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(payload),
      });

      let promptTokens = 0;
      let completionTokens = 0;
      const parts: string[] = [];

      try {
        const resp = await client.send(command);
        for await (const event of resp.body ?? []) {
          if (!event.chunk?.bytes) continue;
          const evt = JSON.parse(Buffer.from(event.chunk.bytes).toString('utf8')) as Record<string, unknown>;
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
        }
      } catch (err) {
        onSSE(`data: ${JSON.stringify({ error: { message: String(err), type: 'bedrock_error' } })}\n\n`);
        onSSE('data: [DONE]\n\n');
      }

      return { promptTokens, completionTokens, responseText: parts.join('') };
    },

    async listModels() {
      // Bedrock model IDs are cross-region inference profiles, not a fixed list — return the configured one.
      const id = process.env.AWS_BEDROCK_MODEL_ID ?? 'unknown';
      return { object: 'list', data: [{ id, object: 'model', created: 1700000000, owned_by: 'aws-bedrock' }] };
    },
  };
}
