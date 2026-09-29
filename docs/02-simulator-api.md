# 02 · Simulator cheat sheet

Condensed from [`source/BUP_Fuel_Supply_Simulator_Integration_Guide_Final.docx`](source/BUP_Fuel_Supply_Simulator_Integration_Guide_Final.docx). Our typed contract lives in `apps/api/src/simulator/simulator.schemas.ts`.

- Image: `asifmahmoud414/bup-fuel-supply-simulator:1.0.0`, http://localhost:8000
- Swagger: http://localhost:8000/docs
- Admin console: http://localhost:8000/admin

## Hard rules
1. The simulator is **the world, not the brain**. It only executes `POST /v1/allocations`.
2. **REST is the source of truth.** SSE (`/v1/stream`) is a hint, so always re-GET after an event. There is no replay on reconnect.
3. Deterministic: same seed + same actions + same events gives an identical world.
4. Never modify the simulator. Judges run the published image.
5. `/admin/*` and `/v1/health` bypass fault injection. Test resilience via `/v1/*` only.

## The world (fixed)
| | |
|---|---|
| Regions | `region-dhaka` (demand ×1.00), `region-chattogram` (×1.08) |
| Depots | `depot-gazipur` (Dhaka, 12,000 L/tick dispatch), `depot-patiya` (Chattogram, 11,000 L/tick) |
| Stations | `station-mirpur` (urban_high), `station-tongi` (industrial), `station-karnaphuli` (highway), `station-coxsbazar` (regional) |
| Fuels | DIESEL, PETROL, OCTANE |
| Tick | 15 simulated minutes; 8 ticks/s while RUNNING (`SIMULATION_SPEED`) |

**Routes** (depot → station, transit ticks, max L per shipment)

| Route | Transit | Max |
|---|---:|---:|
| gazipur → mirpur | 2 | 7,000 |
| gazipur → tongi | 2 | 6,500 |
| patiya → karnaphuli | 2 | 7,000 |
| patiya → coxsbazar | 3 | 6,000 |
| gazipur → karnaphuli *(cross-region)* | 4 | 5,000 |
| patiya → mirpur *(cross-region)* | 4 | 5,000 |

Tongi and Cox's Bazar each have **one** route. If it is disrupted, those stations cannot be resupplied.

**Daily demand (L/day)**: urban_high 8.5k/10.5k/5.6k · industrial 14k/4.5k/2.2k · highway 10.5k/11k/6.2k · regional 7.2k/7.6k/3.6k (D/P/O). Hour-of-day factors, for example industrial is 1.55 during 06–18 and 0.45 otherwise. These are encoded in `apps/api/src/forecast/priors.ts`.

**Supply**: 22 arrivals. 4 initial ones arrive at ticks 12–20, then top-ups every 64 ticks (about 16 h).

## Read endpoints
`/v1/health` · `/v1/instance` · `/v1/regions` · `/v1/depots[/{id}]` · `/v1/stations[/{id}]` · `/v1/routes` · `/v1/supply-arrivals` · `/v1/events` · `/v1/allocations` · `/v1/demand-history?station_id=&limit=` (1–2000, always limit it) · `/v1/metrics` (service_level = served ÷ (served + unmet))

## The only write: `POST /v1/allocations`
```json
{ "idempotency_key": "rec-<uuid>", "source_depot_id": "depot-gazipur",
  "destination_station_id": "station-mirpur", "route_id": "route-gazipur-mirpur",
  "fuel_type": "DIESEL", "quantity": 3000 }
```
Validation order (first failure wins): idempotency → `NOT_FOUND` 404 → `ROUTE_MISMATCH` → `DEPOT_CLOSED` → `STATION_CLOSED` → `ROUTE_DISRUPTED` → `ROUTE_CAPACITY_EXCEEDED` → `INSUFFICIENT_INVENTORY` → `DISPATCH_CAPACITY_EXCEEDED` → `DESTINATION_CAPACITY_EXCEEDED` (all 409).

- Same key + same body replays safely (201). Same key + different body returns `IDEMPOTENCY_KEY_MISMATCH`. Keys are never freed.
- `POST /v1/allocations/{id}/cancel` works only while PENDING and refunds the depot.
- Lifecycle: `PENDING → IN_TRANSIT → ARRIVED` (or `FAILED` if the route is disrupted at departure, or `CANCELLED`).

## SSE `/v1/stream`
Events: `simulation.tick`, `allocation.status_changed`, `inventory.updated`, `simulator.notice`. Keepalive every 15 s. The per-subscriber queue holds 200 events; if you fall behind you are dropped silently, so reconnect and refetch.

## Admin (demo / self-test)
`POST /admin/run | pause | toggle | step | reset` · `POST /admin/events` · `POST /admin/faults` · `POST /admin/faults/clear` · `GET /admin/audit?limit=` · `GET /admin/faults` · `GET /admin/events`

**Crisis events** (`{type, start_tick, duration_ticks, parameters}`; empty id list = all):

| Type | Params | Effect |
|---|---|---|
| `demand_spike` | multiplier (1.5), station_ids, region_ids | multiplies demand_multiplier |
| `route_disruption` | route_ids | route → DISRUPTED |
| `station_outage` | station_ids | station → OUTAGE (serves 0) |
| `depot_constraint` | depot_ids | depot → CONSTRAINED |
| `shipment_delay` | delay_ticks (2), depot_ids, fuel_types | supply planned_tick += delay (one-shot) |
| `supply_shortfall` | factor (0.5), depot_ids, fuel_types | supply quantity ×= factor (one-shot) |

**Faults** (`{type, duration_seconds ≤ 3600, parameters}`, affect `/v1/*` only):

| Type | Effect |
|---|---|
| `latency` | +delay_ms (500) per request |
| `unavailable` | 503 `{"error":{"code":"FAULT_INJECTED"}}` |
| `error_rate` | 503 with probability `rate` (0.25) |
| `stale_data` | header `X-Simulator-Stale: true` on GETs |
| `stream_disconnect` | `/v1/stream` returns 503 `{"detail":{...}}` |

Error envelopes differ: domain errors use `{"detail":{"code"}}`, faults use `{"error":{"code"}}`, and Pydantic uses `{"detail":[...]}`. `extractCode()` in `simulator.errors.ts` handles all three.

## Observed quirks
- `sim_time` comes back **without a timezone** (`2026-01-01T00:00:00`). Treat it as UTC (`parseSimTime()`).
