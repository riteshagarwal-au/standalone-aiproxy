# Standalone Copilot Proxy — Build Plan

## Goal

Extract the Copilot proxy from the VS Code extension into a standalone Node.js HTTP service.
Any AI app communicates with LLMs via this proxy using standard OpenAI-compatible API calls.
The proxy is fully decoupled from any app, reusable, and extractable to a separate service later.

The proxy is **multi-backend**: switch between Copilot, Anthropic, OpenAI, Ollama (or any
OpenAI-compatible API) by changing environment variables — no code changes, no app restarts required.

---

## Target Architecture

```
AI App  ──HTTP──►  Proxy (standalone Node.js)  ──► [backend selection]
                        localhost:3100/v1               ──►  api.githubcopilot.com
                                                        ──►  api.anthropic.com
                                                        ──►  api.openai.com
                                                        ──►  http://localhost:11434 (Ollama)
```

Your AI app uses the standard OpenAI SDK — no Copilot-specific code needed:

```typescript
import OpenAI from 'openai';
const client = new OpenAI({ baseURL: 'http://localhost:3100/v1', apiKey: 'unused' });
const res = await client.chat.completions.create({ model: 'claude-sonnet-4.6', messages: [...] });
```

---

## Two Future Deployment Modes

| Mode | Description |
|------|-------------|
| **Mode 1 (now)** | AI App + Proxy run locally, different ports |
| **Mode 2 (later)** | Proxy extracted to its own container/service |

Moving from Mode 1 → Mode 2 only requires changing the `baseURL` in the AI app.

---

## What Changes from the VS Code Extension Version

The existing `vscode-CopilotProxy` has two VS Code dependencies to remove:

| Dependency | Location | Replacement |
|------------|----------|-------------|
| `vscode.authentication.getSession()` | `copilot-auth.ts` | Read `GITHUB_TOKEN` env var |
| `vscode.workspace.getConfiguration()` | `proxy-server.ts` | Read env vars or `.env` file |

Everything else (HTTP server, routing, streaming, Anthropic translation, metrics) is pure Node.js — **zero changes needed**.

---

## Build Steps

### Phase 1 — Standalone Copilot Proxy ✅ COMPLETED

#### Key Auth Findings (discovered during implementation)

| Token type | Exchange endpoint | Copilot LLM API | Notes |
|------------|------------------|-----------------|-------|
| Classic PAT `ghp_` | ❌ 404 | ❌ 400 explicit rejection | Not supported |
| GitHub App IAT `ghs_` | ❌ N/A | ❌ No permissions | Management only |
| OAuth token `gho_` (VS Code) | ❌ 403 | ✅ gpt models only | Wrong endpoint |
| Device Flow token `ghu_` | ✅ 200 → JWT | ✅ All models | **This is the solution** |

**Enterprise accounts**: token exchange returns 404 by design → proxy uses `ghu_` token directly.
**`copilot-integration-id: vscode-chat`** is required — other values return 400 on Enterprise.

#### Step 1 — Scaffold the project
```
standalone-aiproxy-copilot/
  src/
    backends/
      copilot.ts         ← Phase 2: Copilot auth adapter
      anthropic.ts       ← Phase 2: Anthropic auth adapter
      openai.ts          ← Phase 2: OpenAI auth adapter
      ollama.ts          ← Phase 2: Ollama adapter (no auth)
      index.ts           ← Phase 2: backend selector
    copilot-auth.ts      ← strip vscode.authentication, use GITHUB_TOKEN env var
    proxy-server.ts      ← strip vscode.workspace.getConfiguration, use env/config
    translate.ts         ← copy as-is (pure logic)
    types.ts             ← copy as-is
    index.ts             ← new entry point: load config, start HTTP server
  package.json
  tsconfig.json
  .env.example
```

### Step 2 — Replace VS Code auth (`copilot-auth.ts`)
```typescript
async function getGitHubToken(): Promise<string> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN environment variable is not set');
  return token;
}
```
- Set `GITHUB_TOKEN` to a PAT with `read:user` scope
- Generate at: https://github.com/settings/tokens
- **Must belong to a GitHub Copilot subscriber**

### Step 3 — Replace VS Code config (`proxy-server.ts`)
```typescript
// Load from environment variables with sensible defaults
const config: ProxyConfig = {
  port: parseInt(process.env.PROXY_PORT ?? '3100'),
  rateLimitSeconds: parseFloat(process.env.PROXY_RATE_LIMIT_SECONDS ?? '0'),
  showToken: process.env.PROXY_SHOW_TOKEN === 'true',
  metricsFile: process.env.PROXY_METRICS_FILE ?? '',
};
```

### Step 4 — Entry point (`index.ts`)
```typescript
import { startProxyServer } from './proxy-server';
startProxyServer();
```

### Step 5 — Environment file (`.env`)
```
# Required: GitHub OAuth token obtained via Device Flow (one-time setup)
# Token does not expire. Run proxy once without this set to trigger Device Flow.
GHU_APP_TOKEN=ghu_your_oauth_token_here

# Required for Enterprise Copilot accounts
PROXY_INTEGRATION_ID=vscode-chat

# Optional
PROXY_PORT=3100
PROXY_RATE_LIMIT_SECONDS=0
PROXY_SHOW_TOKEN=false
PROXY_METRICS_FILE=
```

---

### Phase 2 — Multi-Backend Support

#### Step 6 — Backend config (env vars)
```
# Select backend: copilot | openai | anthropic | ollama
LLM_BACKEND=copilot

# Override base URL (optional — auto-resolved from LLM_BACKEND if not set)
LLM_BASE_URL=

# API key (GITHUB_TOKEN for copilot, OPENAI_API_KEY, ANTHROPIC_API_KEY, empty for ollama)
LLM_API_KEY=

# Default model when none specified by the caller
LLM_DEFAULT_MODEL=claude-haiku-4.5
```

#### Step 7 — Backend adapters (`src/backends/`)

Each adapter implements a common interface:
```typescript
interface BackendAdapter {
  getBaseUrl(): Promise<string>;         // resolved endpoint
  getAuthHeaders(): Promise<Record<string, string>>;  // auth headers for upstream
  transformRequest?(body: unknown): unknown;   // optional request rewrite
  transformResponse?(body: unknown): unknown;  // optional response rewrite
}
```

| Backend | Auth | Base URL | Notes |
|---------|------|----------|-------|
| `copilot` | GitHub token → JWT exchange | auto from JWT claims | existing flow |
| `openai` | `Bearer $LLM_API_KEY` | `https://api.openai.com/v1` | passthrough |
| `anthropic` | `x-api-key: $LLM_API_KEY` | `https://api.anthropic.com/v1` | uses existing `translate.ts` |
| `ollama` | none | `http://localhost:11434/v1` | OpenAI-compatible, zero translation |

#### Step 8 — Proxy server uses backend adapter
The main request handler resolves the backend at startup (or per-request if hot-swapping is needed) and delegates auth + URL resolution to the adapter. The routing, streaming, metrics, and translation logic stays unchanged.

---

### Phase 3 — Cloud LLM Backends (Azure AI Foundry + AWS Bedrock)

#### Step 9 — Azure AI Foundry adapter (`src/backends/azure-openai.ts`)

Azure OpenAI exposes an OpenAI-compatible API — minimal adapter needed.

**Auth**: `api-key` header (no token exchange)
**URL pattern**: `https://<resource>.openai.azure.com/openai/deployments/<deployment>`

```
# New env vars for Azure
LLM_BACKEND=azure-openai
AZURE_OPENAI_API_KEY=<your-azure-api-key>
AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com
AZURE_OPENAI_DEPLOYMENT=<deployment-name>
AZURE_OPENAI_API_VERSION=2024-02-01
```

`transformRequest` appends `?api-version=<AZURE_OPENAI_API_VERSION>` to all upstream calls.
Everything else (streaming, metrics, routing) is unchanged.

**Supported models** (via Azure AI Foundry): `gpt-4o`, `gpt-4o-mini`, `gpt-4`, `o1`, `o3-mini`, and any deployed model in your Azure resource.

---

#### Step 10 — AWS Bedrock adapter (`src/backends/aws-bedrock.ts`)

Bedrock requires **AWS SigV4 request signing** on every call. The adapter uses the AWS SDK to handle this — no manual HMAC implementation.

**Dependency added**: `@aws-sdk/client-bedrock-runtime`

```
# New env vars for Bedrock
LLM_BACKEND=aws-bedrock
AWS_ACCESS_KEY_ID=<your-access-key>
AWS_SECRET_ACCESS_KEY=<your-secret-key>
AWS_REGION=us-east-1
AWS_BEDROCK_MODEL_ID=anthropic.claude-haiku-4-5
```

**Why native adapter over a bridge**:
- No extra process to operate
- Full access to Bedrock features (guardrails, inference profiles, cross-region routing)
- No compatibility lag from third-party bridge projects
- AWS SDK handles all SigV4 signing (~50 lines total)

**Request flow**:
```
Proxy receives OpenAI-format request
  → transformRequest() converts to Bedrock InvokeModel format
  → AWS SDK signs the request (SigV4)
  → Response converted back to OpenAI format via transformResponse()
```

**Supported models** (via Bedrock): `anthropic.claude-*`, `amazon.titan-*`, `meta.llama*`, `mistral.*`, `cohere.*`

---

#### Updated Backend table (all phases)

| Backend | Phase | Auth | Complexity |
|---------|-------|------|------------|
| `copilot` | 1 | GitHub token → JWT | Medium |
| `openai` | 2 | `Bearer $key` | Low |
| `anthropic` | 2 | `x-api-key` | Low |
| `ollama` | 2 | none | Trivial |
| `azure-openai` | 3 | `api-key` header | Low |
| `aws-bedrock` | 3 | AWS SigV4 via SDK | Medium |

---

## Testing Strategy

### Level 1 — curl / HTTP client (after Phase 1, zero extra code)

Verify the proxy is running and reaching the Copilot API:

```bash
# Health check
curl http://localhost:3100/health

# List available models
curl http://localhost:3100/v1/models

# Chat completion (non-streaming)
curl -X POST http://localhost:3100/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4.5","messages":[{"role":"user","content":"say hi"}]}'

# Chat completion (streaming)
curl -X POST http://localhost:3100/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4.5","stream":true,"messages":[{"role":"user","content":"count to 5"}]}'

# Metrics
curl http://localhost:3100/metrics
```

---

### Level 2 — OpenAI SDK smoke test script (`test-client.ts`)

A single script added to the project root — not a full app, just a runnable sanity check.
Run with: `npx tsx test-client.ts`

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: process.env.PROXY_URL ?? 'http://localhost:3100/v1',
  apiKey: 'unused',
});

// Test 1: basic chat
const res = await client.chat.completions.create({
  model: process.env.LLM_DEFAULT_MODEL ?? 'claude-haiku-4.5',
  messages: [{ role: 'user', content: 'What is 2+2? Answer in one word.' }],
});
console.log('Chat:', res.choices[0].message.content);

// Test 2: streaming
const stream = await client.chat.completions.create({
  model: process.env.LLM_DEFAULT_MODEL ?? 'claude-haiku-4.5',
  messages: [{ role: 'user', content: 'Count from 1 to 5.' }],
  stream: true,
});
process.stdout.write('Stream: ');
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}
console.log('\nDone.');
```

Confirms the OpenAI SDK works through the proxy exactly as a real AI app would use it.

---

### Level 3 — Backend switching test (after Phase 2/3)

Same `test-client.ts`, different env vars — proves the backend abstraction works:

```bash
# Copilot (Phase 1)
GITHUB_TOKEN=ghp_xxx npx tsx test-client.ts

# Ollama local (Phase 2) — must have Ollama running
LLM_BACKEND=ollama LLM_DEFAULT_MODEL=llama3.2 npx tsx test-client.ts

# OpenAI (Phase 2)
LLM_BACKEND=openai LLM_API_KEY=sk-xxx LLM_DEFAULT_MODEL=gpt-4o-mini npx tsx test-client.ts

# Azure AI Foundry (Phase 3)
LLM_BACKEND=azure-openai AZURE_OPENAI_API_KEY=xxx AZURE_OPENAI_ENDPOINT=https://xxx.openai.azure.com \
  AZURE_OPENAI_DEPLOYMENT=gpt-4o npx tsx test-client.ts

# AWS Bedrock (Phase 3)
LLM_BACKEND=aws-bedrock AWS_ACCESS_KEY_ID=xxx AWS_SECRET_ACCESS_KEY=xxx AWS_REGION=us-east-1 \
  AWS_BEDROCK_MODEL_ID=anthropic.claude-haiku-4-5 npx tsx test-client.ts
```

---

### Testing added to scaffold (Step 1 update)

`test-client.ts` is part of the project from Phase 1:

```
standalone-aiproxy/
  src/
    ...
  test-client.ts     ← OpenAI SDK smoke test (all phases)
  package.json
  tsconfig.json
  .env.example
```

---

## Proxy Endpoints (already implemented, no changes)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat (streaming + JSON) |
| `POST` | `/v1/messages` | Anthropic-compatible (auto-translated) |
| `GET`  | `/v1/models` | List available models |
| `POST` | `/v1/embeddings` | Embeddings passthrough |
| `GET`  | `/usage` | GitHub Copilot quota |
| `GET`  | `/quota` | Parsed JWT claims |
| `POST` | `/token/refresh` | Force token refresh |
| `GET`  | `/health` | Health check |
| `GET`  | `/metrics` | Session metrics |
| `GET`  | `/metrics/cumulative` | Cumulative metrics |

---

## Supported Models (via Copilot)

- **Claude**: `claude-haiku-4.5` *(default)*, `claude-sonnet-4.6`, `claude-opus-4.5`
- **OpenAI**: `gpt-4o`, `gpt-4o-mini`, `gpt-4o-2024-11-20`
- **Google**: `gemini-3.5-flash`, `gemini-3-flash-preview`

---

## Important Notes

- `GET /copilot_internal/v2/token` is an **internal GitHub endpoint** — not officially documented; may change
- The `copilot-integration-id` header identifies your app for telemetry (`my-ai-app`, `chat-bot`, etc.)
- Token is cached in-memory with auto-refresh 60s before expiry
- All token exchange and API calls use native `fetch` (Node 18+)
