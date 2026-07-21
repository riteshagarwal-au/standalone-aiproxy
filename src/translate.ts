/**
 * translate.ts
 *
 * Bidirectional translation between Anthropic Messages API and OpenAI Chat Completions API.
 * Copied as-is from vscode-CopilotProxy — pure logic, no VS Code dependency.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OpenAIMessage {
  role: string;
  content: string;
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  stop?: string | string[];
  tools?: unknown[];
  stream_options?: { include_usage: boolean };
  [key: string]: unknown;
}

export interface AnthropicContentBlock {
  type: string;
  text?: string;
  content?: unknown;
}

export interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentBlock[];
}

export interface AnthropicRequest {
  model?: string;
  system?: string | AnthropicContentBlock[];
  messages?: AnthropicMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  stop_sequences?: string[];
  tools?: unknown[];
  [key: string]: unknown;
}

// ── Anthropic → OpenAI ────────────────────────────────────────────────────────

export function anthropicToOpenAI(body: AnthropicRequest): OpenAIRequest {
  const messages: OpenAIMessage[] = [];

  // System prompt
  const system = body.system;
  if (system) {
    let text: string;
    if (Array.isArray(system)) {
      text = system
        .filter((b): b is AnthropicContentBlock => typeof b === 'object')
        .map(b => b.text ?? '')
        .join(' ');
    } else {
      text = String(system);
    }
    if (text.trim()) {
      messages.push({ role: 'system', content: text });
    }
  }

  // Conversation messages
  for (const msg of (body.messages ?? [])) {
    const role = msg.role ?? 'user';
    let content: string;

    if (Array.isArray(msg.content)) {
      const parts: string[] = [];
      for (const block of msg.content) {
        if (typeof block === 'object' && block !== null) {
          if (block.type === 'text') {
            parts.push(block.text ?? '');
          } else if (block.type === 'tool_result') {
            parts.push(String((block as AnthropicContentBlock).content ?? ''));
          }
        } else {
          parts.push(String(block));
        }
      }
      content = parts.join('\n');
    } else {
      content = String(msg.content ?? '');
    }

    messages.push({ role, content });
  }

  const result: OpenAIRequest = {
    model: body.model ?? 'gpt-4o',
    messages,
  };

  if (body.max_tokens !== undefined) result.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.stream !== undefined) result.stream = body.stream;
  if (body.stop_sequences !== undefined) result.stop = body.stop_sequences;
  if (body.tools !== undefined) result.tools = body.tools;

  return result;
}

// ── OpenAI → Anthropic ────────────────────────────────────────────────────────

export function openAIToAnthropicResponse(
  body: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const choices = (body.choices as Array<Record<string, unknown>>) ?? [];
  let text = '';
  let stopReason = 'end_turn';

  if (choices.length > 0) {
    const msg = (choices[0].message as Record<string, unknown>) ?? {};
    text = String(msg.content ?? '');
    const finish = String(choices[0].finish_reason ?? 'stop');
    stopReason = finish === 'stop' ? 'end_turn' : finish;
  }

  const usage = (body.usage as Record<string, number>) ?? {};

  return {
    id: body.id ?? '',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    },
  };
}

/** Strip stream_options from body when the model is Claude (unsupported). */
export function stripStreamOptionsForClaude(
  body: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  if (model.toLowerCase().includes('claude')) {
    const { stream_options: _so, ...rest } = body as Record<string, unknown>;
    return rest;
  }
  return body;
}
