/**
 * Shared OpenAI ⇄ Anthropic Messages format conversion, used by both the native
 * `anthropic` backend and the `aws-bedrock` backend (Claude models on Bedrock use
 * the same Anthropic Messages request/response shape).
 */

export interface AnthropicNativeRequest {
  model: string;
  system?: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  [key: string]: unknown;
}

/** Convert an OpenAI chat-completion request body into an Anthropic Messages request. */
export function openAIRequestToAnthropic(body: Record<string, unknown>): AnthropicNativeRequest {
  const messages = (body.messages as Array<Record<string, unknown>>) ?? [];
  let system: string | undefined;
  const converted: Array<{ role: string; content: string }> = [];

  for (const m of messages) {
    const content = Array.isArray(m.content)
      ? (m.content as Array<Record<string, unknown>>).filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('\n')
      : String(m.content ?? '');
    if (m.role === 'system') {
      system = system ? `${system}\n${content}` : content;
      continue;
    }
    converted.push({ role: String(m.role ?? 'user'), content });
  }

  const req: AnthropicNativeRequest = {
    model: String(body.model ?? ''),
    messages: converted,
    max_tokens: Number(body.max_tokens ?? 4096),
  };
  if (system) req.system = system;
  if (body.temperature !== undefined) req.temperature = body.temperature as number;
  if (body.top_p !== undefined) req.top_p = body.top_p as number;
  if (body.stop !== undefined) req.stop_sequences = Array.isArray(body.stop) ? body.stop as string[] : [String(body.stop)];

  return req;
}

/** Convert an Anthropic Messages response into an OpenAI chat-completion response. */
export function anthropicResponseToOpenAI(data: Record<string, unknown>, model: string): Record<string, unknown> {
  const contentBlocks = (data.content as Array<Record<string, unknown>>) ?? [];
  const text = contentBlocks.filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('');
  const usage = (data.usage as Record<string, number>) ?? {};
  const finishReason = data.stop_reason === 'max_tokens' ? 'length' : 'stop';

  return {
    id: data.id ?? '',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finishReason }],
    usage: {
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    },
  };
}

/** Build a single OpenAI-style SSE delta chunk. */
export function openAIStreamChunk(model: string, delta: Record<string, unknown>, finishReason: string | null = null): string {
  const chunk = {
    id: '',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}
