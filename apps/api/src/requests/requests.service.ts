import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import type { JwtUser } from '../auth/auth.guard.js';
import { FuelRequest, type RequestUrgency } from '../common/entities.js';
import { blockingReasons } from '../decision/feasibility.js';
import { buildProblem } from '../decision/policies.js';
import { ForecastService } from '../forecast/forecast.service.js';
import { SimulatorError } from '../simulator/simulator.errors.js';
import { SimulatorClient } from '../simulator/simulator.client.js';
import type { NetworkSnapshot } from '../state/state.types.js';
import { StateService } from '../state/state.service.js';

const ACTIVE: FuelRequest['status'][] = ['OPEN', 'PLANNED'];

export interface RequestSignal {
  stationId: string;
  fuel: string;
  quantity: number;
  urgency: RequestUrgency;
  requestId: number;
}

/** Depots that can currently reach a station (any route, even if disrupted). */
function servingDepots(s: NetworkSnapshot, stationId: string): string[] {
  return [...new Set(s.routes.filter((r) => r.destination_station_id === stationId).map((r) => r.source_depot_id))];
}

/**
 * Station fuel requests.
 *  station manager → raises / cancels requests for their station
 *  depot manager   → accepts (dispatches from their depot) or rejects requests for stations they serve
 *  operator        → sees everything and can override either way (system owner)
 * Open requests also raise optimizer priority for needs the model already sees.
 */
@Injectable()
export class RequestsService {
  constructor(
    @InjectRepository(FuelRequest) private readonly repo: Repository<FuelRequest>,
    private readonly state: StateService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
    private readonly sim: SimulatorClient,
    private readonly forecast: ForecastService,
  ) {}

  async create(user: JwtUser, body: { stationId?: string; fuel: string; quantity: number; urgency: RequestUrgency; note?: string }) {
    const stationId = user.role === 'station' ? user.stationId : body.stationId;
    if (!stationId) throw new BadRequestException('stationId is required');
    if (user.role === 'station' && body.stationId && body.stationId !== user.stationId) throw new ForbiddenException('Station managers can only request fuel for their own station');
    const s = await this.state.get();
    const station = s?.stations.find((x) => x.id === stationId);
    if (!s || !station) throw new NotFoundException('Unknown station');
    const cap = station.capacity[body.fuel as 'DIESEL'];
    if (body.quantity > cap) throw new BadRequestException(`Requested ${body.quantity} L exceeds the ${cap} L tank capacity for ${body.fuel}`);
    const dup = await this.repo.findOne({ where: { stationId, fuelType: body.fuel, status: In(ACTIVE) } });
    if (dup) throw new ConflictException(`Request #${dup.id} for ${body.fuel} is already ${dup.status}; cancel it or wait for delivery`);
    const saved = await this.repo.save(
      this.repo.create({ tick: s.instance.tick, stationId, fuelType: body.fuel, quantity: body.quantity, urgency: body.urgency, note: body.note ?? null, requestedBy: user.sub, status: 'OPEN' }),
    );
    await this.audit.record(user.sub, 'request.created', String(saved.id), { stationId, fuel: body.fuel, quantity: body.quantity, urgency: body.urgency });
    this.events.emit('alert.request', {
      kind: 'request',
      severity: body.urgency === 'emergency' ? 'critical' : body.urgency === 'urgent' ? 'warning' : 'info',
      entityId: stationId,
      message: `${station.name} requests ${body.quantity.toLocaleString()} L ${body.fuel} (${body.urgency}), awaiting depot manager (${servingDepots(s, stationId).join(' / ')})${body.note ? `: ${body.note}` : ''}`,
    });
    void this.state.refresh();
    return saved;
  }

  /** Requests visible to this user, each with the model's view to support the decision. */
  async list(user: JwtUser | null, limit = 100) {
    const s = this.state.current();
    let rows = await this.repo.find({ order: { id: 'DESC' }, take: Math.min(limit, 300) });
    if (user?.role === 'station') rows = rows.filter((r) => r.stationId === user.stationId);
    if (user?.role === 'depot' && s) rows = rows.filter((r) => servingDepots(s, r.stationId).includes(user.depotId!));
    const risk = s && this.forecast.available ? await this.forecast.assess(s).catch(() => null) : null;
    return rows.map((r) => {
      const item = risk?.find((x) => x.stationId === r.stationId && x.fuel === r.fuelType);
      const station = s?.stations.find((x) => x.id === r.stationId);
      return {
        ...r,
        servingDepots: s ? servingDepots(s, r.stationId) : [],
        routes: s?.routes.filter((x) => x.destination_station_id === r.stationId).map((x) => ({ id: x.id, depotId: x.source_depot_id, status: x.status, transitTicks: x.transit_ticks, maxShipment: x.max_shipment })) ?? [],
        modelView: item
          ? {
              stockoutProbability: item.assessment.probability,
              hoursToStockout: item.assessment.hoursToStockout,
              inventory: item.inventory,
              inTransit: item.inTransit,
              capacity: item.capacity,
              agrees: item.assessment.probability >= 0.3 || item.inventory + item.inTransit < item.capacity * 0.4,
            }
          : station
            ? { stockoutProbability: null, hoursToStockout: null, inventory: station.inventory[r.fuelType as 'DIESEL'], inTransit: 0, capacity: station.capacity[r.fuelType as 'DIESEL'], agrees: null }
            : null,
      };
    });
  }

  async cancel(id: number, user: JwtUser) {
    const r = await this.find(id);
    if (user.role === 'station' && r.stationId !== user.stationId) throw new ForbiddenException();
    if (r.status !== 'OPEN') throw new ConflictException(`Request is ${r.status}; only OPEN requests can be cancelled`);
    await this.close(r, 'CANCELLED', `Cancelled by ${user.sub}`);
    await this.audit.record(user.sub, 'request.cancelled', String(id));
    return r;
  }

  async decline(id: number, user: JwtUser, reason: string) {
    const r = await this.find(id);
    const s = this.state.current();
    if (user.role === 'depot' && s && !servingDepots(s, r.stationId).includes(user.depotId!)) throw new ForbiddenException('Your depot does not serve this station');
    if (r.status !== 'OPEN') throw new ConflictException(`Request is ${r.status}`);
    await this.close(r, 'DECLINED', `${user.role === 'depot' ? `${user.depotId} manager` : user.sub}: ${reason}`);
    await this.audit.record(user.sub, 'request.declined', String(id), { reason, role: user.role });
    this.events.emit('alert.request', { kind: 'request', severity: 'info', entityId: r.stationId, message: `Request #${id} (${r.fuelType}) declined: ${reason}` });
    return r;
  }

  /**
   * Accept = dispatch from the depot manager's depot (operators may pick any serving depot).
   * Same hard feasibility gate as operator approvals; idempotency key `req-<id>`.
   */
  async accept(id: number, user: JwtUser, body: { routeId?: string; quantity?: number }) {
    const r = await this.find(id);
    if (r.status !== 'OPEN') throw new ConflictException(`Request is ${r.status}`);
    const s = await this.state.refresh();
    if (!s) throw new ConflictException('Simulator state unavailable; try again shortly');
    const candidates = s.routes
      .filter((x) => x.destination_station_id === r.stationId && (user.role !== 'depot' || x.source_depot_id === user.depotId))
      .sort((a, b) => a.transit_ticks - b.transit_ticks);
    if (user.role === 'depot' && !candidates.length) throw new ForbiddenException('Your depot does not serve this station');
    const route = body.routeId ? candidates.find((x) => x.id === body.routeId) : (candidates.find((x) => x.status === 'AVAILABLE') ?? candidates[0]);
    if (!route) throw new BadRequestException('No route from your depot to this station');
    const quantity = Math.min(body.quantity ?? r.quantity, route.max_shipment);
    const blocked = blockingReasons(
      { stationId: r.stationId, fuelType: r.fuelType, depotId: route.source_depot_id, routeId: route.id, quantity, tick: s.instance.tick },
      s,
      buildProblem(s, null),
    );
    if (blocked.length) throw new ConflictException({ message: `Cannot dispatch: ${blocked.join('; ')}`, reasons: blocked });
    try {
      const alloc = await this.sim.createAllocation({
        idempotency_key: `req-${r.id}-${route.id}-${quantity}`,
        source_depot_id: route.source_depot_id,
        destination_station_id: r.stationId,
        route_id: route.id,
        fuel_type: r.fuelType as 'DIESEL',
        quantity,
      });
      r.status = 'PLANNED';
      r.allocationId = alloc.id;
      r.resolution = `Accepted by ${user.role === 'depot' ? `${user.depotId} manager` : user.sub}: ${quantity.toLocaleString()} L via ${route.id} (allocation #${alloc.id})${quantity < r.quantity ? `, capped by the ${route.max_shipment} L route limit` : ''}`;
      await this.repo.save(r);
      await this.audit.record(user.sub, 'request.accepted', String(id), { allocationId: alloc.id, routeId: route.id, quantity, role: user.role });
      this.events.emit('alert.request', { kind: 'request', severity: 'info', entityId: r.stationId, message: `Request #${id} accepted: ${quantity.toLocaleString()} L ${r.fuelType} dispatched via ${route.id}` });
      void this.state.refresh();
      return r;
    } catch (e) {
      const code = e instanceof SimulatorError ? e.code : (e as Error).message;
      await this.audit.record(user.sub, 'request.dispatch_failed', String(id), { error: code });
      throw new ConflictException(`Simulator rejected the dispatch: ${code}`);
    }
  }

  /** Active requests the optimizer should prioritise. */
  async signals(): Promise<RequestSignal[]> {
    const open = await this.repo.find({ where: { status: 'OPEN' } });
    return open.map((r) => ({ stationId: r.stationId, fuel: r.fuelType, quantity: r.quantity, urgency: r.urgency, requestId: r.id }));
  }

  /** PLANNED requests close when their shipment arrives, reopen if it fails. */
  async sync(s: NetworkSnapshot) {
    const planned = await this.repo.find({ where: { status: 'PLANNED' } });
    for (const r of planned) {
      const a = s.allocations.find((x) => x.id === r.allocationId);
      if (a?.status === 'ARRIVED') await this.close(r, 'FULFILLED', `Delivered ${a.quantity.toLocaleString()} L at tick ${a.actual_arrival_tick}`, s.instance.tick);
      else if (a && (a.status === 'FAILED' || a.status === 'CANCELLED')) {
        r.status = 'OPEN';
        r.resolution = `Shipment ${a.status.toLowerCase()} (${a.failure_reason ?? 'no reason'}); awaiting a new decision`;
        await this.repo.save(r);
      }
    }
  }

  private async find(id: number) {
    const r = await this.repo.findOneBy({ id });
    if (!r) throw new NotFoundException('Request not found');
    return r;
  }

  private async close(r: FuelRequest, status: FuelRequest['status'], resolution: string, tick?: number) {
    r.status = status;
    r.resolution = resolution;
    r.resolvedTick = tick ?? this.state.current()?.instance.tick ?? null;
    await this.repo.save(r);
  }
}
