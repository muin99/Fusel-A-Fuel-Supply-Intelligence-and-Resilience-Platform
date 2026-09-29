# Problem and implementation overview

Build a working operations platform on the **official simulated fuel network**, covering observe → detect → predict → decide → simulate → act → monitor → recover.

The authoritative requirement-by-requirement checklist is [08-requirements-review.md](08-requirements-review.md), with source section/line references and verification boundaries.

| Area | Current implementation |
|---|---|
| Operator product | Inventory/status, regional demand, supply, disruptions, alerts, forecast risk, inspectable allocations, what-if, audit and health |
| Intelligence | Adaptive three-model ensemble, uncertainty and drift, constrained LP, heuristic fallback, depot runway and transport estimates |
| GPT | Document-grounded explanations, handovers, investigations with independent critique, trace and source evidence |
| Research | Counterfactual policy comparison, model evaluation history and versioning, recorded replay, reproducible Q-learning/heuristic benchmark |
| Resilience | Validation, timeout/retry, circuit breaker, stale/read cache, Redis queue/direct fallback, model/GPT fallback and recovery alerts |
| Engineering | Docker Compose, CI, unit/integration/browser checks, observability and load evidence |
| Advanced deployment | Helm/Terraform, optional Argo progressive delivery/GitOps, web HPA and revision rollback; cluster prerequisites documented |

Judging weights: product 20%, intelligence 20%, architecture 15%, DevOps 15%, resilience 10%, observability/performance 10%, demo/understanding 10%.

Use [05-demo-script.md](05-demo-script.md) to present the running Compose application. See [09-intelligence.md](09-intelligence.md) for assumptions and for the distinction between measured official-simulator behavior, projected counterfactuals and the separate RL research environment.
