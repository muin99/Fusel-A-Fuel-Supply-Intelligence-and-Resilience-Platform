# 06 · Load-test report

**Tool:** k6 (`loadtest/k6-api.js`, run with `pnpm loadtest`, summaries in `loadtest/results/`)
**Target:** API in docker-compose on a laptop (Colima, 4 vCPU / 6 GB), with the simulator **RUNNING** (8 ticks/s), so ingestion and the decision pipeline were active during the test.

## Workload
Ramping VUs 1 → 15 → 30 → 30 → 0 over 2.5 min. Each VU loops with no think time (this is a capacity test):

| Share | Path | Why |
|---:|---|---|
| 60% | `GET /network` + `/forecast/risk` + `/alerts` (batched) | dashboard read path |
| 25% | `GET /recommendations` | decision read path |
| 15% | `POST /decisions/what-if` | runs the forecast and stockout model |

Thresholds: error rate < 1%, p95 < 300 ms, p99 < 800 ms, what-if p95 < 500 ms.

## Results (30 VUs)
| Run | Throughput | Error rate | avg | p50 | p95 | p99 | Risk p95 | What-if p95 | Thresholds |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1 · baseline | 196.9 req/s | 0.00% | 121.8 ms | 36.7 ms | 588.3 ms | 737.2 ms | 677.9 ms | 686.6 ms | ❌ p95 |
| 2 · memoised risk | **736.4 req/s** | 0.00% | 48.5 ms | 43.9 ms | **106.9 ms** | 149.4 ms | 80.1 ms | 71.7 ms | ✅ all |

API container during run 2: about 450 MB RSS. Postgres and the simulator stayed well below one core.

## What we learned
1. **Bottleneck:** every `/forecast/risk` and what-if call recomputed the whole risk table: 12 history queries against a demand table that grows every tick, plus the model. Cost grew with run length and concurrency.
2. **Fix:** risk only changes when the world changes, so it is memoised per *(tick, allocation ledger, station status)*, with single-flight so concurrent callers share one computation (`ForecastService.assess`). The result was **3.7× throughput and 5.5× lower p95**, with no loss of freshness.
3. **Rate limiting works:** an earlier run with the default per-IP limit returned 97.8% HTTP 429, because all VUs share one IP. The limit is now configurable (`RATE_LIMIT_PER_MIN`) and raised only for load tests.
4. **Next limits to probe:** VUs beyond 100, the what-if path once the multi-period LP lands, and Postgres growth of `demand_records` over long runs (add an index on `(stationId, fuelType, tick)` and retention).

## Latest judge-ready smoke run (10 VUs)

The final verification run used 10 VUs for 2.5 minutes with `RATE_LIMIT_PER_MIN=1000000` so the shared local load-test IP did not exercise the application throttle. It completed **84,300 requests at 570.8 req/s with 0.00% HTTP failures**. Overall latency was 20.6 ms average, 44.9 ms p95, and 78.2 ms p99; risk p95 was 37.0 ms and what-if p95 was 34.4 ms. All k6 thresholds passed. The raw summary is `loadtest/results/k6-summary-2026-09-29T05-56-27-236Z.json`.

The earlier default-throttle run remains useful as a protection check: it produced HTTP 429 responses once the per-IP budget was exhausted. Production should retain a bounded `RATE_LIMIT_PER_MIN`; the raised value is only for this local benchmark.

Reproduce:
```bash
curl -X POST localhost:8000/admin/run
RATE_LIMIT_PER_MIN=1000000 docker compose up -d api
VUS=30 pnpm loadtest
docker stats --no-stream
```
