# Source requirements review

Reviewed both originals in `docs/source`. Searchable transcriptions are `source/problem-statement.txt` (PDF text extraction retains OCR imperfections) and `source/integration-guide.txt` (DOCX paragraphs). The originals remain authoritative. References below give brief section and transcription line numbers. The brief explicitly distinguishes requirements, recommended deliverables and optional examples; all are accounted for here without claiming that research projections are simulator ground truth.

## Mandatory application, intelligence and operation

| Source / line | Requirement | Implementation / review location |
|---|---|---|
| Brief §1–5, 76–104 / 169–171 | Full observe→detect→predict→decide→simulate→act→monitor→recover loop | Nest state, ingestion, detection, forecast, decision, audit, health; Next operator console |
| §6, 178 | Current fuel inventory | Overview station/depot inventory by Diesel, Petrol, Octane |
| §6, 179 | Depot/station status | Overview and disruptions |
| §6, 180 | Regional demand | Intelligence Lab regional demand charts with unmet demand |
| §6, 181–182 | Shortage alerts and projected risk | Risk & Forecast; alert feed; estimated stockout times/probabilities |
| §6, 183 | Incoming supply | Overview supply table; Intelligence Lab depot runway |
| §6, 184 | Disruptions | Domain events, route status and incident detection |
| §6, 185–186 | Recommendations and expected impact | Constrained LP allocations, risk before/after, feasible what-if, policy stress comparison |
| §6, 187–189 | System alerts, history, health | Disruptions, Decision History, System Health |
| §7, 194 | Meaningful intelligence | Adaptive forecasting + constrained optimization + incident detection + grounded GPT |
| §9, 273–275 | Inspect signals, constraints, impact, uncertainty, alternatives | Recommendation inspector; explicit low-confidence review; AI explanations; source evidence |
| §10, 283–284 | Shipment delay warning and impact | Delayed arrival alerts; depot supply runway uses updated planned ticks; no future stock borrowed for dispatch |
| §10, 285–286 | Demand spike adaptation | Forecast level adaptation, drift detection, lowered confidence and changing allocation priorities |
| §10, 288–289 | Depot constraint | Reduced dispatch planning budget; inventory/reserve constraints |
| §10, 291–292 | Regional/route disruption | Unavailable routes excluded; alternate depot routing and no-route alerts |
| §10, 294–298 | Combined crises, explanation and recovery | `scripts/judge-check.mjs`; `evidence/judge-check.json` |
| §11, 303 | Model unavailable | Heuristic reorder policy; health down; fallback counter |
| §11, 304 | Invalid simulator response | Zod rejection, alert, last-known-good read fallback |
| §11, 305 | Low prediction confidence | NEEDS_REVIEW; uncertainty shown; operator approval |
| §11, 306 / 313–315 | Dependency failure | Timeouts, bounded retries, breaker, Redis/direct-ingestion fallback, cached state and browser stale banner |
| §12, 318–330 | Reproducible deploy and delivery workflow | Docker Compose, package scripts, GitHub Actions build/test/package/smoke/load checks |
| §14, 355 | Request rate, latency, errors, availability | prom-client and rolling health stats; Prometheus/Grafana |
| §14, 356 | CPU/memory/resource usage | Node process metrics and captured container resource readings |
| §14, 358–359 | Model error/confidence, alerts, decisions/fallback | Forecast error histograms, confidence gauges, counters; GPT latency/outcome metrics |
| §14, 361–362 | Actions, integration failures, recovery logs | Structured Pino logs, persistent audit and incident recovery entries |
| §15, 376–389 | Component health visible | API, Postgres, Redis, simulator, SSE, prediction, decision, GPT status |
| §16, 392–394 | Document data provenance | `07-assumptions-and-data.md`, `09-intelligence.md`; official observations + documented priors; separate RL surrogate |
| §17, 403–413 | Load workload and measured percentiles/throughput/errors/concurrency/resources | `loadtest/k6-api.js`, raw summaries, `06-load-test-report.md`, evidence resource snapshots |
| §18, 419–426 | No secrets in source, input validation, errors, config, role restriction | `.env` ignored; example key removed; Zod; JWT roles; rate limits; server-only GPT key |
| §24 | Simulation-only, distinguish projections, preserve review | Official image unchanged; no real fuel actions; projection labels; fresh-state approval gate |

## Required deliverables (§19, lines 430–442)

| Deliverable | Evidence |
|---|---|
| 1. Working application | Running Compose services and browser tests/screenshots |
| 2. Source repository | Workspace source, lockfile, README, deployment instructions; remote repository publication is not configured |
| 3. Official simulator integration | Published image `asifmahmoud414/bup-fuel-supply-simulator:1.0.0`; REST/SSE client |
| 4. Intelligence component | Ensemble, optimization, detection, GPT + retrieval |
| 5. Operator interface | Nine console routes including Intelligence Lab |
| 6. Architecture diagram | `03-architecture.md`, `09-intelligence.md` |
| 7. Deployment | Compose tested; Helm/Terraform optional deployment artifacts |
| 8. Observability evidence | Metrics export, health snapshots, Grafana provisioning and screenshots |
| 9. Resilience demonstration | Prediction outage, stale data and recovery checks in recorded JSON |
| 10. Load evidence | k6 workload and timestamped measured results |
| 11. Final demo | Rehearsal script and browser evidence ready; the actual judge-supervised presentation occurs at judging |

## Every intelligence example (§7)

| Source lines | Capability | Coverage |
|---|---|---|
| 198 | Demand forecast | Three-model adaptive ensemble |
| 199–200 | Shortage prediction / probability | Forward inventory projection and approximate normal risk |
| 201 | Supply arrival estimate | Organizer planned ticks, explicitly including delayed supply |
| 202 | Transport delay prediction | Nominal travel plus mean observed arrival residual; sample count and cold-start label |
| 208 | Anomalous demand | Seasonal ratio surge and distribution drift |
| 209 | Abnormal inventory change | Arrival/demand-reconciled station inventory residual; thresholded alert |
| 210 | Bottlenecks | No-route alert, constrained depot budgets, projected depot runway |
| 211 | Regional disruption | Region-wide surge detection and route events |
| 214–219 | Constrained / heuristic / priority / RL / math / hybrid | LP, priority greedy fallback, ML-informed needs, separate trained Q-learning benchmark |
| 222–226 | Incident explanation, summary, investigation, explanation | GPT Responses API, source retrieval, independent critic and coordinator; deterministic fallback |

## Every recommended deliverable (§20, lines 445–454)

| Item | Implementation |
|---|---|
| CI/CD | GitHub Actions compile/lint/test/package/deploy/smoke/load; optional cluster deployment script |
| Automated tests | Forecast/optimization/retrieval/GPT tests, live integration checks, Playwright browser tests |
| Experiment tracking | Persistent audit-backed experiment runs with version, tick, errors and weights |
| Model versioning | `adaptive-ensemble-2.0.0`, `tabular-q-1.0.0`; source-controlled model artifact |
| Decision audit | Actor, action, tick, recommendation/dispatch IDs, rationale |
| Deployment versioning | Chart/app version and image version labels; Helm revision history |
| Simulation replay | Recorded inventory/demand by tick; does not claim to rewind official simulator |
| Scenario configuration | Operator-only event/fault controls for all six events/five faults |
| Automated fallback | Forecast→heuristic, GPT→template, Redis queue→direct ingestion, simulator→cache |
| Rollback | Operator policy override; Helm atomic failed-upgrade rollback and revision rollback |

## Every advanced example (§13 / §21)

| Item | Status and evidence |
|---|---|
| RL | Implemented offline tabular Q-learning with separate training/test seeds and heuristic comparison. Research only; no automatic dispatch or official-simulator performance claim |
| Multi-agent decision support | Bounded specialist workflow: retrieval, forecast, optimizer, deterministic gate, independent GPT risk critic, GPT coordinator; trace visible in UI. Orchestrated roles, not autonomous dispatch agents |
| Optimization + ML | Forecast-dependent needs, risk weights and safety cover feed constrained LP |
| Uncertainty-aware allocation | Dispersion-adjusted target cover; low-confidence review; widened displayed bounds under drift |
| Counterfactual simulation | No-action/heuristic/LP projected under mean, demand stress and combined delay stress |
| Automated incidents | Demand, inventory, shortage, depot runway, route/station/depot events and recovery |
| Policy rollback | Force heuristic or clear override from Scenario Control |
| Drift | Recent normalized-demand shift vs reference window; confidence reduction and alert |
| Event-driven / streaming | Official SSE→REST refresh, internal events, UI SSE and Redis Streams ingestion queue |
| Queue processing | Consumer group, pending-entry retries, ACK after persistence; direct fallback on Redis failure |
| Kubernetes / Helm | Chart includes official simulator, data services, API, web, probes, PVC, service discovery, resource limits |
| Infrastructure as Code / Terraform | Helm provider release with atomic deployment; initialized and validated |
| GitOps | Argo CD Application manifest; requires actual repository URL and installed controller |
| Automated rollback | Helm 3 `--atomic --wait`; revision rollback command documented |
| Blue/green | Optional Argo Rollouts web strategy, active/preview service and manual promotion |
| Canary | Optional web 25%→50% staged rollout with pauses; approximate pod-ratio traffic split |
| Autoscaling | Frontend HPA; requires metrics-server. API remains a single writer deliberately |
| Distributed services / discovery | Compose/Kubernetes services for API, web, simulator, Postgres, Redis; internal DNS |
| Generative operations assistant | Real GPT calls verified; read-only specialist investigation, explanation and handover |

Cluster manifests are supplied and statically validated. No existing Kubernetes cluster, public repository, registry or Argo controller was configured in the workspace, so cluster rollouts/GitOps/autoscaling are not represented as live-tested evidence. Compose is the fully exercised judging path.

## Integration guide contract audit

| Guide section | Contract | Implementation / limitation |
|---|---|---|
| §1–3 | Published image, one local world, configurable clock | Compose official image; no simulator source changes |
| §2 | REST truth; SSE hints; deterministic scenarios | State refresh after hints plus polling; source seed/tick retained |
| §2 / §7 | Admin and health bypass faults | Separate admin methods; readiness does not infer domain health from liveness alone |
| §4.1–4.12 | Health/instance/regions/depots/stations/routes/supply/events/allocations/history/metrics | Typed client schemas and bounded history reads |
| §5.1–5.3 | Valid allocation body, all constraints | LP/heuristic constraints, what-if validation, final simulator validation |
| §5.4 | Body idempotency key, exact replay | Recommendation UUID-derived key; simulator retry keeps body identical |
| §5.5 | Cancel PENDING only | Client cancel method; organizer returns domain error for non-PENDING |
| §6.1–6.3 | SSE framing/comments/keepalive/reconnect | Event parser ignores comments, 45s silence watchdog, reconnect/refetch, no false replay assumption |
| §6.4 | Stale header and stream disconnect | Stale signal propagates, planning/approval blocked; stream backoff and polling |
| §7.1–7.6 | Run/pause/step/reset | Operator controls; audit; local history purge on reset |
| §7.7–7.8 | Six event types and filters | Zod enum/shape; UI controls; combined crisis test |
| §7.9–7.11 | Five fault types, expiry and clear | Zod validation; controls; recorded stale/recovery check |
| §7.12–7.13 | Admin audit/fault listing | Simulator client admin methods; fault panel |
| §8 | Exact world IDs, fuels, demand priors | API state drives IDs; priors attributed to organizer |
| §9 | Error envelopes and status codes | Both `detail.code` and `error.code`; no domain-4xx retries; accepts success 2xx |
| §10 | Defensive checklist | Validation, caching, retries, breaker, SSE watchdog and fresh-state dispatch checks |

The guide is internally inconsistent on idempotent success status: §5 says 201, §9 lists 200. The client accepts either and relies on returned allocation identity.
