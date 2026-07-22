# standalone-aiproxy

A standalone Node.js proxy that routes OpenAI-compatible requests to GitHub Copilot (and future backends). Exposes an OpenAI-compatible API (`/v1/chat/completions`, `/v1/messages`, `/v1/models`, `/v1/embeddings`), plus a health check, metrics, and a built-in dashboard/message-inspector UI.

Published as `@riteshagarwal-au/standalone-aiproxy` on GitHub Packages, and consumed by [AI-CareerCoach](https://github.com/riteshagarwal-au/ai-careercoach) as its AIProxy sidecar/service.

---

## Repository Structure

```
├── app/                     # Application source (Node.js/TypeScript)
│   ├── src/                 # Proxy server implementation
│   ├── test-client.ts       # OpenAI SDK smoke test against a running proxy
│   ├── package.json
│   ├── tsconfig.json
│   ├── esbuild.js           # Build script (bundles src/ → dist/)
│   ├── .env.example         # Environment variable reference
│   └── .nvmrc               # Node version pin (20)
├── docs/                    # Guides and design notes
│   ├── GITHUB_COPILOT_API_GUIDE.md
│   └── PLAN.md
├── design/                  # Architecture diagrams
│   └── architecture.drawio
├── Dockerfile                # Builds the standalone container image from app/
├── docker-compose.yml         # Runs the container locally, publishing port 3100
└── infra/                    # Terraform for the Azure Web App deployment
```

---

## Local Development

### Prerequisites

- Node.js 20.x (see `app/.nvmrc`)
- A GitHub Copilot-entitled account (Individual, Business, or Enterprise)

### Setup

```bash
cd app
npm install
cp .env.example .env   # fill in GHU_APP_TOKEN, etc.
npm run build
npm start
```

The proxy listens on `http://localhost:3100` by default. Visit `http://localhost:3100/dashboard` for the built-in observability UI, or `http://localhost:3100/health` for a health check.

### Environment Variables

See `app/.env.example` for the full list with descriptions. Key ones:

| Key | Description |
|---|---|
| `GHU_APP_TOKEN` | GitHub Copilot OAuth token used to authenticate to the Copilot API |
| `PROXY_PORT` | Port to listen on (default `3100`) |
| `PROXY_HOST` | Interface to bind to (default `127.0.0.1`; set to `0.0.0.0` in containers) |
| `PROXY_INTEGRATION_ID` | App identifier sent in Copilot telemetry headers |

---

## Docker

```bash
docker compose build
docker compose up
```

Publishes the proxy directly to `http://localhost:3100` — no shared Docker network with any consumer (e.g. AI-CareerCoach) is required or used; each service is reached independently, the same way two separate Azure Web Apps would be.

---

## Deploy to Azure

Provisions AIProxy as its own Azure Web App via Terraform, deployed from its own container image — independent from any consuming application's own Web App (e.g. AI-CareerCoach's `aicoach` Web App).

```bash
cd infra
terraform init
terraform apply
```

See `infra/` for the Terraform configuration and required variables.

---

## Testing

```bash
cd app
npm run typecheck
npx tsx test-client.ts   # smoke test against a running proxy instance
```
