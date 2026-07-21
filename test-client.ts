/**
 * test-client.ts — OpenAI SDK smoke test for the standalone AI proxy.
 *
 * Run: npx tsx test-client.ts
 * Requires: proxy running + GITHUB_TOKEN set (or .env file present)
 *
 * Backend switching (Phase 2/3):
 *   LLM_BACKEND=ollama LLM_DEFAULT_MODEL=llama3.2 npx tsx test-client.ts
 *   LLM_BACKEND=openai LLM_API_KEY=sk-xxx        npx tsx test-client.ts
 */

import 'dotenv/config';
import OpenAI from 'openai';

const PROXY_URL   = process.env.PROXY_URL          ?? 'http://localhost:3100/v1';
const MODEL       = process.env.LLM_DEFAULT_MODEL  ?? 'claude-haiku-4.5';

const client = new OpenAI({
  baseURL: PROXY_URL,
  apiKey: 'unused',  // proxy handles auth — key is not needed here
});

async function main() {
  console.log(`Proxy URL : ${PROXY_URL}`);
  console.log(`Model     : ${MODEL}`);
  console.log('');

  // ── Test 1: Health check ─────────────────────────────────────────────────
  console.log('=== Test 1: Health check ===');
  const healthUrl = PROXY_URL.replace('/v1', '') + '/health';
  const health = await fetch(healthUrl).then(r => r.json());
  console.log('Health:', JSON.stringify(health, null, 2));
  console.log('');

  // ── Test 2: Basic chat ───────────────────────────────────────────────────
  console.log('=== Test 2: Basic chat ===');
  const res = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: 'What is 2+2? Answer in one word.' }],
  });
  console.log('Response:', res.choices[0].message.content);
  console.log('Usage:', res.usage);
  console.log('');

  // ── Test 3: Streaming ────────────────────────────────────────────────────
  console.log('=== Test 3: Streaming ===');
  const stream = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: 'Count from 1 to 5, one number per line.' }],
    stream: true,
  });
  process.stdout.write('Stream: ');
  for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
  }
  console.log('\n');

  // ── Test 4: System prompt ────────────────────────────────────────────────
  console.log('=== Test 4: System prompt ===');
  const res2 = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: 'You are a pirate. Always respond in pirate speak.' },
      { role: 'user', content: 'What is the weather like today?' },
    ],
  });
  console.log('Response:', res2.choices[0].message.content);
  console.log('');

  // ── Test 5: Models list ──────────────────────────────────────────────────
  console.log('=== Test 5: Models list ===');
  const models = await client.models.list();
  console.log(`Available models: ${models.data.length}`);
  console.log(models.data.slice(0, 5).map(m => `  - ${m.id}`).join('\n'));
  if (models.data.length > 5) console.log(`  ... and ${models.data.length - 5} more`);
  console.log('');

  console.log('All tests passed!');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
