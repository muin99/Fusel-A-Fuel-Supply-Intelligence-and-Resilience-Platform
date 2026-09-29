# 07 · Assumptions, data and guardrails

## Data sources
| Data | Source | Notes |
|---|---|---|
| World state, demand history, supply, events | BUP simulator REST/SSE | the only operational data source |
| Demand priors (daily volume, hour-of-day factors, noise) | integration guide §8.5–8.6 | used for cold start and as the seasonal shape (`forecast/priors.ts`); **derived data** |
| Demand history copy | our Postgres `demand_records` | ingested each tick (the simulator only serves 2000 rows at a time) |
| Inventory history | our Postgres `inventory_snapshots` | for anomaly detection and replay |

No external or real-world fuel data is used.

## Modelling assumptions
- `sim_time` without a timezone is UTC.
- Station demand = prior(profile, fuel, hour) × region factor × learned level. The level (EWMA of actual ÷ prior) absorbs demand spikes, so the live `demand_multiplier` is not applied twice.
- Stockout probability uses a normal approximation of cumulative demand with a coefficient of variation learned from history (or 2× the documented noise at cold start).
- Allocations depart the tick after creation; the arrival tick = departure + route transit.
- Depot dispatch capacity used this tick = PENDING shipments + IN_TRANSIT shipments that departed this tick (conservative reading of the guide).
- A CONSTRAINED depot is treated as having 50% dispatch capacity. The simulator only *signals* the constraint, so this is our policy choice.
- 5% of each depot's capacity is held back as a strategic reserve.
- Decisions are not made on stale or degraded data.
- History is **per simulation run**. A reset (tick going backwards, the simulator's reset notice, or stored history ahead of the simulator at boot) clears demand/inventory history, forecast caches and active detections, and expires open recommendations.
- Decisions are recomputed only when the world changes (tick, allocation ledger, route/station/depot status, prediction availability, forced policy). Open recommendations for the same station, fuel and route are updated in place so their IDs stay stable while an operator is inspecting them.

## Guardrails (§24)
- Operates only against the simulator container; there is no code path to any real system.
- "Simulated" appears in the UI footer on every page and in the GenAI system prompt.
- Human review by default (`AUTO_DISPATCH=false`); low-confidence recommendations are `NEEDS_REVIEW`.
- Secrets live in `.env` only (git-ignored); `.env.example` documents every variable.

## Intelligence upgrade

The current model is `adaptive-ensemble-2.0.0`; see [09-intelligence.md](09-intelligence.md) for exact evaluation and uncertainty limits. Document retrieval uses only the two organizer files, bundled as line-referenced chunks. GPT uses the server-side configured key and is advisory. RL uses a clearly separate approximate inventory environment, fixed seeds and a held-out heuristic comparison; it is not deployed for dispatch. Model-registry and replay endpoints expose these boundaries directly.

Station inventory anomaly detection reconciles observed new arrivals and estimated demand across at most one tick, with a 15%-capacity threshold. It can generate false positives when projections or REST reads are inconsistent; operators should investigate the simulator ledger before acting. Depot runway splits expected burden across available depot connections and is not an optimization solution. Transport ETA uses historical actual-versus-expected arrival differences; nominal ETA is used when no completed samples exist.
