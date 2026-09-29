# Deployment, delivery and rollback

The tested judge path is `docker compose up -d --build --wait`. Existing `.env` should be preserved; copy `.env.example` only for a fresh setup. Set operator/viewer passwords, JWT secret and optional GPT key. Postgres persists data in a volume. Simulator state is ephemeral; restarting its container starts a new world.

## Optional Kubernetes deployment

The chart is designed for a local or pre-provisioned cluster. It does not create cloud accounts or resources. It supplies one official simulator, one API writer, Postgres with PVC, Redis and scalable web replicas. Never run two active simulator instances for the same judging run. Recreate strategy prevents duplicate API writers. The web image must be built with `NEXT_PUBLIC_API_URL=/api` for ingress routing, or the public API URL used by the judging browser.

Prerequisites: Kubernetes, default storage class, image access, Helm **3**, and (for HPA) metrics-server. For ingress, install an ingress controller. Create namespace `fuel-ops` and a Secret named `fuel-ops-env` containing `JWT_SECRET`, `OPERATOR_PASSWORD`, `VIEWER_PASSWORD`, `POSTGRES_PASSWORD`, `DATABASE_URL=postgres://fuelops:<password>@fuel-ops-postgres:5432/fuelops` and optionally GPT variables. Use a local secret file outside version control with `kubectl create secret generic fuel-ops-env --from-env-file=<path> -n fuel-ops`. Do not put secret values in chart values or Terraform state.

Build/push versioned images or load them into a local cluster, then supply image names in a private values file:

```bash
helm lint infra/helm/fuel-ops
scripts/deploy-k8s.sh -f /path/to/values.yaml
helm history fuel-ops -n fuel-ops
helm rollback fuel-ops 1 -n fuel-ops --wait
```

The deploy script uses Helm 3 `--atomic --wait` so failed upgrades roll back. A successful rollout is not proof of application correctness: run health, browser and integration checks afterwards. Schema synchronization is for this hackathon; schema-breaking downgrades require a database backup and migrations before production use.

Terraform initializes and validates with `terraform -chdir=infra/terraform init` and `validate`. Supply `kubeconfig`, `values_file` and optional namespace before plan/apply. It installs the same local Helm chart with an atomic release. No Terraform apply was run against an external cluster.

## Progressive web delivery and GitOps

The chart supports `webStrategy=rolling` (default), `blueGreen` and `canary`. The latter two require the Argo Rollouts controller/CRDs. Blue/green provisions an active and preview service and waits for promotion. Canary uses staged 25% and 50% replica weights with pauses; without a traffic router, weights are approximate pod ratios, especially at low replica counts. Use at least four web replicas for a meaningful canary demonstration. API remains a single writer and is not part of frontend progressive delivery.

HPA targets only web and needs metrics-server. This avoids pretending the process-local decision policy/cache is safe for multiple concurrent API writers. Redis Streams consumer-group ingestion provides bounded queueing, pending retry and acknowledgments after storage; direct ingestion is the Redis-outage fallback. Queue retention is capped near 1,000 snapshots, so prolonged outages can lose old inventory snapshots; demand history is recovered only within the simulator's bounded history window.

`infra/gitops/application.yaml` is an Argo CD template. Replace `repoURL`, publish the source/images, create the secret and install Argo CD before applying it. Do not run GitOps and manual Helm/Terraform changes as competing owners of the same release.

Official references: [Kubernetes HPA](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/), [deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/), [Argo canary](https://argoproj.github.io/argo-rollouts/features/canary/), [Argo blue/green](https://argoproj.github.io/argo-rollouts/features/bluegreen/), [Helm rollback](https://docs.helm.sh/docs/helm/helm_rollback/).
