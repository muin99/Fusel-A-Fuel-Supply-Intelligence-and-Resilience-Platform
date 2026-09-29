terraform {
  required_version = ">= 1.6.0"
  required_providers {
    helm = { source = "hashicorp/helm", version = "~> 2.17" }
  }
}
variable "kubeconfig" { type = string }
variable "namespace" {
  type    = string
  default = "fuel-ops"
}
variable "values_file" { type = string }
provider "helm" {
  kubernetes { config_path = var.kubeconfig }
}
resource "helm_release" "fuel_ops" {
  name             = "fuel-ops"
  namespace        = var.namespace
  create_namespace = true
  chart            = "${path.module}/../helm/fuel-ops"
  values           = [file(var.values_file)]
  atomic           = true
  cleanup_on_fail  = true
  timeout          = 300
}
