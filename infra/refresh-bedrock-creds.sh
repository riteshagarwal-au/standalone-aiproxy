#!/usr/bin/env bash
# Refreshes AWS Bedrock STS credentials via stax2aws, uploads them to the
# Azure Key Vault used by the aiproxy Web App, then restarts the app so it
# picks up the new secrets. Run this whenever Bedrock calls start failing
# with expired/invalid credential errors (STS tokens last ~8h).
set -euo pipefail

STAX_PROFILE="stax-au1-telstra-agentic-framework"
KEYVAULT_NAME="kv-aicoach-rits"
RESOURCE_GROUP="rg-rits"
WEBAPP_NAME="llm-aiproxy"

echo "==> Logging in via stax2aws (profile: ${STAX_PROFILE})..."
stax2aws login -p "${STAX_PROFILE}" -f

echo "==> Reading fresh credentials from ~/.aws/credentials..."
AWS_ACCESS_KEY_ID=$(aws configure get aws_access_key_id --profile "${STAX_PROFILE}")
AWS_SECRET_ACCESS_KEY=$(aws configure get aws_secret_access_key --profile "${STAX_PROFILE}")
AWS_SESSION_TOKEN=$(aws configure get aws_session_token --profile "${STAX_PROFILE}")

if [[ -z "${AWS_ACCESS_KEY_ID}" || -z "${AWS_SECRET_ACCESS_KEY}" || -z "${AWS_SESSION_TOKEN}" ]]; then
  echo "ERROR: one or more credential values are empty, aborting." >&2
  exit 1
fi

echo "==> Uploading secrets to Key Vault (${KEYVAULT_NAME})..."
az keyvault secret set --vault-name "${KEYVAULT_NAME}" --name "aws-access-key-id" --value "${AWS_ACCESS_KEY_ID}" >/dev/null
az keyvault secret set --vault-name "${KEYVAULT_NAME}" --name "aws-secret-access-key" --value "${AWS_SECRET_ACCESS_KEY}" >/dev/null
az keyvault secret set --vault-name "${KEYVAULT_NAME}" --name "aws-session-token" --value "${AWS_SESSION_TOKEN}" >/dev/null

echo "==> Restarting Web App (${WEBAPP_NAME})..."
az webapp restart --name "${WEBAPP_NAME}" --resource-group "${RESOURCE_GROUP}" >/dev/null

echo "==> Done. New Bedrock STS credentials are live in ${WEBAPP_NAME}."
