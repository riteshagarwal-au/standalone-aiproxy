# AWS IAM Policies — for IT to create (aiproxy Bedrock + RAG)

This is the ready-to-apply policy set for the aiproxy workload. There are **two separate
identities** — don't merge them:

| # | Identity | Type | Who uses it | Policy below |
|---|----------|------|-------------|--------------|
| A | `aiproxy-bedrock-svc` | **IAM user** (static keys) | the app, from Azure | §1 |
| B | `bedrock-kb-execution-role-dev` | **IAM role** | AWS Bedrock service (assumes it) | §2 + §3 |

- **Account**: `669076482267`
- **Region**: `ap-southeast-2`
- **S3 source bucket** (already created): `dev-agentic-ai-kb-source`

The app user (A) never does KB ingestion itself — it *passes* role B to Bedrock via
`iam:PassRole`, and Bedrock uses role B to read S3 / call embeddings / write vectors.

---

## §1. IAM user policy — `aiproxy-bedrock-svc`

Attach to the IAM user `aiproxy-bedrock-svc` (Identity A).

> The `iam:PassRole` statement references role `bedrock-kb-execution-role-dev` (created in §2).
> If IT chooses a different role name, update it in that statement to match.

File: `aiproxy-bedrock-svc-policy.json`

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

See `iam-requirement.md` for the full justification of each statement.

---

## §2. Execution role — trust policy

Who may assume role B. Only the Bedrock service, only for KBs in **our** account/region
(the `SourceAccount` + `SourceArn` conditions are the confused-deputy guard).

File: `bedrock-kb-trust-policy.json`

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowBedrockToAssume",
      "Effect": "Allow",
      "Principal": { "Service": "bedrock.amazonaws.com" },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": { "aws:SourceAccount": "669076482267" },
        "ArnLike": {
          "aws:SourceArn": "arn:aws:bedrock:ap-southeast-2:669076482267:knowledge-base/*"
        }
      }
    }
  ]
}
```

---

## §3. Execution role — permission policy

What role B may do. Only three things: read S3 source docs, invoke the embeddings model,
access the OpenSearch Serverless data plane. **Much narrower** than §1 — this role never needs
`PassRole`, `CreateAgent`, or discovery.

File: `bedrock-kb-permissions-policy.json`

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "S3ReadSourceDocs",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::dev-agentic-ai-kb-source",
        "arn:aws:s3:::dev-agentic-ai-kb-source/*"
      ],
      "Condition": {
        "StringEquals": { "aws:ResourceAccount": "669076482267" }
      }
    },
    {
      "Sid": "InvokeEmbeddingsModel",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel"],
      "Resource": [
        "arn:aws:bedrock:ap-southeast-2::foundation-model/amazon.titan-embed-text-v2:0"
      ]
    },
    {
      "Sid": "OpenSearchServerlessDataAccess",
      "Effect": "Allow",
      "Action": ["aoss:APIAccessAll"],
      "Resource": [
        "arn:aws:aoss:ap-southeast-2:669076482267:collection/*"
      ]
    }
  ]
}
```

**Notes for IT:**
- **Embeddings model** — `amazon.titan-embed-text-v2:0` is the common Bedrock KB default. Swap
  it if a different embed model (e.g. `cohere.embed-english-v3`) is chosen; it must match the
  model selected when the KB is created.
- **`aoss:APIAccessAll`** is only the IAM half. The OpenSearch Serverless collection **also**
  needs a **data access policy** (resource-based, on the collection) listing this role's ARN —
  configured when the collection is provisioned.

---

## §4. CLI to apply everything

```bash
# Identity A — IAM user policy
aws iam put-user-policy \
  --user-name aiproxy-bedrock-svc \
  --policy-name aiproxy-bedrock-svc \
  --policy-document file://aiproxy-bedrock-svc-policy.json

# Identity B — execution role
aws iam create-role \
  --role-name bedrock-kb-execution-role-dev \
  --assume-role-policy-document file://bedrock-kb-trust-policy.json

aws iam put-role-policy \
  --role-name bedrock-kb-execution-role-dev \
  --policy-name bedrock-kb-permissions \
  --policy-document file://bedrock-kb-permissions-policy.json
```

The `iam:PassRole` statement in §1 references `bedrock-kb-execution-role-dev`. If IT creates the
role under a different name, update that statement (and `iam-requirement.md`) to match.
