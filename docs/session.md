# Session Summary — Phase 3 Bedrock Access Investigation

**Date**: 2026-08-07 to 2026-08-11

## Follow-up — Phase 2 + Phase 3 implementation (2026-08-11)

Implemented the backend-adapter abstraction and both Phase 3 cloud adapters in one pass:

- Applied the two infra prerequisites first: `WEBSITES_ENABLE_APP_SERVICE_STORAGE=true` +
  `PROXY_STORAGE_DIR=/home/data` added to `infra/main.tf` and `terraform apply`'d (35s, 1
  resource changed, no errors); `volumes: ["./data:/home/data"]` + matching
  `PROXY_STORAGE_DIR=/home/data` added to `docker-compose.yml`; local `./data/` dir created
  (already covered by `.gitignore`'s `data/` entry).
- Built `app/src/backends/`: `types.ts` (`HttpAdapter` for OpenAI-wire passthrough backends vs
  `NativeAdapter` for backends needing their own request/response translation),
  `copilot.ts`/`openai.ts`/`ollama.ts` (http), `anthropic.ts`/`aws-bedrock.ts` (native, sharing
  OpenAI⇄Anthropic-Messages conversion helpers in `anthropic-format.ts`), `azure-openai.ts`
  (http + `?api-version=` query suffix), and `index.ts` (registry + runtime switching +
  `backend-override.json` persistence + `missingRequiredEnv()` validation).
- Rewired `proxy-server.ts`'s `handleChat`/`handleMessages`/`handleModels`/`handleEmbeddings`
  to go through `getAdapter()` instead of hardcoded `getCopilotToken()`/`COPILOT_HEADERS`.
  `handleHealth` now reports the live backend instead of a hardcoded `'copilot'`.
- Implemented Step 8b: `GET /admin` (HTML switcher UI, added a link from the dashboard) and
  `POST /admin/backend` (validates backend name + required env vars, persists selection).
- Added `@aws-sdk/client-bedrock-runtime` dependency (dynamic-imported inside
  `aws-bedrock.ts` so it's only loaded when that backend is actually selected).
- `npm run typecheck` and `npm run build` both pass clean.
- Updated `.env.example` with the new backend env vars, and marked Phase 2/Step 8b/Phase 3 as
  implemented in `PLAN.md` (with a scope note that Bedrock currently only supports Claude models,
  not Titan/Llama/Mistral/Cohere, despite the "Supported models" table listing them).

**Known gaps / not done in this pass**:
- No auth on `/admin` — still an open item, anyone reaching the proxy can switch backends.
- `aws-bedrock` adapter is Claude-only (shares the Anthropic Messages format code path).
- Native-adapter streaming for `/v1/messages` (Anthropic-format endpoint) isn't real
  token-by-token streaming — it sends the full response as one SSE chunk. `/v1/chat/completions`
  streaming for native adapters (`anthropic`, `aws-bedrock`) *is* real token-by-token streaming.
- Still haven't done an end-to-end smoke test against a real Bedrock/Azure OpenAI endpoint —
  only typecheck/build verified so far.

## Follow-up — Admin backend switcher design (2026-08-11)

Discussed (not yet implemented) an `/admin` page to let a human pick the active `LLM_BACKEND`
at runtime (`copilot`, `openai`, `anthropic`, `ollama`, `azure-openai`, `aws-bedrock`) without
redeploying. Key decisions/findings:

- Dropped the idea of triggering `stax2aws login` from the admin portal (device-flow re-auth) —
  scope is just backend selection; AWS creds continue to come from Key Vault per the existing
  Step 10 plan.
- Selection needs to persist across restarts and CI-pushed image redeploys, not just live in
  memory. Plan: write to `/home/data/backend-override.json`, read at startup, fall back to the
  `LLM_BACKEND` env var (default `copilot`) if absent.
- **Verified persistence is not currently configured**:
  - Azure: `azurerm_linux_web_app.aiproxy` in `infra/main.tf` has no
    `WEBSITES_ENABLE_APP_SERVICE_STORAGE` setting. For **custom container** deployments this
    defaults to `false` (opposite of code-based App Service, which defaults to `true`) — so
    `/home` is currently ephemeral. Needs `WEBSITES_ENABLE_APP_SERVICE_STORAGE = "true"` added to
    `app_settings` before relying on this.
  - Local: `docker-compose.yml` has no volume mount for `/home/data` — needs
    `volumes: ["./data:/home/data"]` added under the `aiproxy` service.
- Full design captured in `docs/PLAN.md` Step 8b.

**Next session should start here**: implement Step 8b (admin page + `POST /admin/backend` +
persistence file) once the Terraform/docker-compose changes above are applied, or apply those
infra changes first if picking this back up.

## Goal

Prepare for Phase 3 (`aws-bedrock` backend adapter) by verifying Bedrock access on a new
AWS account: `669076482267` (`support-24325-telstra-agentic-framework`), managed via Stax SSO.

## What was done

1. **Found the login tool**: no `staxapi` tool existed — the actual CLI is `stax2aws`
   (installed via `brew install stax2aws`, tap `stax-labs/homebrew-taps`), discovered via
   `zsh_history` search.
2. **Derived login parameters** from the existing `versent` profile in `~/stax2aws.yaml`:
   `installation: au1`, `org-alias: versent-innovation`. Logged into the new account with:
   ```
   stax2aws login -i au1 -o versent-innovation -r arn:aws:iam::669076482267:role/staxid-admin-role -p stax-au1-telstra-agentic-framework
   ```
3. **Verified Bedrock access** in `ap-southeast-2`:
   - `aws sts get-caller-identity` confirmed account `669076482267`.
   - `aws bedrock list-foundation-models` returned a large model catalog (Claude, Nova,
     Mistral, Qwen, etc.).
   - Direct `invoke-model` with raw model ID `anthropic.claude-haiku-4-5-20251001-v1:0`
     failed: `ValidationException: on-demand throughput isn't supported`.
   - Fixed by using the **cross-region inference profile ID** instead:
     `au.anthropic.claude-haiku-4-5-20251001-v1:0` (found via `aws bedrock list-inference-profiles`).
     Successful invoke returned a real completion.
4. **Investigated auth options for a long-running proxy service** (not just interactive CLI use):
   - Confirmed Bedrock uses standard AWS SigV4/IAM auth — no separate "API key" from the
     Bedrock console.
   - Attempted to create a dedicated IAM user for static long-lived keys — **blocked**:
     `iam:CreateUser` is explicitly denied by an org-level Service Control Policy
     (`p-e7rcbj92`). Confirmed via a real (immediately failed) `create-user` call.
   - Confirmed `stax2aws login` is an **interactive-only** OAuth2 device-authorization flow —
     no headless/service-account mode exists. It only completed instantly during testing because
     the local browser already had an active Stax SSO session.
   - Confirmed via the official Stax docs that session duration can go up to **8h** (28800s)
     on default roles, or 12h via Permission Sets — but re-auth is still required after expiry,
     there's no way around the interactive step.
5. **Raised the constraint with IT**, asking about (a) a longer-session permission set,
   (b) an OIDC/federated machine-identity mechanism, and (c) confirming native IAM
   roles work if the proxy is deployed inside this AWS account (ECS/EC2/Lambda) — awaiting
   response.
6. **Practical fixes applied**:
   - Bumped `session-duration` to `28800` (8h) for the `stax-au1-telstra-agentic-framework`
     profile in `~/stax2aws.yaml`.
   - Confirmed `stax2aws login -p <profile>` alone (no other flags) re-reads
     `installation`/`org-alias`/`role-arn` from the saved profile in `~/stax2aws.yaml` — the
     simplest way to refresh.
7. **Updated [PLAN.md](PLAN.md) Step 10** (`aws-bedrock` adapter) with:
   - Auth approach: use the AWS SDK default credential provider chain (no static keys) so
     `AWS_PROFILE` (local dev via Stax) and IAM roles (production, in-account) both work without
     code changes.
   - The Stax/SCP limitation and the temporary local-dev workaround (manual `stax2aws login`
     refresh) vs. the longer-term fix (pending IT).
   - The inference-profile-ID requirement for Claude models on Bedrock.

## Key facts to remember

- **AWS profile for the new account**: `stax-au1-telstra-agentic-framework`
  (role `arn:aws:iam::669076482267:role/staxid-admin-role`, region `ap-southeast-2`).
- **Refresh command**: `stax2aws login -p stax-au1-telstra-agentic-framework` (add `-f` to force
  even if not expired).
- **Bedrock model IDs need inference profiles**, not raw IDs, e.g.
  `au.anthropic.claude-haiku-4-5-20251001-v1:0`.
- **No static IAM users possible** in this account (SCP-blocked) — Bedrock auth for a
  long-running/unattended proxy is an open item pending IT's response.
- Per personal testing preference: always use Haiku (not Opus) for manual/smoke-test LLM calls.

## Production hosting detail — Azure Web App, not AWS

The standalone proxy runs as an Azure App Service (`https://llm-aiproxy.azurewebsites.net/`), not
inside AWS — so there's no EC2/ECS/Lambda instance role to fall back on for Bedrock auth. Two
paths discussed:

- **Temporary (now, ~8h validity)**: store the 3 temporary STS values from `~/.aws/credentials`
  (`aws_access_key_id`, `aws_secret_access_key`, `aws_session_token` under the
  `stax-au1-telstra-agentic-framework` profile) as Azure Key Vault secrets, referenced as App
  Service Application Settings `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`
  (+ `AWS_REGION`). AWS SDK's default credential chain reads these automatically — no adapter code
  needed. Requires manual refresh at least every 8h: `stax2aws login -p
  stax-au1-telstra-agentic-framework -f`, update the 3 secrets, then **restart the Web App**
  (Key Vault references cache ~24h and won't auto-pick-up a rotated secret without a restart).
- **Long-term (point 2, pending IT)**: swap in real long-lived/federated credentials into the same
  3 Key Vault secrets — no adapter code changes needed if it's still access-key/secret/(session
  token) shaped. If IT provides AWS IAM Roles Anywhere / OIDC federation from Azure AD instead
  (`AssumeRoleWithWebIdentity`), that *would* need a small adapter change to construct the
  credential provider differently — flagged as the preferred long-term option since it doesn't
  need IAM user creation (likely not blocked by the SCP) and gives real non-interactive
  auto-refreshing creds.

## Open items / next steps

- Waiting on IT for: longer-session permission set, OIDC/federated machine identity option
  (specifically AWS IAM Roles Anywhere / `AssumeRoleWithWebIdentity` from Azure AD, given the
  proxy runs on Azure App Service not inside AWS), or confirmation that an in-account IAM role
  is only relevant if redeployed inside AWS.
- Implement `src/backends/aws-bedrock.ts` per the updated Step 10 in [PLAN.md](PLAN.md):
  add `@aws-sdk/client-bedrock-runtime` dependency, `BackendAdapter` interface (Phase 2,
  not yet built — `src/backends/` doesn't exist in the repo yet), request/response
  transforms (OpenAI ⇄ Bedrock Anthropic Messages format), and streaming support.
- Note: **Phase 2's backend-adapter abstraction itself hasn't been implemented yet** — the repo
  currently only has the Phase 1 Copilot-only proxy (`copilot-auth.ts`, `proxy-server.ts`,
  `translate.ts`, `types.ts`, `index.ts`). Phase 3 work depends on deciding whether to build
  Phase 2's adapter pattern first or bolt Bedrock on more directly.
