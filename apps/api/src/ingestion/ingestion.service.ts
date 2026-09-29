import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DemandRecord, InventorySnapshot } from '../common/entities.js';
import { FUEL_TYPES, parseSimTime } from '../simulator/simulator.schemas.js';
import { SimulatorClient } from '../simulator/simulator.client.js';
import type { NetworkSnapshot } from '../state/state.types.js';
import { CacheService } from '../common/redis.module.js';

/**
 * Persists simulator history into our own DB (the simulator's demand table grows
 * unbounded and is only reachable 2000 rows at a time).
 */
@Injectable()
export class IngestionService {
  private readonly log = new Logger(IngestionService.name);
  private busy = false;
  private checkedRun = false;
  private groupReady = false;
  private draining = false;
  /** last tick already copied from /v1/demand-history (reset with the run) */
  private lastIngestedTick = -1;

  constructor(
    private readonly sim: SimulatorClient,
    @InjectRepository(DemandRecord) private readonly demand: Repository<DemandRecord>,
    @InjectRepository(InventorySnapshot) private readonly inventory: Repository<InventorySnapshot>,
    private readonly cache: CacheService,
    private readonly events: EventEmitter2,
  ) {}

  @OnEvent('network.updated')
  async onUpdate({ snapshot, tickAdvanced }: { snapshot: NetworkSnapshot; tickAdvanced: boolean }) {
    if (snapshot.meta.stale || (!tickAdvanced && this.checkedRun)) return;
    try {
      await this.cache.redis.xadd('ingestion:queue', 'MAXLEN', '~', 1000, '*', 'snapshot', JSON.stringify(snapshot));
      await this.drain();
    } catch {
      await this.ingest(snapshot, tickAdvanced); // Redis outage: direct persistence fallback
    }
  }

  /** Single ingestion worker, durable pending entries retried before new work. */
  @Interval(1000)
  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      if (!this.groupReady) {
        try { await this.cache.redis.xgroup('CREATE', 'ingestion:queue', 'history', '0', 'MKSTREAM'); }
        catch (e) { if (!(e as Error).message.includes('BUSYGROUP')) throw e; }
        this.groupReady = true;
      }
      type Entries = [string, [string, string[]][]][];
      let batches = await this.cache.redis.xreadgroup('GROUP', 'history', 'worker', 'COUNT', 5, 'STREAMS', 'ingestion:queue', '0') as Entries | null;
      if (!batches?.[0]?.[1]?.length) batches = await this.cache.redis.xreadgroup('GROUP', 'history', 'worker', 'COUNT', 5, 'STREAMS', 'ingestion:queue', '>') as Entries | null;
      for (const [, entries] of batches ?? []) for (const [id, fields] of entries) {
        if (fields.length) await this.ingest(JSON.parse(fields[1]) as NetworkSnapshot, true);
        await this.cache.redis.xack('ingestion:queue', 'history', id);
        await this.cache.redis.xdel('ingestion:queue', id);
      }
    } catch { /* best-effort queue; direct ingestion remains available */ }
    finally { this.draining = false; }
  }

  private async ingest(snapshot: NetworkSnapshot, tickAdvanced: boolean) {
    if (snapshot.meta.stale || this.busy) return;
    if (!tickAdvanced && this.checkedRun) return;
    this.busy = true;
    try {
      if (!this.checkedRun) {
        // Boot: history from a previous run (sim reset while we were down) must not leak in.
        const { max } = (await this.demand.createQueryBuilder('d').select('MAX(d.tick)', 'max').getRawOne<{ max: number | null }>()) ?? { max: null };
        if (max !== null && max > snapshot.instance.tick) await this.purge('history ahead of simulator at boot');
        this.checkedRun = true;
      }
      await Promise.all([this.ingestDemand(snapshot.instance.tick), this.snapshotInventory(snapshot)]);
      this.events.emit('history.updated', { tick: snapshot.instance.tick });
    } catch (e) {
      this.log.warn(`ingestion failed: ${(e as Error).message}`);
      throw e; // keep queue item pending for retry
    } finally {
      this.busy = false;
    }
  }

  @OnEvent('sim.reset')
  async onReset() {
    await this.cache.redis.del('ingestion:queue').catch(() => undefined);
    this.groupReady = false;
    this.checkedRun = false;
    await this.purge('simulator reset');
  }

  /** History is per simulation run; a reset starts a new run. */
  private async purge(reason: string) {
    this.lastIngestedTick = -1;
    await this.demand.clear();
    await this.inventory.clear();
    this.log.warn(`Cleared demand/inventory history (${reason})`);
  }

  private async ingestDemand(tick: number) {
    // 12 rows per tick: only fetch what is new since the last ingest (bounded catch-up).
    const limit = Math.min(2000, Math.max(24, 12 * (tick - this.lastIngestedTick + 1)));
    const { data, stale } = await this.sim.demandHistory({ limit });
    if (stale || data.length === 0) return;
    this.lastIngestedTick = Math.max(...data.map((d) => d.tick));
    await this.demand
      .createQueryBuilder()
      .insert()
      .values(
        data.map((d) => ({
          stationId: d.station_id,
          fuelType: d.fuel_type,
          tick: d.tick,
          simTime: parseSimTime(d.sim_time),
          demand: d.demand_liters,
          served: d.served_liters,
          unmet: d.unmet_liters,
        })),
      )
      .orIgnore()
      .execute();
  }

  private async snapshotInventory(s: NetworkSnapshot) {
    const tick = s.instance.tick;
    const rows = [
      ...s.depots.flatMap((d) =>
        FUEL_TYPES.map((f) => ({ tick, entityType: 'depot' as const, entityId: d.id, fuelType: f, inventory: d.inventory[f] })),
      ),
      ...s.stations.flatMap((st) =>
        FUEL_TYPES.map((f) => ({ tick, entityType: 'station' as const, entityId: st.id, fuelType: f, inventory: st.inventory[f] })),
      ),
    ];
    await this.inventory.createQueryBuilder().insert().values(rows).orIgnore().execute();
  }

  /** Recent history for one station/fuel, oldest first. */
  async history(stationId: string, fuelType: string, lastN = 96 * 3) {
    const rows = await this.demand.find({
      where: { stationId, fuelType },
      order: { tick: 'DESC' },
      take: lastN,
    });
    return rows.reverse();
  }
}
