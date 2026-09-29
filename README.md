# Fuel Supply Intelligence & Resilience Platform

BUP CSE Fest 2026 Hackathon Finals. This is a decision-support platform for a **simulated** Bangladeshi fuel network. It observes the organizer's simulator, predicts shortages, recommends constrained allocations with explanations, handles crises, and stays observable and usable when its own components fail.

> All data is simulated. The platform only talks to the BUP Fuel Supply Simulator.

**Judge review:** [requirement-by-requirement coverage](docs/08-requirements-review.md) · [AI methodology](docs/09-intelligence.md) · [evidence](docs/evidence/).

**Start here:** [docs/README.md](docs/README.md) (problem breakdown, architecture, roadmap, demo script).

## Stack
| Layer | Tech |
|---|---|
| Backend | NestJS 12 (TypeScript, ESM), TypeORM + Postgres 17, Redis 7, Zod, opossum circuit breaker, javascript-lp-solver, OpenAI Responses API + BM25 retrieval |
| Frontend | Next.js 16 (App Router) + React 19 + Tailwind CSS 4, TanStack Query, Recharts |
| Observability | prom-client → Prometheus → Grafana (provisioned dashboard), pino JSON logs, audit log |
| Delivery | Docker multi-stage images, docker-compose, GitHub Actions, k6 |

## Quick start (everything in Docker)
```bash
cp .env.example .env            # then set JWT_SECRET (and optionally GPT_API_KEY)
docker compose up -d --build
```
| URL | What |
|---|---|
| http://localhost:3000 | Operator console (sign in: operator / `OPERATOR_PASSWORD`) |
| http://localhost:4000/api/docs | API Swagger |
| http://localhost:4000/api/health | Component health |
| http://localhost:3001 | Grafana (dashboard *Fuel Ops Platform*; admin/admin) |
| http://localhost:9090 | Prometheus |
| http://localhost:8000/admin | Simulator console |

Start the simulation from **Scenario Control → run** (the simulator boots paused).

## Local development (hot reload)
Requires Node ≥ 22 and pnpm 9 (`corepack enable`).
```bash
pnpm install
pnpm infra:up                   # simulator, postgres (:5433), redis, prometheus, grafana
pnpm dev                        # api :4000 (watch) + web :3000
```
Useful: `pnpm sim:run | sim:pause | sim:step | sim:reset`, `pnpm test`, `pnpm lint`, `pnpm build`.

## Repo layout
```
apps/api/src
  simulator/   resilient client (timeout, retry, breaker, validation, cache) + SSE listener
  state/       network snapshot (REST truth, SSE hints, Redis warm start)
  ingestion/   demand + inventory history → Postgres
  forecast/    demand forecast, stockout ETA and probability
  detection/   shortage / anomaly / disruption detection → alerts
  decision/    LP optimizer + heuristic fallback, recommendations, what-if, approvals
  explain/     GenAI explanations, summaries, Q&A (template fallback)
  audit/ auth/ health/ metrics/ realtime/ chaos/
apps/web/src/app  overview, recommendations, forecast, disruptions, assistant, audit, health, control, intelligence
infra/            prometheus (+ alert rules), grafana provisioning + dashboard
loadtest/         k6 workload + results
docs/             problem breakdown, architecture, roadmap, demo, reports
```

## Configuration
Every variable is documented in [.env.example](.env.example) and validated at boot (`apps/api/src/config/env.ts`). Key ones: `JWT_SECRET`, `OPERATOR_PASSWORD`, `VIEWER_PASSWORD`, `GPT_API_KEY` (optional), `AUTO_DISPATCH` (must remain `false`; operator approval required), `MIN_CONFIDENCE_FOR_AUTO`, `RATE_LIMIT_PER_MIN`.

## Load test
```bash
curl -X POST localhost:8000/admin/run
RATE_LIMIT_PER_MIN=1000000 docker compose up -d api   # all k6 VUs share one IP
VUS=30 pnpm loadtest
```
Results: [docs/06-load-test-report.md](docs/06-load-test-report.md).

## Intelligence Lab
Open `/intelligence` for the specialist investigation trace, source evidence, model registry, rolling forecast evaluation, policy counterfactuals, recorded replay, depot runway, transport estimates and Q-learning research benchmark. The operational policy combines adaptive forecasts with constrained optimization. GPT critiques evidence and explains decisions; operator approval controls dispatch.

Configure `GPT_API_KEY` (or `OPENAI_API_KEY`) and optionally `OPENAI_MODEL` (default `gpt-4.1-mini`) in `.env`. The server calls OpenAI's Responses API with storage disabled. Provider errors return labeled deterministic fallbacks. No credential is sent to the browser.

## Review checks
```bash
pnpm test
pnpm lint
node scripts/judge-check.mjs             # advances local simulator and injects test crises/faults
pnpm --filter web exec playwright test   # browser workflow against running stack
python3 scripts/train_policy.py          # deterministic offline RL benchmark
```
See [deployment options](docs/10-deployment.md) for Helm, Terraform, GitOps, frontend canary/blue-green, autoscaling and rollback.
