# Standalone Copilot Proxy — Build Plan

## Goal

Extract the Copilot proxy from the VS Code extension into a standalone Node.js HTTP service.
Any AI app communicates with LLMs via this proxy using standard OpenAI-compatible API calls.
The proxy is fully decoupled from any app, reusable, and extractable to a separate service later.

The proxy is **multi-backend**: switch between Copilot, Anthropic, OpenAI, Ollama (or any
OpenAI-compatible API) by changing environment variables — no code changes, no app restarts required.

**Published**: [`@riteshagarwal-au/standalone-aiproxy`](https://github.com/riteshagarwal-au/standalone-aiproxy/pkgs/npm/standalone-aiproxy) on GitHub Packages

**Repo**: [github.com/riteshagarwal-au/standalone-aiproxy](https://github.com/riteshagarwal-au/standalone-aiproxy)

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

### Phase 2 — Multi-Backend Support ✅ IMPLEMENTED (2026-08-11)

Implemented in `app/src/backends/` — see `types.ts` for the `HttpAdapter`/`NativeAdapter`
interfaces actually used (slightly different shape than the interface sketched below, since
`anthropic` needed its own request/response translation rather than a passthrough).

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

#### Step 8b — Admin backend switcher (`GET/POST /admin`) ✅ IMPLEMENTED

An admin page to pick the active `LLM_BACKEND` at runtime, without redeploying or editing env vars.

- `GET /admin` — HTML page listing all backends (`copilot`, `openai`, `anthropic`, `ollama`,
  `azure-openai`, `aws-bedrock`), highlighting the currently active one, with a dropdown/buttons
  to switch.
- `POST /admin/backend` — body `{ backend: "aws-bedrock" }` → validates the backend's required
  env vars are already present (e.g. `AWS_REGION`, `AWS_BEDROCK_MODEL_ID` for Bedrock; Key Vault
  is still the source of the actual AWS secrets, this endpoint only switches routing) → updates
  an in-memory `currentBackend` variable → the request handler reads this instead of
  `process.env.LLM_BACKEND` directly.
- `/health` and `/dashboard` should reflect the live `currentBackend` (not the hardcoded
  `backend: 'copilot'` currently in `handleHealth()`).

**Caveats**:
- **No auth on `/admin` yet** — needs at least a shared-secret header or basic auth before being
  exposed beyond localhost, since anyone who can reach it could change the active backend. **Still
  an open item** — not yet implemented.
- Switching to `aws-bedrock` only works if credentials are already resolvable (via Key Vault-fed
  env vars per Step 10) — this endpoint changes routing only, it does not fetch/provision creds.

**Persisting the choice across restarts/redeploys** — ✅ implemented (`app/src/backends/index.ts`
`initBackendPersistence`/`setCurrentBackend`, writes to `<PROXY_STORAGE_DIR>/backend-override.json`):
- Write the selected backend to `/home/data/backend-override.json` on `POST /admin/backend`;
  read it at startup (falls back to `LLM_BACKEND` env var if the file doesn't exist).
- On **Azure App Service for Containers**, `/home` is only a persistent Azure Files-backed mount
  (survives both restarts and CI-pushed image redeploys) if
  `WEBSITES_ENABLE_APP_SERVICE_STORAGE=true` is set — this **defaults to `false` for custom
  container deployments** (unlike code-based App Service, where it defaults to `true`). Checked
  [infra/main.tf](../infra/main.tf) — this setting is **not currently present**, so `/home` is
  presently ephemeral for this Web App. **TODO**: add
  `WEBSITES_ENABLE_APP_SERVICE_STORAGE = "true"` to `app_settings` in `azurerm_linux_web_app.aiproxy`.
- Locally, [docker-compose.yml](../docker-compose.yml) has no volume mount, so `/home/data` is lost
  on every `docker-compose down`/rebuild. **TODO**: add `volumes: ["./data:/home/data"]` under the
  `aiproxy` service.

Both TODOs above (`WEBSITES_ENABLE_APP_SERVICE_STORAGE` + `PROXY_STORAGE_DIR=/home/data` in
`infra/main.tf`; the docker-compose volume mount) were applied and `terraform apply`'d on 2026-08-11.

---

### Phase 3 — Cloud LLM Backends (Azure AI Foundry + AWS Bedrock) ✅ IMPLEMENTED (2026-08-11)

#### Step 9 — Azure AI Foundry adapter (`src/backends/azure-openai.ts`) ✅ IMPLEMENTED

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

#### Step 10 — AWS Bedrock adapter (`src/backends/aws-bedrock.ts`) ✅ IMPLEMENTED (Claude only)

Bedrock requires **AWS SigV4 request signing** on every call. The adapter uses the AWS SDK to handle this — no manual HMAC implementation.

**Scope note**: the implemented adapter only supports Anthropic Claude models (via Bedrock's
Anthropic Messages request/response shape, shared with the native `anthropic` backend adapter
in `src/backends/anthropic-format.ts`). Titan/Llama/Mistral/Cohere models use different
request/response schemas on Bedrock and are **not yet wired up** despite being listed in the
"Supported models" table below — that table describes what Bedrock itself offers, not adapter
coverage.

**Dependency added**: `@aws-sdk/client-bedrock-runtime`

**Auth: use the AWS SDK default credential provider chain — no static keys.**
The adapter instantiates `new BedrockRuntimeClient({ region })` with no explicit `credentials`,
so the SDK resolves auth automatically from (in order): env vars → shared `~/.aws/credentials`
profile (`AWS_PROFILE`) → SSO → EC2/ECS/Lambda instance role. This works transparently across
environments without code changes:

| Environment | How auth resolves |
|---|---|
| Local dev | `AWS_PROFILE=<stax-profile>` env var → temp STS creds from `~/.aws/credentials` (written by `stax2aws login`) |
| Production, in-account (ECS/EC2/Lambda) | IAM role / instance profile — no env vars needed |
| Production, outside AWS | Needs long-lived creds — **not currently available** (see limitation below) |

```
# New env vars for Bedrock
LLM_BACKEND=aws-bedrock
AWS_REGION=ap-southeast-2
AWS_BEDROCK_MODEL_ID=au.anthropic.claude-haiku-4-5-20251001-v1:0
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY only needed if no profile/role is available
```

**⚠️ Known limitation — Stax-managed accounts have no long-lived credential option**:
- This account's IAM is managed via Stax SSO; `iam:CreateUser` is **explicitly denied by an
  org-level SCP**, so static-key IAM users cannot be created for the proxy.
- `stax2aws login` is an **interactive device-code flow** (browser/QR) — there is no
  headless/programmatic login. Sessions expire after a max of 8h (`session-duration: 28800`
  in `~/stax2aws.yaml`), then require a human to re-authenticate.
- **Production deployment is Azure App Service** (`https://llm-aiproxy.azurewebsites.net/`), not
  AWS — so there's no EC2/ECS/Lambda instance role to fall back on either.
- **Temporary workaround (Azure Key Vault + manual refresh, valid ~8h)**: store the 3 temporary
  STS values from `~/.aws/credentials` (`aws_access_key_id`, `aws_secret_access_key`,
  `aws_session_token` under the `stax-au1-telstra-agentic-framework` profile) as Key Vault
  secrets, then reference them in App Service → Configuration → Application Settings as
  `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` (plus `AWS_REGION`). The
  AWS SDK's default credential chain reads these env vars automatically — **zero adapter code
  needed** for this path. Requires manual refresh: run `stax2aws login -p
  stax-au1-telstra-agentic-framework -f`, update the 3 Key Vault secret values, then restart the
  Web App (Key Vault references cache for ~24h and won't auto-pick-up a rotated secret without a
  restart). Not viable long-term — someone must repeat this at least every 8h.
- **Longer-term fix (pending IT)**: either (a) a permission set with a longer max session
  duration, (b) AWS IAM Roles Anywhere / OIDC federation from Azure AD → `AssumeRoleWithWebIdentity`
  for real non-interactive, auto-refreshing creds (preferred — doesn't require IAM user creation,
  so likely not blocked by the SCP), or (c) redeploying the proxy inside this AWS account so it
  can use a native IAM role instead of Stax entirely. Once real long-lived/federated creds exist,
  swapping the 3 Key Vault secret values for them requires no adapter code changes (same env vars);
  only switching to OIDC/`AssumeRoleWithWebIdentity` would need a small adapter change to construct
  the credential provider differently.

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

**⚠️ Model IDs require cross-region inference profiles, not raw model IDs** — e.g. invoking
`anthropic.claude-haiku-4-5-20251001-v1:0` directly fails with
`ValidationException: on-demand throughput isn't supported`. Use the inference profile ID instead
(e.g. `au.anthropic.claude-haiku-4-5-20251001-v1:0` or `global.anthropic.claude-haiku-4-5-20251001-v1:0`),
found via `aws bedrock list-inference-profiles --region <region>`.

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
