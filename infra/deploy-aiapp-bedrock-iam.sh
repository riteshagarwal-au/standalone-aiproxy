#!/usr/bin/env bash
# Deploys the aiapp Bedrock + RAG IAM stack. All operational flags are baked in
# so no arguments are required. Override any value by exporting the matching env var.
set -euo pipefail

STACK_NAME="${STACK_NAME:-aiapp-bedrock-iam}"
REGION="${REGION:-ap-southeast-2}"
PROFILE="${PROFILE:-stax-au1-telstra-agentic-framework}"
TEMPLATE="$(cd "$(dirname "$0")" && pwd)/aiapp-bedrock-iam.cfn.yaml"

aws cloudformation deploy \
  --template-file "$TEMPLATE" \
  --stack-name "$STACK_NAME" \
  --capabilities CAPABILITY_NAMED_IAM \
  --profile "$PROFILE" \
  --region "$REGION"
