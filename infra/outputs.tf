output "webapp_url" {
  description = "Public URL of the AIProxy Web App"
  value       = "https://${azurerm_linux_web_app.aiproxy.default_hostname}"
}

output "acr_login_server" {
  description = "ACR login server (shared with AI-CareerCoach)"
  value       = data.azurerm_container_registry.acr.login_server
}

output "acr_push_command" {
  description = "Commands to build and push the Docker image"
  value       = <<-EOT
    az acr login --name ${var.acr_name}
    docker build -t ${data.azurerm_container_registry.acr.login_server}/${var.image_name}:latest ../
    docker push ${data.azurerm_container_registry.acr.login_server}/${var.image_name}:latest
  EOT
}
