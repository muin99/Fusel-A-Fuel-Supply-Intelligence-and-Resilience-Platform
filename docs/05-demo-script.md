# 05 · Demo script (follows §22 of the brief)

Prep: `docker compose up -d --build`, open http://localhost:3000, sign in as **operator**. In a second tab open Grafana http://localhost:3001 (dashboard *Fuel Ops Platform*).
Reset between rehearsals with Control → Simulation → `reset`.

| # | Story beat (§22) | Do this | Point at |
|---|---|---|---|
| 1 | Normal operations | Control → `run` | Overview: service level ~100%, inventories falling with the hour-of-day pattern |
| 2 | Operator dashboard | Walk Overview → Risk & Forecast | stations, depots, top risks, System Health all green |
| 3 | Demand starts increasing | Control → *Demand spike — Dhaka ×1.8* | Mirpur/Tongi multiplier changes on the Overview |
| 4 | System detects risk | wait ~10 s | Alerts: anomalous demand, "Emerging regional demand surge"; Risk table "demand vs normal ×1.8" |
| 5 | Intelligence predicts shortage | Risk & Forecast | P(stockout) rising, ETA in hours |
| 6 | Recommendation generated | Recommendations | new items, policy `lp_optimizer` |
| 7 | Operator inspects | click one | why, signals, constraints, alternatives, risk before → after, confidence; *Explain with AI* |
| 8 | Allocation is simulated | What-if with a different quantity, then **Approve & dispatch** | status SUBMITTED, Disruptions → shipments in flight, Decision History entry |
| 9 | Crisis event occurs | Control → *Route disruption — Gazipur→Mirpur* (+ *Depot constraint — Patiya* for a combined crisis) | route DISRUPTED; new recommendations use `route-patiya-mirpur`; constraints listed |
| 10 | System adapts | Recommendations | alternative route chosen, dispatch budget halved in rationale |
| 11 | Failure injected | Control → *Unavailable (503)* | |
| 12 | Monitoring detects failure | System Health + Grafana | Simulator **down**, circuit OPEN, degraded banner, decisions paused, UI still shows last-known state |
| 13 | Fallback / recovery | wait 45 s (fault expires) or *Clear all faults* | breaker half-open → closed, banner clears, "Recovered" alerts |
| 14 | ML failure (bonus) | *Take prediction model down* | policy `heuristic_fallback`, system alert, `decision_fallback_total` in Grafana; then *Restore* |
| 15 | Performance | show `docs/06-load-test-report.md` | p95 / throughput / error rate, and the optimisation we made |

Talking points: simulated data only; human-in-the-loop by default; every action is audited; each fallback is deliberate and visible.

## Intelligence Lab extension (3 minutes)

1. Open **Intelligence Lab** and explain the registered ensemble version, cold-start confidence and drift rule.
2. Sign in as operator. **Run model evaluation**; expand its persisted experiment record to show sample counts, MAEs and learned weights.
3. **Compare policies under stress**; compare no-action, heuristic and LP across mean demand, 1.5× demand and proposed-shipment delay. Explicitly call these projections.
4. Investigate: “How should we respond to the demand spike, blocked route and delayed depot supply?” Expand the researcher, forecast, LP, deterministic constraint reviewer and independent GPT critique traces. Show document source IDs.
5. Show regional demand, depot supply runway and transport ETA/sample counts.
6. Show the offline RL comparison. Both policies achieved 100% service on the surrogate test; Q-learning reduced shipment volume by about 2.7%. Explain that the official-simulator operational policy remains ML + constrained LP.
7. Open **Risk & Forecast** to show mean and empirical uncertainty bounds. Open a recommendation to inspect constraints and what-if warnings before approving.

## Reproduce evidence

`node scripts/judge-check.mjs` uses `.env` only for the local operator login, pauses/steps the simulator and injects combined domain/fault scenarios. It saves pre-check state and outcome evidence under `docs/evidence`; it does not reset the official simulator. Run it only on the local judging simulation. `pnpm test:e2e` checks browser navigation and evaluation/what-if flows and saves screenshots. A real judge-supervised presentation is still delivered by the team.
