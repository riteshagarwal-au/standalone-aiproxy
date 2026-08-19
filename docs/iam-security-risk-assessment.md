# Security Risk Assessment — Compromise of the `aiproxy-bedrock-svc` IAM User

**Scope**: This document assesses the blast radius if the static access keys of the dedicated
IAM User (`aiproxy-bedrock-svc`) — granted the policy in
[iam-requirement.md](iam-requirement.md#L237) (the "Final combined JSON") — are leaked or
stolen. It is intended to accompany the IAM access request so IT/security can review the
worst-case impact before approving.

**Account / region in scope**: `669076482267` (Stax `stax-au1-telstra-agentic-framework`),
`ap-southeast-2` (Sydney).

**Credential type**: long-lived IAM access key ID + secret (no console login, no MFA on the
programmatic key — this is inherent to programmatic keys). Stored in Azure Key Vault
(`kv-aicoach-rits`) and consumed by the Azure App Service–hosted proxy.

---

## Summary of blast radius

| Dimension | Exposure if compromised |
|---|---|
| **AWS account boundary** | Locked to `669076482267` — no cross-account access. |
| **Region boundary** | Bedrock/OpenSearch resource statements pinned to `ap-southeast-2`. `bedrock:*` discovery, `logs:*`, and `s3:*` statements are **not** region-pinned (see gaps). |
| **Service boundary** | Only `bedrock`, `aoss` (OpenSearch Serverless), `s3` (one bucket), `logs`, and a single scoped `iam:PassRole`. No EC2, IAM user/key management, KMS, networking, billing, or Organizations access. |
| **Privilege escalation** | Low — cannot create/modify IAM users, roles, or policies; the one `iam:PassRole` is condition-locked to `bedrock.amazonaws.com`. |
| **Data exfiltration** | Moderate — can read the KB source S3 bucket and query vector data / knowledge bases. |
| **Cost / abuse** | **High** — can invoke models and run batch/ingestion jobs, driving spend. This is the most likely real-world impact. |

---

## What an attacker COULD do

### 1. Run up cost by invoking models (highest likelihood)
`bedrock:InvokeModel` / `InvokeModelWithResponseStream` on any account-enabled model in the
region. An attacker could generate large volumes of expensive inference (or batch
`ModelInvocationJob`s) until a quota or budget alert stops them.
- **Impact**: financial (runaway spend), possible service-quota exhaustion for legitimate use.
- **Mitigation**: Bedrock service quotas + AWS Budgets alert (item 7 in the request doc);
  CloudWatch anomaly alerting on invocation volume.

### 2. Read/exfiltrate Knowledge Base source data (S3)
`s3:GetObject`/`s3:ListBucket` on the single KB source bucket (`REPLACE-KB-SOURCE-BUCKET`).
- **Impact**: confidentiality — any documents staged for RAG ingestion are readable. Sensitivity
  depends entirely on what is placed in that bucket.
- **Mitigation**: keep only non-sensitive/approved corpora in the bucket; enable S3 access
  logging + bucket-level SCP/deny for unexpected principals; scope the ARN to the exact bucket
  (already done via placeholder).

### 3. Query and tamper with RAG / Knowledge Bases
`Retrieve`/`RetrieveAndGenerate` + `bedrock:*KnowledgeBase*`/`*DataSource*`/`*IngestionJob*`
allow reading vector content and **creating/updating/deleting** knowledge bases, data sources,
and ingestion jobs.
- **Impact**: integrity — an attacker could delete a KB, poison it by triggering ingestion of
  attacker-controlled data (if they can also write to the source bucket via `s3:PutObject`), or
  read indexed content.
- **Mitigation**: drop `s3:PutObject` if the app does not upload docs (removes the poisoning
  path); CloudTrail alerting on `Delete*`/`Create*IngestionJob` events.

### 4. Create / modify / invoke Bedrock Agents and Guardrails
`bedrock:*Agent*` and `bedrock:*Guardrail*` allow full lifecycle management of agents and
guardrails in the account/region.
- **Impact**: integrity — could disable/weaken a guardrail (bypassing content safety) or create
  a rogue agent. Bounded to Bedrock; an agent's own actions are limited by the **execution
  role** IT provisions (see PassRole below), not by this user's permissions.
- **Mitigation**: CloudTrail alerting on guardrail `Update*/Delete*`; keep the agent execution
  role least-privileged.

### 5. Manage the OpenSearch Serverless vector store
`aoss:*Collection*`/`*Policy*`/`*Policies*` (control plane, `Resource: "*"`) + `APIAccessAll`
(data plane, collection-scoped) allow creating/deleting collections, **editing security and
data-access policies**, and reading/writing vector data.
- **Impact**: integrity/availability — could delete the vector collection (breaking RAG) or
  broaden a data-access policy. Note: `APIAccessAll` in IAM still requires the collection's own
  **data access policy** to name this principal, so raw data read/write is gated by that second
  policy too (defence-in-depth).
- **Mitigation**: CloudTrail alerting on `aoss:Delete*`/`Update*AccessPolicy`; restrict who can
  edit the collection data-access policy.

### 6. Pass the Bedrock execution role (scoped)
`iam:PassRole` on exactly one role ARN, condition-locked to `iam:PassedToService =
bedrock.amazonaws.com`.
- **Impact**: low/bounded — the attacker can only hand the **already-existing** Bedrock
  execution role to a Bedrock resource they create (e.g. a rogue agent/KB). The effective
  additional privilege is whatever that execution role itself grants — so the real risk lives
  in **how tightly IT scopes that execution role**, not in this PassRole grant.
- **Mitigation**: keep the execution role least-privileged (only the specific S3/aoss/model
  resources the KB/Agent needs); the `PassedToService` condition already blocks passing it to
  EC2/Lambda/etc.

### 7. Toggle model-invocation logging
`bedrock:*ModelInvocationLoggingConfiguration` + `logs:CreateLogGroup/Stream/PutLogEvents`.
- **Impact**: low — could **disable** invocation logging to reduce their own visibility, or
  write junk log events. Cannot read other services' logs (no `logs:Get*`/`FilterLogEvents`).
- **Mitigation**: CloudTrail alerting on `PutModelInvocationLoggingConfiguration`/
  `DeleteModelInvocationLoggingConfiguration`; treat CloudTrail (not the Bedrock invocation log)
  as the authoritative audit source since CloudTrail is out of this user's control.

---

## What an attacker CANNOT do (containment)

- **No cross-account access** — every resource ARN is pinned to `669076482267`.
- **No IAM identity manipulation** — cannot create/delete users, roles, policies, or access
  keys; cannot attach policies; cannot escalate privileges beyond the single scoped `PassRole`.
- **No credential/key theft of other principals** — no `iam:*` read of other users, no
  `sts:AssumeRole` into other roles.
- **No infrastructure control** — no EC2, VPC, networking, Lambda, ECS/EKS, RDS, etc.
- **No KMS** — cannot decrypt anything protected by customer-managed keys.
- **No billing/Organizations/account-settings** access.
- **No access to other S3 buckets** — only the single named KB source bucket.
- **No broad log/monitoring read** — cannot read CloudTrail or arbitrary CloudWatch logs.

---

## Region-scoping gaps to be aware of

A few statements use `Resource: "*"` and are therefore **not** region- or resource-pinned:

- `BedrockDiscovery` (`List*`/`Get*` models) — read-only metadata, low risk; AWS requires `"*"`.
- `OpenSearchServerlessControlPlane` — `"*"` is required (no resource-level support), so a
  compromised key could manage `aoss` collections in **any** region, not just Sydney. Consider
  an SCP or a `aws:RequestedRegion` condition to pin it to `ap-southeast-2` if your org supports
  that.
- `CloudWatchLogs` + `bedrock:*ModelInvocationLoggingConfiguration` — `"*"` spans regions. Can
  be tightened to `arn:aws:logs:ap-southeast-2:669076482267:log-group:/aws/bedrock/*` once the
  log-group name is fixed.
- `S3KnowledgeBaseSource` — S3 ARNs are global by nature (no region segment); bucket name is the
  boundary.

**Recommended hardening (optional):** add a policy-wide or SCP-level condition
`"aws:RequestedRegion": "ap-southeast-2"` to blanket-deny any action outside the Sydney region,
which closes the region gaps above without changing individual statements.

---

## Detection & response recommendations

1. **AWS Budgets + anomaly alerts** on Bedrock spend — earliest signal of invocation abuse.
2. **CloudTrail alerting** on high-risk events from this principal:
   `Delete*` (KB/agent/collection), `Update*AccessPolicy`, `*Guardrail` updates,
   `*ModelInvocationLoggingConfiguration`, and `iam:PassRole` usage.
3. **Key rotation** on the enforced interval (item 6 in the request doc); rotate immediately on
   any suspicion.
4. **Immediate revocation path**: deactivate/delete the access key in IAM (does not require
   deleting the user), then issue a fresh key into Key Vault. Because the app reads keys from
   Key Vault, rotation is a secret update + app restart — no code change.
5. **Least-privilege the execution role** IT provisions, since `PassRole` inherits its scope.
6. **Keep sensitive data out of the KB source bucket** unless it is explicitly approved for RAG.

---

## Overall risk rating

| Category | Rating | Rationale |
|---|---|---|
| Confidentiality | **Medium** | Readable KB bucket + vector data; bounded to one bucket/collection. |
| Integrity | **Medium** | Can delete/alter KBs, agents, guardrails, collections in-region. |
| Availability | **Medium** | Can delete the vector collection / KBs, breaking RAG. |
| Cost/abuse | **High** | Unbounded model invocation until quotas/budgets intervene. |
| Privilege escalation | **Low** | No IAM identity control; single condition-locked `PassRole`. |
| Lateral movement | **Low** | Single account, no STS/AssumeRole, no infra services. |

**Net**: A compromise is **contained to the Bedrock/RAG workload in one account and region**,
with the primary realistic damage being **cost abuse** and **disruption/tampering of RAG
resources** — not a broader AWS account takeover. The controls above (budgets, CloudTrail
alerting, region SCP, key rotation, least-privilege execution role) reduce residual risk to an
acceptable level for a service credential of this scope.
