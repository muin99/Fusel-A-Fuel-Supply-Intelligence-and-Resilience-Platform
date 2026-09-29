import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import { FuelRequest, type RequestUrgency } from '../common/entities.js';
import type { JwtUser } from '../auth/auth.guard.js';
import type { NetworkSnapshot } from '../state/state.types.js';
import { StateService } from '../state/state.service.js';

const ACTIVE: FuelRequest['status'][] = ['OPEN', 'PLANNED'];
/** Priority boost the optimizer applies to a station request, by urgency. */
export const URGENCY_WEIGHT: Record<RequestUrgency, number> = { routine: 1, urgent: 3, emergency: 6 };

export interface RequestSignal {
  stationId: string;
  fuel: string;
  quantity: number;
  urgency: RequestUrgency;
  requestId: number;
}

@Injectable()
export class RequestsService {
  constructor(
    @InjectRepository(FuelRequest) private readonly repo: Repository<FuelRequest>,
    private readonly state: StateService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
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
    if (dup) throw new ConflictException(`Request #${dup.id} for ${body.fuel} is already ${dup.status}; cancel it or wait`);
    const saved = await this.repo.save(
      this.repo.create({ tick: s.instance.tick, stationId, fuelType: body.fuel, quantity: body.quantity, urgency: body.urgency, note: body.note ?? null, requestedBy: user.sub, status: 'OPEN' }),
    );
    await this.audit.record(user.sub, 'request.created', String(saved.id), { stationId, fuel: body.fuel, quantity: body.quantity, urgency: body.urgency });
    this.events.emit('alert.request', {
      kind: 'request',
      severity: body.urgency === 'emergency' ? 'critical' : body.urgency === 'urgent' ? 'warning' : 'info',
      entityId: stationId,
      message: `${station.name} requests ${body.quantity.toLocaleString()} L ${body.fuel} (${body.urgency})${body.note ? `: ${body.note}` : ''}`,
    });
    void this.state.refresh(); // re-plan now
    return saved;
  }

  list(user: JwtUser | null, limit = 100) {
    const where = user?.role === 'station' ? { stationId: user.stationId } : {};
    return this.repo.find({ where, order: { id: 'DESC' }, take: Math.min(limit, 300) });
  }

  async cancel(id: number, user: JwtUser) {
    const r = await this.repo.findOneBy({ id });
    if (!r) throw new NotFoundException();
    if (user.role === 'station' && r.stationId !== user.stationId) throw new ForbiddenException();
    if (r.status !== 'OPEN') throw new ConflictException(`Request is ${r.status}; only OPEN requests can be cancelled`);
    await this.close(r, 'CANCELLED', `Cancelled by ${user.sub}`);
    await this.audit.record(user.sub, 'request.cancelled', String(id));
    return r;
  }

  async decline(id: number, user: JwtUser, reason: string) {
    const r = await this.repo.findOneBy({ id });
    if (!r) throw new NotFoundException();
    if (!ACTIVE.includes(r.status)) throw new ConflictException(`Request is ${r.status}`);
    await this.close(r, 'DECLINED', reason);
    await this.audit.record(user.sub, 'request.declined', String(id), { reason });
    return r;
  }

  /** Active requests the optimizer should honour. */
  async signals(): Promise<RequestSignal[]> {
    const open = await this.repo.find({ where: { status: 'OPEN' } });
    return open.map((r) => ({ stationId: r.stationId, fuel: r.fuelType, quantity: r.quantity, urgency: r.urgency, requestId: r.id }));
  }

  /** A shipment was dispatched for this station/fuel: open requests become PLANNED. */
  async markPlanned(stationId: string, fuel: string, recommendationId: string, allocationId: number | null) {
    const open = await this.repo.find({ where: { stationId, fuelType: fuel, status: 'OPEN' } });
    for (const r of open) {
      r.status = 'PLANNED';
      r.recommendationId = recommendationId;
      r.allocationId = allocationId;
      r.resolution = `Shipment dispatched (allocation #${allocationId ?? '?'})`;
      await this.repo.save(r);
    }
  }

  /** PLANNED requests close when their shipment arrives or fails in the simulator. */
  async sync(s: NetworkSnapshot) {
    const planned = await this.repo.find({ where: { status: 'PLANNED' } });
    for (const r of planned) {
      const a = s.allocations.find((x) => x.id === r.allocationId);
      if (a?.status === 'ARRIVED') await this.close(r, 'FULFILLED', `Delivered ${a.quantity.toLocaleString()} L at tick ${a.actual_arrival_tick}`, s.instance.tick);
      else if (a && (a.status === 'FAILED' || a.status === 'CANCELLED')) {
        r.status = 'OPEN';
        r.resolution = `Shipment ${a.status.toLowerCase()} (${a.failure_reason ?? 'no reason'}); re-planning`;
        await this.repo.save(r);
      }
    }
  }

  private async close(r: FuelRequest, status: FuelRequest['status'], resolution: string, tick?: number) {
    r.status = status;
    r.resolution = resolution;
    r.resolvedTick = tick ?? this.state.current()?.instance.tick ?? null;
    await this.repo.save(r);
  }
}
