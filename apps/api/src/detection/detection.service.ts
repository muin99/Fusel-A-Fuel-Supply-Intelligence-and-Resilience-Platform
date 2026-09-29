import { Injectable } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import type { RiskItem } from '../forecast/forecast.service.js';
import { networkRunway } from '../forecast/runway.js';
import { MetricsService } from '../metrics/metrics.service.js';
import type { NetworkSnapshot } from '../state/state.types.js';
import { depotSupplyRisk } from '../intelligence/supply-risk.js';

export interface Detection {
  key: string;
  kind: 'shortage' | 'anomaly' | 'disruption';
  severity: 'info' | 'warning' | 'critical';
  entityId: string;
  message: string;
  data?: Record<string, unknown>;
}

/** Level ratio above which demand is anomalous vs the seasonal prior. */
export const SURGE_RATIO = 1.35;

/** Pure detection over one snapshot + risk table. */
export function detect(s: NetworkSnapshot, risk: RiskItem[] | null): Detection[] {
  const out: Detection[] = [];
  for (const r of s.routes)
    if (r.status !== 'AVAILABLE')
      out.push({ key: `route:${r.id}`, kind: 'disruption', severity: 'warning', entityId: r.id, message: `Route ${r.id} is ${r.status}` });
  for (const st of s.stations)
    if (st.status !== 'OPEN')
      out.push({ key: `station:${st.id}`, kind: 'disruption', severity: 'critical', entityId: st.id, message: `${st.name} is in ${st.status}` });
  for (const d of s.depots)
    if (d.status !== 'OPEN')
      out.push({ key: `depot:${d.id}`, kind: 'disruption', severity: 'warning', entityId: d.id, message: `${d.name} is ${d.status}` });
  for (const a of s.supplyArrivals)
    if (a.status === 'DELAYED')
      out.push({
        key: `supply:${a.id}`,
        kind: 'disruption',
        severity: 'warning',
        entityId: a.depot_id,
        message: `Supply ${a.id} (${a.quantity} L ${a.fuel_type}) to ${a.depot_id} delayed to tick ${a.planned_tick}`,
      });

  if (risk) {
    for (const d of depotSupplyRisk(s, risk)) if (d.shortageTick !== null) {
      out.push({ key: `depot-runway:${d.depotId}:${d.fuel}`, kind: 'shortage', severity: 'warning', entityId: d.depotId,
        message: `${d.depotId} ${d.fuel}: projected replenishment burden exceeds available supply by tick ${d.shortageTick}; ${d.delayedArrivals.length} delayed arrivals`, data: d });
    }
    const surgeByRegion = new Map<string, number>();
    for (const r of risk) {
      if ((r.forecast as { drift?: boolean }).drift) out.push({ key: `drift:${r.stationId}:${r.fuel}`, kind: 'anomaly', severity: 'warning', entityId: r.stationId, message: `Demand distribution drift at ${r.stationName} ${r.fuel}; uncertainty widened and human review required` });
      const p = r.assessment.probability;
      const h = r.assessment.hoursToStockout;
      if (r.stationOpen && (p >= 0.5 || (h !== null && h <= 3))) {
        const severity = p >= 0.8 || (h !== null && h <= 1.5) ? 'critical' : 'warning';
        out.push({
          key: `shortage:${r.stationId}:${r.fuel}:${severity}`,
          kind: 'shortage',
          severity,
          entityId: r.stationId,
          message: `${r.stationName} ${r.fuel}: stockout risk ${(p * 100).toFixed(0)}%${h !== null ? `, ETA ${h.toFixed(1)} h` : ''}`,
          data: { probability: p, hoursToStockout: h, inventory: r.inventory },
        });
      }
      if (r.forecast.samples >= 8 && r.forecast.level >= SURGE_RATIO) {
        out.push({
          key: `anomaly:demand:${r.stationId}:${r.fuel}`,
          kind: 'anomaly',
          severity: 'warning',
          entityId: r.stationId,
          message: `Anomalous demand at ${r.stationName} ${r.fuel}: ${r.forecast.level.toFixed(2)}× expected`,
          data: { level: r.forecast.level },
        });
        surgeByRegion.set(r.regionId, (surgeByRegion.get(r.regionId) ?? 0) + 1);
      }
    }
    for (const [region, n] of surgeByRegion) {
      const total = risk.filter((r) => r.regionId === region).length;
      if (n / total >= 0.5)
        out.push({
          key: `anomaly:region:${region}`,
          kind: 'anomaly',
          severity: 'critical',
          entityId: region,
          message: `Emerging regional demand surge in ${region} (${n}/${total} station-fuels elevated)`,
        });
    }
  }
  if (risk) {
    const runway = networkRunway(s, risk);
    for (const f of runway.fuels) {
      if (f.hoursOfCover === null || f.hoursOfCover > 48) continue;
      const severity = f.hoursOfCover <= 12 ? 'critical' : 'warning';
      out.push({
        key: `runway:${f.fuel}:${severity}`,
        kind: 'shortage',
        severity,
        entityId: `network-${f.fuel}`,
        message: `Network ${f.fuel} runs dry in ~${Math.round(f.hoursOfCover)} h (tick ${f.exhaustionTick}): ${Math.round(f.onHandLiters).toLocaleString()} L left${f.scheduledSupplyLiters ? ` + ${f.scheduledSupplyLiters.toLocaleString()} L scheduled` : ', no further supply scheduled'}. Allocation can only ration, not prevent, this shortfall.`,
        data: { ...f },
      });
    }
  }
  return out;
}

/** Raises alerts only on NEW detections (edge-triggered) and logs recoveries. */
@Injectable()
export class DetectionService {
  private active = new Map<string, Detection>();
  private previous: NetworkSnapshot | null = null;
  current: Detection[] = [];

  constructor(
    private readonly events: EventEmitter2,
    private readonly metrics: MetricsService,
  ) {}

  @OnEvent('sim.reset')
  onReset() {
    this.active.clear();
    this.current = [];
    this.previous = null;
  }

  evaluate(s: NetworkSnapshot, risk: RiskItem[] | null) {
    const found = detect(s, risk);
    if (this.previous && !s.meta.stale && s.instance.tick - this.previous.instance.tick <= 1 && s.instance.tick >= this.previous.instance.tick) {
      const prev = this.previous;
      for (const station of s.stations) for (const fuel of ['DIESEL', 'PETROL', 'OCTANE'] as const) {
        const before = prev.stations.find((x) => x.id === station.id);
        if (!before) continue;
        const arrivals = s.allocations.filter((a) => a.destination_station_id === station.id && a.fuel_type === fuel && a.status === 'ARRIVED' && !prev.allocations.some((p) => p.id === a.id && p.status === 'ARRIVED')).reduce((v, a) => v + a.quantity, 0);
        const demand = station.status === 'OPEN' ? (risk?.find((r) => r.stationId === station.id && r.fuel === fuel)?.forecast.perTick[0] ?? 0) * (s.instance.tick - prev.instance.tick) : 0;
        const residual = station.inventory[fuel] - Math.min(station.capacity[fuel], before.inventory[fuel] + arrivals) + demand;
        if (Math.abs(residual) > station.capacity[fuel] * 0.15) found.push({ key: `inventory:${station.id}:${fuel}`, kind: 'anomaly', severity: 'warning', entityId: station.id,
          message: `Unexplained inventory change at ${station.name} ${fuel}: residual ${Math.round(residual)} L after arrivals and expected demand`, data: { residual, estimatedDemand: demand } });
      }
    }
    if (!s.meta.stale) this.previous = s;
    for (const station of s.stations) if (station.status === 'OPEN' && !s.routes.some((r) => r.destination_station_id === station.id && r.status === 'AVAILABLE')) found.push({ key: `bottleneck:${station.id}`, kind: 'disruption', severity: 'critical', entityId: station.id, message: `${station.name}: no available replenishment route` });
    const next = new Map(found.map((d) => [d.key, d]));
    for (const [key, d] of next) {
      if (this.active.has(key)) continue;
      if (d.kind === 'shortage') this.metrics.shortageAlerts.inc({ severity: d.severity });
      if (d.kind === 'anomaly') this.metrics.anomalies.inc({ kind: key.split(':')[1] });
      this.events.emit(`alert.${d.kind}`, { ...d, kind: d.kind });
    }
    for (const [key, d] of this.active) {
      if (!next.has(key))
        this.events.emit('alert.recovery', { kind: 'recovery', severity: 'info', entityId: d.entityId, message: `Recovered: ${d.message}` });
    }
    this.active = next;
    this.current = found;
    return found;
  }
}
