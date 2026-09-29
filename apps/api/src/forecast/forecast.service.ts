import { ensembleForecast } from './ensemble.js';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { FUEL_TYPES, FuelType, parseSimTime } from '../simulator/simulator.schemas.js';
import { IngestionService } from '../ingestion/ingestion.service.js';
import { MetricsService } from '../metrics/metrics.service.js';
import type { NetworkSnapshot } from '../state/state.types.js';
import { Forecast, StockoutAssessment, assessStockout } from './forecast.math.js';

export const HORIZON_TICKS = 24; // 6 simulated hours at 15-min ticks

export interface RiskItem {
  stationId: string;
  stationName: string;
  regionId: string;
  fuel: FuelType;
  inventory: number;
  capacity: number;
  inTransit: number;
  arrivals: Map<number, number>;
  forecast: Forecast;
  assessment: StockoutAssessment;
  stationOpen: boolean;
}

/**
 * Prediction service: demand forecast + stockout ETA/probability per station×fuel.
 * `available=false` simulates the ML model being down (chaos) — the decision engine
 * must then fall back (problem statement §11).
 */
@Injectable()
export class ForecastService {
  private readonly log = new Logger(ForecastService.name);
  available = true;
  lastRunAt: Date | null = null;
  lastError: string | null = null;
  private lastOneStep = new Map<string, { tick: number; value: number }>();
  /** Risk only changes when the world changes: memoise per (tick, allocation ledger). */
  private cache: { key: string; result: Promise<RiskItem[]> } | null = null;

  constructor(
    private readonly ingestion: IngestionService,
    private readonly metrics: MetricsService,
  ) {}

  @OnEvent('sim.reset')
  onReset() {
    this.cache = null;
    this.lastOneStep.clear();
  }

  @OnEvent('history.updated')
  onHistory() { this.cache = null; }

  async assess(s: NetworkSnapshot): Promise<RiskItem[]> {
    if (!this.available) {
      this.lastError = 'prediction model disabled (chaos)';
      throw new Error(this.lastError);
    }
    this.lastError = null;
    const key = `${s.instance.tick}|${s.allocations.map((a) => `${a.id}:${a.status}`).join(',')}|${s.stations.map((x) => x.status + x.demand_multiplier).join(',')}`;
    if (this.cache?.key !== key) {
      // single-flight: concurrent callers share one computation
      const result = this.compute(s);
      this.cache = { key, result };
      result.catch((e: Error) => {
        this.lastError = e.message;
        if (this.cache?.result === result) this.cache = null;
      });
    }
    return this.cache.result;
  }

  private async compute(s: NetworkSnapshot): Promise<RiskItem[]> {
    const tick = s.instance.tick;
    const tickMinutes = s.instance.tick_minutes;
    const nextTime = new Date(parseSimTime(s.instance.sim_time).getTime() + tickMinutes * 60_000);
    const regionFactor = new Map(s.regions.map((r) => [r.id, r.demand_factor]));

    const items: RiskItem[] = [];
    const confidences: number[] = [];
    for (const st of s.stations) {
      for (const fuel of FUEL_TYPES) {
        const history = (await this.ingestion.history(st.id, fuel)).map((h) => ({
          tick: h.tick,
          simTime: h.simTime,
          demand: h.demand,
        }));
        this.trackError(st.id, fuel, history);

        const forecast = ensembleForecast(
          {
            profile: st.demand_profile,
            fuel,
            regionFactor: regionFactor.get(st.region_id) ?? 1,
            demandMultiplier: st.demand_multiplier,
            tickMinutes,
            startTime: nextTime,
            history,
          },
          HORIZON_TICKS,
        );
        this.lastOneStep.set(`${st.id}:${fuel}`, { tick: tick + 1, value: forecast.perTick[0] ?? 0 });

        const arrivals = new Map<number, number>();
        let inTransit = 0;
        for (const a of s.allocations) {
          if (a.destination_station_id !== st.id || a.fuel_type !== fuel) continue;
          if (a.status !== 'PENDING' && a.status !== 'IN_TRANSIT') continue;
          const route = s.routes.find((r) => r.id === a.route_id);
          const eta = a.expected_arrival_tick ?? tick + 1 + (route?.transit_ticks ?? 2);
          const k = Math.max(1, eta - tick);
          arrivals.set(k, (arrivals.get(k) ?? 0) + a.quantity);
          inTransit += a.quantity;
        }

        const assessment = assessStockout(st.inventory[fuel], forecast, arrivals, tickMinutes);
        confidences.push(forecast.confidence);
        items.push({
          stationId: st.id,
          stationName: st.name,
          regionId: st.region_id,
          fuel,
          inventory: st.inventory[fuel],
          capacity: st.capacity[fuel],
          inTransit,
          arrivals,
          forecast,
          assessment,
          stationOpen: st.status === 'OPEN',
        });
      }
    }
    this.metrics.predictionConfidence.set(confidences.reduce((a, b) => a + b, 0) / Math.max(1, confidences.length));
    this.lastRunAt = new Date();
    this.lastError = null;
    return items;
  }

  /** Prediction error metric: compare last 1-step-ahead forecast against the realised demand. */
  private trackError(stationId: string, fuel: FuelType, history: { tick: number; demand: number }[]) {
    const prev = this.lastOneStep.get(`${stationId}:${fuel}`);
    if (!prev) return;
    const actual = history.find((h) => h.tick === prev.tick);
    if (actual) this.metrics.forecastAbsError.observe({ fuel_type: fuel }, Math.abs(actual.demand - prev.value));
  }
}
