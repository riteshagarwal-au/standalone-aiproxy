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
