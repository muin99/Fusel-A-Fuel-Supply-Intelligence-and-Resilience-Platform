#!/usr/bin/env bash
set -euo pipefail
# Helm 3: atomic rolls back a failed upgrade. Existing cluster, images and secret required.
helm upgrade --install fuel-ops infra/helm/fuel-ops --namespace fuel-ops --create-namespace --atomic --wait --timeout 5m "$@"
