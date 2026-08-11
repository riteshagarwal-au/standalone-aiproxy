data "azurerm_client_config" "current" {}

# ── Shared resources — owned and created by AI-CareerCoach's own Terraform
# state (infra/main.tf in that repo). Referenced here as data sources, not
# recreated, since this repo's Terraform state must not compete for
# ownership of resources another repo's state already manages.
data "azurerm_resource_group" "rg" {
  name = var.resource_group_name
}

data "azurerm_container_registry" "acr" {
  name                = var.acr_name
  resource_group_name = data.azurerm_resource_group.rg.name
}

data "azurerm_service_plan" "asp" {
  name                = var.app_service_plan_name
  resource_group_name = data.azurerm_resource_group.rg.name
}

data "azurerm_key_vault" "kv" {
  name                = var.keyvault_name
  resource_group_name = data.azurerm_resource_group.rg.name
}

# The ghu-app-token secret already exists in the shared Key Vault, created
# by AI-CareerCoach's own Terraform (infra/main.tf, azurerm_key_vault_secret
# "ghu_app_token"). Referenced here, not duplicated.
data "azurerm_key_vault_secret" "ghu_app_token" {
  name         = "ghu-app-token"
  key_vault_id = data.azurerm_key_vault.kv.id
}

# Temporary Bedrock STS credentials (~8h validity, Stax-issued) — uploaded manually via
# `az keyvault secret set` (see docs/PLAN.md Step 10). Not managed by this Terraform state;
# referenced only so the Web App can pick them up via Key Vault references.
data "azurerm_key_vault_secret" "aws_access_key_id" {
  name         = "aws-access-key-id"
  key_vault_id = data.azurerm_key_vault.kv.id
}

data "azurerm_key_vault_secret" "aws_secret_access_key" {
  name         = "aws-secret-access-key"
  key_vault_id = data.azurerm_key_vault.kv.id
}

data "azurerm_key_vault_secret" "aws_session_token" {
  name         = "aws-session-token"
  key_vault_id = data.azurerm_key_vault.kv.id
}

# ── AIProxy — this repo's own resource, created by this Terraform state ──
resource "azurerm_linux_web_app" "aiproxy" {
  name                = var.webapp_name
  resource_group_name = data.azurerm_resource_group.rg.name
  location            = data.azurerm_resource_group.rg.location
  service_plan_id     = data.azurerm_service_plan.asp.id

  identity {
    type = "SystemAssigned"
  }

  site_config {
    health_check_path                 = "/health"
    health_check_eviction_time_in_min = 2
    application_stack {
      docker_image_name        = "${var.image_name}:latest"
      docker_registry_url      = "https://${data.azurerm_container_registry.acr.login_server}"
      docker_registry_username = data.azurerm_container_registry.acr.admin_username
      docker_registry_password = data.azurerm_container_registry.acr.admin_password
    }
  }

  app_settings = {
    WEBSITES_PORT                    = var.proxy_port
    DOCKER_ENABLE_CI                 = "true"
    # Custom container deployments default this to false (unlike code-based App Service);
    # required so /home/data (backend-override.json, metrics, exchanges) survives restarts/redeploys.
    WEBSITES_ENABLE_APP_SERVICE_STORAGE = "true"
    PROXY_PORT           = var.proxy_port
    PROXY_HOST           = "0.0.0.0"
    PROXY_INTEGRATION_ID = var.proxy_integration_id
    PROXY_STORAGE_DIR    = "/home/data"
    GHU_APP_TOKEN        = "@Microsoft.KeyVault(VaultName=${var.keyvault_name};SecretName=ghu-app-token)"

    # aws-bedrock backend (Key Vault references — secrets uploaded manually, ~8h STS validity)
    AWS_REGION            = var.aws_region
    AWS_BEDROCK_MODEL_ID  = var.aws_bedrock_model_id
    AWS_ACCESS_KEY_ID     = "@Microsoft.KeyVault(VaultName=${var.keyvault_name};SecretName=aws-access-key-id)"
    AWS_SECRET_ACCESS_KEY = "@Microsoft.KeyVault(VaultName=${var.keyvault_name};SecretName=aws-secret-access-key)"
    AWS_SESSION_TOKEN     = "@Microsoft.KeyVault(VaultName=${var.keyvault_name};SecretName=aws-session-token)"
  }

  lifecycle {
    ignore_changes = [
      # KV reference is injected via null_resource below; prevent Terraform from overwriting it
      site_config[0].application_stack[0].docker_registry_password
    ]
  }
}

# AIProxy's own managed identity needs read access to the shared Key Vault
# to resolve its GHU_APP_TOKEN app setting — added as a new access policy
# on the existing (shared) Key Vault, without modifying any existing policy.
resource "azurerm_key_vault_access_policy" "aiproxy_policy" {
  key_vault_id = data.azurerm_key_vault.kv.id
  tenant_id    = data.azurerm_client_config.current.tenant_id
  object_id    = azurerm_linux_web_app.aiproxy.identity[0].principal_id

  secret_permissions = ["Get", "List"]
}
