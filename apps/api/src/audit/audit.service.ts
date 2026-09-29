import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Alert, AuditEntry } from '../common/entities.js';
import { StateService } from '../state/state.service.js';

export interface AlertInput {
  kind?: string;
  severity: 'info' | 'warning' | 'critical';
  source?: string;
  entityId?: string;
  message: string;
  [k: string]: unknown;
}

/** Decision audit history + alert store. Writes are best-effort: logging never breaks a decision. */
@Injectable()
export class AuditService {
  private readonly log = new Logger('Audit');
  /** identical alerts inside this window are collapsed (keeps the feed readable) */
  private readonly dedupeMs = 120_000;
  private lastSeen = new Map<string, number>();

  constructor(
    @InjectRepository(AuditEntry) private readonly audit: Repository<AuditEntry>,
    @InjectRepository(Alert) private readonly alerts: Repository<Alert>,
    private readonly state: StateService,
    private readonly events: EventEmitter2,
  ) {}

  async record(actor: string, action: string, entityId: string | null, details: Record<string, unknown> = {}) {
    const tick = this.state.current()?.instance.tick ?? null;
    this.log.log({ msg: 'audit', actor, action, entityId, tick, ...details });
    try {
      await this.audit.save(this.audit.create({ actor, action, entityId, details, tick }));
    } catch (e) {
      this.log.error(`audit write failed: ${(e as Error).message}`);
    }
  }

  @OnEvent('alert.*')
  async raise(input: AlertInput) {
    const { kind = 'system', severity, entityId, message, ...data } = input;
    const key = `${kind}|${entityId ?? ''}|${message}`;
    const now = Date.now();
    if (now - (this.lastSeen.get(key) ?? 0) < this.dedupeMs) return;
    this.lastSeen.set(key, now);
    if (this.lastSeen.size > 500) for (const [k, at] of this.lastSeen) if (now - at > this.dedupeMs) this.lastSeen.delete(k);
    const tick = this.state.current()?.instance.tick ?? null;
    this.log.warn({ msg: 'alert', kind, severity, entityId, message });
    try {
      const saved = await this.alerts.save(
        this.alerts.create({ kind, severity, entityId: entityId ?? null, message, data, tick }),
      );
      this.events.emit('ui.alert', saved);
    } catch (e) {
      this.log.error(`alert write failed: ${(e as Error).message}`);
    }
  }

  listAudit(limit = 100) {
    return this.audit.find({ order: { id: 'DESC' }, take: Math.min(limit, 500) });
  }

  listAlerts(limit = 100, kind?: string) {
    return this.alerts.find({ where: kind ? { kind } : {}, order: { id: 'DESC' }, take: Math.min(limit, 500) });
  }

  async ackAlert(id: number, actor: string) {
    await this.alerts.update(id, { acknowledged: true });
    await this.record(actor, 'alert.acknowledged', String(id));
  }
}
