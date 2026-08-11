variable "subscription_id" {
  description = "Azure subscription ID"
  type        = string
}

variable "location" {
  description = "Azure region (must match the existing shared resource group's region)"
  type        = string
}

variable "resource_group_name" {
  description = "Existing shared resource group name (same as AI-CareerCoach's infra)"
  type        = string
}

variable "acr_name" {
  description = "Existing shared Azure Container Registry name (same as AI-CareerCoach's infra)"
  type        = string
}

variable "app_service_plan_name" {
  description = "Existing shared App Service Plan name (same as AI-CareerCoach's infra)"
  type        = string
}

variable "keyvault_name" {
  description = "Existing shared Key Vault name (same as AI-CareerCoach's infra)"
  type        = string
}

variable "webapp_name" {
  description = "Linux Web App name for AIProxy (globally unique, distinct from AI-CareerCoach's webapp)"
  type        = string
}

variable "image_name" {
  description = "Docker image name in the shared ACR for AIProxy (distinct from AI-CareerCoach's image)"
  type        = string
}

variable "proxy_integration_id" {
  description = "App identifier sent in Copilot telemetry headers"
  type        = string
}

variable "proxy_port" {
  description = "TCP port AIProxy_Process listens on inside the container"
  type        = string
}

variable "aws_region" {
  description = "AWS region for the aws-bedrock backend"
  type        = string
  default     = "ap-southeast-2"
}

variable "aws_bedrock_model_id" {
  description = "Optional override Bedrock model ID/inference-profile ID for the aws-bedrock backend, used only when a request's model isn't in BEDROCK_MODEL_CATALOG (aws-bedrock.ts). Leave empty to fall back to the first catalog entry — no model needs to be hardcoded here."
  type        = string
  default     = ""
}

variable "aws_bedrock_models_allowlist" {
  description = "Comma-separated friendly model ids shown by /v1/models for the aws-bedrock backend (must match keys in BEDROCK_MODEL_CATALOG in aws-bedrock.ts, e.g. claude-haiku-4.5,gemma-3-27b). Empty = show full catalog."
  type        = string
  default     = "claude-haiku-4.5,gemma-3-27b"
}

variable "copilot_models_allowlist" {
  description = "Comma-separated model ids shown by /v1/models for the copilot backend. Empty = show the full upstream Copilot model list."
  type        = string
  default     = ""
}
