# GitHub Copilot API Integration Guide

## Overview

This document explains how the **Standalone AI Proxy** connects to GitHub Copilot APIs to access multiple LLM providers (Claude, GPT, Gemini) through a single OpenAI-compatible interface.

---

## API Endpoints

GitHub provides three account-type-specific Copilot API endpoints:

| Account Type | Endpoint |
|--------------|----------|
| **Individual** | `https://api.githubcopilot.com` |
| **Business** | `https://api.business.githubcopilot.com` |
| **Enterprise** | `https://api.enterprise.githubcopilot.com` |

The proxy auto-selects the correct endpoint from the JWT claims (`proxy-ep=` field) after a successful token exchange, or defaults to `api.githubcopilot.com` for direct OAuth token auth.

---

## Authentication

### Token Types

| Token | Prefix | Source | Works? |
|-------|--------|--------|--------|
| Classic PAT | `ghp_` | github.com/settings/tokens | ❌ Explicitly rejected by Enterprise endpoint |
| OAuth token | `gho_` | OAuth App flow (e.g. VS Code) | ✅ Works — required |
| Device Flow token | `ghu_` | GitHub Device Flow | ✅ Works — what the proxy uses |
| GitHub App IAT | `ghs_` | GitHub App private key | ❌ No Copilot LLM permissions |

### How the Proxy Authenticates

The proxy uses **GitHub OAuth Device Flow** on first run to obtain a `ghu_` token. The token is saved to `.env` automatically — all future restarts are non-interactive.

```
First run (one-time setup):
  Proxy starts → no GHU_APP_TOKEN set
  → Calls https://github.com/login/device/code
  → Prints URL + code for user to authorize
  → Polls until authorized
  → Gets ghu_ token → saves to .env

All future runs:
  Proxy starts → reads GHU_APP_TOKEN from .env
  → No interaction needed
```

### Token Exchange Flow (Individual accounts)

```
ghu_ token → POST /copilot_internal/v2/token → Copilot JWT (tid=...;exp=...;proxy-ep=...)
                                                    ↓
                                          api.githubcopilot.com / api.enterprise.githubcopilot.com
```

### Enterprise Account Behaviour

For **Business/Enterprise** Copilot accounts, the token exchange endpoint returns **404 by design**. In this case the proxy uses the OAuth token directly:

```
ghu_ token → POST /copilot_internal/v2/token → 404 (expected for Enterprise)
                  ↓
  Use ghu_ token as Bearer directly → api.githubcopilot.com → ✅ All models available
```

> **Note**: This is documented behaviour — see [NousResearch/hermes-agent#45214](https://github.com/NousResearch/hermes-agent/pull/45214).

---

## Required Headers

All requests to the Copilot API must include:

```typescript
{
  'copilot-integration-id': 'vscode-chat',   // MUST be 'vscode-chat' for Enterprise
  'editor-version': 'vscode/1.99.0',
  'x-github-api-version': '2025-04-01',
  'Authorization': `Bearer ${token}`,
  'Content-Type': 'application/json',
}
```

> ⚠️ **Important**: For Enterprise accounts, `copilot-integration-id` must be `vscode-chat`.
> Using any other value results in a `400 bad request` response.

---

## Environment Variables

```bash
# Required — GitHub OAuth token (ghu_) obtained via Device Flow
GHU_APP_TOKEN=ghu_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Required for Enterprise — integration ID accepted by the Enterprise endpoint
PROXY_INTEGRATION_ID=vscode-chat

# Optional
PROXY_PORT=3100                  # Default: 3100
PROXY_RATE_LIMIT_SECONDS=0       # 0 = no rate limit
PROXY_LOG_REQUESTS=false         # true = log every request to stdout
PROXY_SHOW_TOKEN=false           # true = expose JWT at GET /token (never in production)
PROXY_STORAGE_DIR=./data         # Where to persist metrics and exchange history
```

---

## Core API Routes

The proxy exposes OpenAI-compatible endpoints on `http://localhost:3100`:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat (streaming + JSON) |
| `POST` | `/v1/messages` | Anthropic-compatible (auto-translated) |
| `GET`  | `/v1/models` | List available models |
| `POST` | `/v1/embeddings` | Embeddings passthrough |
| `GET`  | `/usage` | GitHub Copilot quota |
| `GET`  | `/quota` | Parsed JWT claims |
| `POST` | `/token/refresh` | Force token re-fetch |
| `GET`  | `/health` | Health + auth status |
| `GET`  | `/metrics` | Session metrics |
| `GET`  | `/metrics/cumulative` | All-time metrics |
| `GET`  | `/dashboard` | Web UI |
| `GET`  | `/compilation` | Message inspector UI |

---

## Available Models (Enterprise — 36 models)

- **Claude**: `claude-haiku-4.5` *(default)*, `claude-sonnet-4.6`, `claude-opus-4.5`, `claude-opus-4.6`, `claude-sonnet-5`, and more
- **OpenAI**: `gpt-4o`, `gpt-4o-mini`, `gpt-4o-2024-11-20`
- **Google**: `gemini-3.5-flash`, `gemini-3-flash-preview`

---

## Using the Proxy from Your AI App

The proxy is fully OpenAI-compatible. Point any OpenAI SDK at it:

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:3100/v1',
  apiKey: 'unused',  // proxy handles auth
});

const res = await client.chat.completions.create({
  model: 'claude-haiku-4.5',
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

No Copilot-specific code in your AI app. Swap backends by changing proxy env vars only.

---

## Installing the Proxy as an npm Package

The proxy is published to GitHub Packages as `@riteshagarwal-au/standalone-aiproxy`.

### Step 1 — Configure GitHub Packages registry

In your AI app's root, create or update `.npmrc`:

```
@riteshagarwal-au:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GH_TOKEN}
```

> The `GH_TOKEN` must have `read:packages` scope.

### Step 2 — Install

```bash
npm install @riteshagarwal-au/standalone-aiproxy
```

### Step 3 — Start the proxy programmatically

```typescript
import { ProxyServer } from '@riteshagarwal-au/standalone-aiproxy';

const proxy = new ProxyServer({
  port:             parseInt(process.env.PROXY_PORT ?? '3100'),
  integrationId:    process.env.PROXY_INTEGRATION_ID ?? 'vscode-chat',
  rateLimitSeconds: 0,
  rateLimitWait:    false,
  logRequests:      false,
  showToken:        false,
  storageDir:       './data',
});

await proxy.start();

// Now your app can call http://localhost:3100/v1/chat/completions
```

### Step 4 — Call the proxy from your app

```typescript
import OpenAI from 'openai';

const llm = new OpenAI({
  baseURL: `http://localhost:${process.env.PROXY_PORT ?? 3100}/v1`,
  apiKey: 'unused',
});

// Works with any framework: plain fetch, LangChain, LlamaIndex, Vercel AI SDK, etc.
const response = await llm.chat.completions.create({
  model: 'claude-haiku-4.5',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user',   content: userMessage },
  ],
});

return response.choices[0].message.content;
```

### With LangChain

```typescript
import { ChatOpenAI } from '@langchain/openai';

const model = new ChatOpenAI({
  modelName: 'claude-haiku-4.5',
  configuration: {
    baseURL: 'http://localhost:3100/v1',
    apiKey: 'unused',
  },
});

// Use in any LangChain chain, agent, or RAG pipeline
const result = await model.invoke('What is the capital of France?');
```

### With Vercel AI SDK

```typescript
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';

const copilot = createOpenAI({
  baseURL: 'http://localhost:3100/v1',
  apiKey: 'unused',
});

const { text } = await generateText({
  model: copilot('claude-haiku-4.5'),
  prompt: 'What is the capital of France?',
});
```

### With streaming (any SDK)

```typescript
const stream = await llm.chat.completions.create({
  model: 'claude-haiku-4.5',
  messages: [{ role: 'user', content: 'Tell me a story.' }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}
```

### Switching models at runtime

```typescript
// The proxy exposes all 36 enterprise models — switch by just changing the model name
const models = [
  'claude-haiku-4.5',    // Fast, cheap
  'claude-sonnet-4.6',  // Balanced
  'claude-opus-4.6',    // Most capable
  'gpt-4o',             // OpenAI alternative
  'gemini-3.5-flash',   // Google alternative
];

const response = await llm.chat.completions.create({
  model: process.env.LLM_MODEL ?? 'claude-haiku-4.5',
  messages: [...],
});
```

---

## One-Time Setup

```bash
# 1. Set required env vars
cp .env.example .env

# 2. Start proxy (Device Flow triggers automatically if GHU_APP_TOKEN not set)
node --env-file=.env dist/index.js

# 3. Follow the prompt: visit https://github.com/login/device and enter the code
# 4. After authorization, GHU_APP_TOKEN is saved to .env automatically
# 5. All future starts are non-interactive
```

---

## Azure / Production Deployment

The `ghu_` token does **not expire**. For server deployment:

1. Run Device Flow once locally to get the `ghu_` token
2. Store it in **Azure App Service → Configuration → Application Settings** as `GHU_APP_TOKEN`
3. Also set `PROXY_INTEGRATION_ID=vscode-chat`
4. Deploy — fully non-interactive

---

## Important Notes

- `GET /copilot_internal/v2/token` is an **internal GitHub endpoint** — not officially documented
- Classic PATs (`ghp_`) are explicitly rejected by the Enterprise Copilot endpoint
- GitHub App installation tokens (`ghs_`) have no Copilot LLM permissions
- The `ghu_` OAuth token obtained via Device Flow does not expire unless manually revoked
- `PROXY_INTEGRATION_ID=vscode-chat` is required — other values return `400 bad request` on Enterprise
