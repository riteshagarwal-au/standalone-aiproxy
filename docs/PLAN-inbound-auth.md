# Plan — Add Inbound Authentication to the AIProxy

**Status:** Not started (planned)
**Created:** 2026-08-19

## Problem

The proxy at `https://llm-aiproxy.azurewebsites.net` has **no inbound authentication**.
The router in [`app/src/proxy-server.ts`](../app/src/proxy-server.ts) dispatches every route
directly to its handler with no API-key/token check, and CORS is wide open
(`Access-Control-Allow-Origin: *`).

Anyone with the URL can currently:
- Make LLM calls — `POST /v1/chat/completions`, `/v1/messages`, `/v1/embeddings`
  (spends Copilot quota / Bedrock money).
- Switch the active backend — `POST /admin/backend`.
- Read internal state — `GET /metrics`, `/usage`, `/quota`, `/token`.

Public `*.azurewebsites.net` hosts are scanned by bots, so obscurity is not protection.

## Chosen approach

**Shared bearer key** on all sensitive routes (option 1). Optionally combine with an
App Service IP allow-list (option 3) if caller egress IPs are stable.

## Tasks

1. **Middleware in `proxy-server.ts`**
   - Read expected key from `process.env.AIPROXY_API_KEY`.
   - In `handleRequest`, before dispatching protected routes, require header
     `Authorization: Bearer <key>` (constant-time compare).
   - Return `401 { error: { message, type: 'unauthorized' } }` on mismatch/missing.
   - If `AIPROXY_API_KEY` is unset, log a clear startup warning (fail-open only for
     local dev, or better: fail-closed in production).

2. **Route policy**
   - **Protected:** `/v1/*` (chat, messages, count_tokens, embeddings) and `/admin/*`.
   - **Also protect:** `/token`, `/metrics`, `/usage`, `/quota` (leak internal state).
   - **Open:** `/health` (for App Service health checks), and optionally `/dashboard`.
   - Handle `OPTIONS` preflight before the auth check.

3. **Secret provisioning**
   - Generate a strong random key (e.g. `openssl rand -hex 32`).
   - Store in Key Vault: `az keyvault secret set --vault-name kv-aicoach-rits --name aiproxy-api-key --value <key>`.
   - Wire in [`infra/main.tf`](../infra/main.tf) app_settings:
     `AIPROXY_API_KEY = "@Microsoft.KeyVault(VaultName=${var.keyvault_name};SecretName=aiproxy-api-key)"`.
   - `terraform plan` / `apply`.

4. **Client update**
   - Update the calling app(s) (e.g. AItutor) to send `Authorization: Bearer <key>`.

5. **Tighten CORS (optional but recommended)**
   - Replace `Access-Control-Allow-Origin: *` with an allow-list of known origins,
     or drop CORS entirely for pure server-to-server use.

6. **Optional defence-in-depth**
   - App Service **access restrictions** (IP allow-list) for known caller egress IPs.
   - Or Azure **Easy Auth** (Entra ID) at the platform level for human/admin access to
     `/admin` and dashboards, keeping the bearer key for programmatic `/v1/*`.

## Verification

- `curl` without the header → `401`.
- `curl -H "Authorization: Bearer <key>"` → `200` and a model response.
- `/health` still returns `200` without a key.
- Confirm the live app rejects unauthenticated `/admin/backend` and `/v1/chat/completions`.

## Notes

- Keep the key out of git; it lives only in Key Vault + client secret store.
- Rotate by setting a new Key Vault secret value and updating clients; support two keys
  briefly if zero-downtime rotation is needed.
