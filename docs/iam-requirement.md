# AWS IAM Requirement — Bedrock Access for aiproxy

**Context**: `standalone-aiproxy` runs on Azure App Service and calls AWS Bedrock (Anthropic
Claude models) via the AWS SDK's default credential chain. Currently using temporary STS
credentials obtained via `stax2aws` SSO (expire ~8h, require periodic manual refresh via
`infra/refresh-bedrock-creds.sh`). This document lists what to request from IT to move to a
stable, production-grade setup.

## IAM User, not a Role

Since the app runs on Azure (not AWS), it needs an **IAM User** with static access keys, not an
IAM Role. Roles are assumed via AWS-native mechanisms (EC2 instance profiles, Lambda execution
context, or OIDC federation) — Azure has no native way to assume an AWS Role without either
static long-lived credentials or a federation/OIDC bridge that IT would need to build
specially. A plain IAM User with programmatic access solves the current problem directly: no
expiring session token, no periodic re-login.

## What to request

1. **A dedicated IAM User** for this workload only (not shared/personal), e.g.
   `aiproxy-bedrock-svc`.
2. **Programmatic access only** — access key ID + secret access key. No console login, no
   session token required.
3. **Scoped permissions** — least privilege, limited to Bedrock model invocation:
   ```json
   {
     "Effect": "Allow",
     "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
     "Resource": [
       "arn:aws:bedrock:ap-southeast-2::foundation-model/anthropic.claude-*",
       "arn:aws:bedrock:ap-southeast-2:669076482267:inference-profile/au.anthropic.claude-*"
     ]
   }
   ```
   (Account ID `669076482267`; adjust region as needed. The inference-profile ARN is required because
   invocation goes through the cross-region inference profile
   `au.anthropic.claude-haiku-4-5-20251001-v1:0`, not the raw model ID.)

   **If access to all Bedrock models is wanted** (not just Claude), widen the `Resource` to a
   full wildcard instead:
   ```json
   {
     "Effect": "Allow",
     "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
     "Resource": [
       "arn:aws:bedrock:ap-southeast-2::foundation-model/*",
       "arn:aws:bedrock:ap-southeast-2:669076482267:inference-profile/*"
     ]
   }
   ```
   Note this only grants *invocation* permission — each model family (Anthropic, Meta,
   Mistral, Cohere, Amazon Titan, etc.) still requires its own separate "Model access" grant
   in the Bedrock console (and, for some providers like Anthropic, a use-case form) before it
   can actually be invoked, regardless of the IAM policy. Also, `aws-bedrock.ts` currently only
   implements the Anthropic Messages request/response shape — invoking a non-Claude model would
   need adapter code changes to parse that model family's request/response format.
4. **Region confirmation** — confirm `ap-southeast-2` (Sydney) is correct long-term.
5. **Model access / use-case approval** — confirm the Anthropic model access + "use case
   details" form (already submitted for account `669076482267`) is an account-level approval
   that covers any new IAM user in the same account, not something that needs repeating.
6. **Key rotation policy** — ask what rotation interval they enforce (e.g. 90 days) so Key
   Vault secrets can be updated in time.
7. **Usage guardrails (optional)** — ask if there's a budget alert or service quota on Bedrock
   invocation for this account to catch runaway costs from bugs or misuse.

## Future-proofing: request broader scope now to avoid a second ticket

If other Bedrock-based features are likely later (RAG/knowledge bases, guardrails, model
discovery tooling, batch inference, etc.), it's worth asking IT to grant these additional
actions up front on the same IAM user, scoped to the account/region, rather than filing a
second request later:

```json
[
  {
    "Sid": "BedrockResourceScoped",
    "Effect": "Allow",
    "Action": [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
      "bedrock:Retrieve",
      "bedrock:RetrieveAndGenerate",
      "bedrock:*Guardrail*",
      "bedrock:*KnowledgeBase*",
      "bedrock:*DataSource*",
      "bedrock:*IngestionJob*",
      "bedrock:*Agent*",
      "bedrock:*ModelInvocationJob*"
    ],
    "Resource": [
      "arn:aws:bedrock:ap-southeast-2::foundation-model/*",
      "arn:aws:bedrock:ap-southeast-2:669076482267:*"
    ]
  }
]
```

**If model selection is predetermined** (i.e. the model/inference-profile ID is fixed in
config, e.g. `AWS_BEDROCK_MODEL_ID`, rather than discovered dynamically at runtime), the
discovery-only actions (`ListFoundationModels`, `GetFoundationModel`, `ListInferenceProfiles`,
`GetInferenceProfile`) aren't needed at all — drop them entirely, as shown above. This is the
case for `aiproxy` today: `aws-bedrock.ts` reads `AWS_BEDROCK_MODEL_ID` from an env var and
never calls any Bedrock discovery API, so this single statement (no discovery actions) is
sufficient as-is.

**If discovery is needed** (e.g. an admin UI or CLI tool to browse available models/profiles
before picking one), add it as a **separate statement** — these particular actions don't
support resource-level permissions, so AWS IAM requires their `Resource` element to be the
**literal string `"*"`**, not an ARN pattern that happens to match everything (supplying
`arn:aws:bedrock:ap-southeast-2:669076482267:*` here would not satisfy that requirement and the
actions would be denied despite being listed under `Action`):

```json
{
  "Sid": "BedrockDiscovery",
  "Effect": "Allow",
  "Action": [
    "bedrock:ListFoundationModels",
    "bedrock:GetFoundationModel",
    "bedrock:ListInferenceProfiles",
    "bedrock:GetInferenceProfile"
  ],
  "Resource": "*"
}
```

Everything in the first (resource-scoped) statement above does support resource-level ARNs, so
the account+region-scoped resource list there is valid and meaningfully restrictive.

**Justification for these two `Resource` entries specifically:**
- `arn:aws:bedrock:ap-southeast-2::foundation-model/*` — foundation-model ARNs have **no
  account ID segment** (the two colons `::` are intentional, not a typo) because these models
  are owned and hosted by AWS itself, not by our account — every AWS customer references the
  same model ARN. Restricting this to `ap-southeast-2` still confines *which region's* model
  endpoint can be invoked, which is the only meaningful scoping dimension available for this
  resource type; there is no account boundary to restrict further.
- `arn:aws:bedrock:ap-southeast-2:669076482267:*` — this covers every *account-owned* Bedrock
  resource type used by the actions above (agents, agent aliases, knowledge bases,
  guardrails, data sources, inference profiles, batch invocation jobs). A trailing wildcard is
  required here (rather than one ARN pattern per resource type) because several of the
  requested actions are `Create*` calls that don't have a resource ID to reference at request
  time, and IAM doesn't support omitting the resource ID segment conditionally per action.
  The security value of this entry over a bare `Resource: "*"` is that it hard-locks every
  action to our specific account (`669076482267`) and region (`ap-southeast-2`) — a compromised
  credential can't be used to touch Bedrock resources in a different AWS account or region,
  even if IAM's own cross-account isolation would already prevent that by default. This is
  defense-in-depth, not the primary security boundary.

**Justification:**

- `InvokeModel`/`InvokeModelWithResponseStream` — real-time chat completions.
- `Retrieve`/`RetrieveAndGenerate` + `*KnowledgeBase*`/`*DataSource*`/`*IngestionJob*` —
  RAG/Knowledge Base support (create, update, ingest, and query) — needed to ground responses
  in a document/code corpus rather than just plain chat.
- `*Guardrail*` — content filtering, PII redaction, safety enforcement (create/update/apply).
- `*Agent*` — native Bedrock Agents (create/configure/invoke) — for multi-step tool-using
  agents rather than single-shot chat completions.
- `*ModelInvocationJob*` — batch inference jobs, not real-time chat.
- Model/profile discovery (`ListFoundationModels`, `GetFoundationModel`,
  `ListInferenceProfiles`, `GetInferenceProfile`) is **not included** — model selection is
  predetermined via `AWS_BEDROCK_MODEL_ID`, so no discovery calls are needed. Add the separate
  `BedrockDiscovery` statement above only if that changes.

**Resources:**
- Resources are scoped at account level: `arn:aws:bedrock:ap-southeast-2:669076482267:*`.
- The foundation-model ARNs have no account segment (`arn:aws:bedrock:ap-southeast-2::foundation-model/*`)
  because they're AWS-owned, shared across all accounts.

This is still narrower than full `bedrock:*` — no permissions to manage guardrail/knowledge-base
*resources* (create/delete), IAM, or other AWS services are included. If none of these
future features are likely, stick with the minimal `InvokeModel`/`InvokeModelWithResponseStream`
scope from the section above instead.

**Note:** this list only covers the `bedrock:*` action namespace. A real agent/RAG solution
(per the WO-022537-style design) would also need supporting IAM/VPC/S3/OpenSearch permissions
(role creation + pass-role for agent execution roles, VPC endpoints for private connectivity,
S3 access for knowledge base source documents) — out of scope here since this doc is specific
to what `aiproxy` needs; treat those as a separate ask if/when that work is scoped.

## OpenSearch Serverless (only if using Knowledge Bases / RAG)

Bedrock Knowledge Bases need a vector store — the common default pairing is **OpenSearch
Serverless** (`aoss`), a separate IAM namespace from `bedrock:*`. If RAG is on the roadmap,
these additional permissions would be needed on top of the Bedrock ones above:

```json
{
  "Sid": "OpenSearchServerlessControlPlane",
  "Effect": "Allow",
  "Action": [
    "aoss:*Collection*",
    "aoss:*SecurityPolicy*",
    "aoss:*AccessPolicy*",
    "aoss:*Policies*"
  ],
  "Resource": "*"
}
```

Notes:
- `*Collection*` — provisions/manages the vector collection (`CreateCollection`,
  `UpdateCollection`, `DeleteCollection`, `BatchGetCollection`, `ListCollections`).
- `*SecurityPolicy*`/`*AccessPolicy*` — manages the collection's encryption/network/data-access
  policies (control plane). `*Policies*` is a separate extra line covering the plural
  `List*Policies` actions (`ListSecurityPolicies`, `ListAccessPolicies`), which the singular
  `Policy` wildcards above don't match.
- **`Resource: "*"` is required here, not optional** — none of these control-plane actions
  support resource-level permissions in OpenSearch Serverless, so a scoped ARN pattern would
  silently fail to grant them, the same issue covered earlier for Bedrock's `List*` actions.
- `APIAccessAll` (data-plane access — actual read/write of vectors) is kept in its own
  statement below because, unlike the control-plane actions, it **does** support resource-level
  scoping to a specific collection ARN:
  ```json
  {
    "Sid": "OpenSearchServerlessDataPlane",
    "Effect": "Allow",
    "Action": ["aoss:APIAccessAll"],
    "Resource": "arn:aws:aoss:ap-southeast-2:669076482267:collection/*"
  }
  ```
  It's also typically referenced in the collection's own **data access policy** (a separate
  resource-based policy on the collection itself, not an IAM policy), so the IAM user/role also
  needs to be added there by whoever provisions the collection.
- One IAM subtlety: **service-linked role creation** — the first time OpenSearch Serverless is
  used in an account, AWS auto-creates a service-linked role, which may require
  `iam:CreateServiceLinkedRole` scoped to `arn:aws:iam::669076482267:role/aws-service-role/observability.aoss.amazonaws.com/*`
  (a one-time, account-level setup — worth flagging to IT separately since it's an IAM
  namespace action, not `aoss:*`).

## Final combined JSON (Bedrock + OpenSearch Serverless for RAG)

If Knowledge Bases / RAG (and therefore OpenSearch Serverless) is part of the plan, request
this as one policy — `bedrock:*` actions plus `aoss:*` actions in separate statements (they're
different service namespaces so can't share a `Resource` scope; `aoss` control-plane actions
require `Resource: "*"`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BedrockResourceScoped",
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock:Retrieve",
        "bedrock:RetrieveAndGenerate",
        "bedrock:*Guardrail*",
        "bedrock:*KnowledgeBase*",
        "bedrock:*DataSource*",
        "bedrock:*IngestionJob*",
        "bedrock:*Agent*",
        "bedrock:*ModelInvocationJob*"
      ],
      "Resource": [
        "arn:aws:bedrock:ap-southeast-2::foundation-model/*",
        "arn:aws:bedrock:ap-southeast-2:669076482267:*"
      ]
    },
    {
      "Sid": "BedrockDiscovery",
      "Effect": "Allow",
      "Action": [
        "bedrock:ListFoundationModels",
        "bedrock:GetFoundationModel",
        "bedrock:ListInferenceProfiles",
        "bedrock:GetInferenceProfile"
      ],
      "Resource": "*"
    },
    {
      "Sid": "OpenSearchServerlessControlPlane",
      "Effect": "Allow",
      "Action": [
        "aoss:*Collection*",
        "aoss:*SecurityPolicy*",
        "aoss:*AccessPolicy*",
        "aoss:*Policies*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "OpenSearchServerlessDataPlane",
      "Effect": "Allow",
      "Action": ["aoss:APIAccessAll"],
      "Resource": "arn:aws:aoss:ap-southeast-2:669076482267:collection/*"
    },
    {
      "Sid": "S3KnowledgeBaseSource",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:ListBucket",
        "s3:PutObject"
      ],
      "Resource": [
        "arn:aws:s3:::dev-agentic-ai-kb-source",
        "arn:aws:s3:::dev-agentic-ai-kb-source/*"
      ]
    },
    {
      "Sid": "CloudWatchLogs",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "bedrock:*ModelInvocationLoggingConfiguration"
      ],
      "Resource": "*"
    },
    {
      "Sid": "PassBedrockExecutionRole",
      "Effect": "Allow",
      "Action": ["iam:PassRole"],
      "Resource": "arn:aws:iam::669076482267:role/bedrock-kb-execution-role-dev",
      "Condition": {
        "StringEquals": { "iam:PassedToService": "bedrock.amazonaws.com" }
      }
    }
  ]
}
```

### What's added for a full AI app (beyond core Bedrock + OpenSearch)

- **`S3KnowledgeBaseSource`** — Knowledge Base ingestion reads source documents from the S3
  bucket `dev-agentic-ai-kb-source` (created in `ap-southeast-2`, SSE-S3 default encryption +
  versioning enabled; public access block intentionally left off for this dev environment).
  Drop `s3:PutObject` if the app never uploads docs itself and IT/pipeline populates the bucket.
- **`CloudWatchLogs`** — lets the app enable Bedrock model-invocation logging and write
  agent/KB logs to CloudWatch. `bedrock:*ModelInvocationLoggingConfiguration` toggles logging
  on; `logs:*` writes the entries. `Resource: "*"` because log-group names aren't known ahead
  of time (can be tightened to a `/aws/bedrock/*` log-group ARN once the group name is fixed).
- **`PassBedrockExecutionRole`** — the only IAM action needed. Creating roles is restricted, so
  **IT pre-creates the Bedrock execution role** (for Agents/Knowledge Bases) and we only need
  `iam:PassRole` to hand that named role to the `bedrock.amazonaws.com` service when creating a
  KB/Agent. The role name here is `bedrock-kb-execution-role-dev` (the role IT provisions; update
  it if IT uses a different name). The
  `iam:PassedToService` condition locks it so the role can only be passed to Bedrock, nothing
  else. **If even `PassRole` is denied**, IT must create the Knowledge Bases / Agents
  themselves and the app is limited to invoking pre-built ones (still fine for RAG queries via
  `Retrieve`/`RetrieveAndGenerate`, just can't provision new KBs/Agents programmatically).
- **Deliberately excluded** (per current scope): **KMS** (no customer-managed keys), **VPC/EC2**
  (endpoints created manually, not by the app), **Bedrock Flows** (`bedrock:*Flow*`) and
  **Prompt Management** (`bedrock:*Prompt*`) — both are managed orchestration/prompt-store
  features that a code-first AI app replaces with its own logic, so they're not required.

Notes specific to this combined version:
- `BedrockDiscovery` is included here so this policy can list/browse available
  models and inference profiles — not strictly needed today since `AWS_BEDROCK_MODEL_ID` is
  fixed, but included per request. Remove this statement if discovery is never used, to keep
  the policy minimal.
- `OpenSearchServerlessControlPlane` must use `Resource: "*"` — none of those actions support
  resource-level scoping. `OpenSearchServerlessDataPlane` (`APIAccessAll`) does, so it's scoped
  to the account/region collection ARN pattern instead of a bare `*`.
- The `aoss:APIAccessAll` grant here only covers the **IAM side** of data-plane access. The
  OpenSearch Serverless collection also needs its own **data access policy** (a resource-based
  policy on the collection itself, separate from IAM) that explicitly lists this IAM user's
  ARN — request that this be configured when the collection is provisioned, since IAM
  permissions alone aren't sufficient for actual read/write access to the vector data.
- The one-time `iam:CreateServiceLinkedRole` requirement noted above still applies separately
  and isn't part of either `bedrock:*` or `aoss:*` — call it out explicitly to IT if this is the
  first OpenSearch Serverless usage in the account.


## What changes once the new credentials arrive

- Replace `aws-access-key-id` / `aws-secret-access-key` secrets in Key Vault
  (`kv-aicoach-rits`) with the new IAM user's keys.
- Remove `AWS_SESSION_TOKEN` app setting and its Key Vault reference from `infra/main.tf`
  (plain IAM user credentials don't use a session token).
- Retire the STS-refresh step in `infra/refresh-bedrock-creds.sh` (or the whole script, if
  rotation is handled separately) since credentials will no longer expire every ~8h.
