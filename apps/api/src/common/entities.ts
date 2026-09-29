import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/** Our own copy of simulator demand history — the training set for forecasting. */
@Entity('demand_records')
@Unique(['stationId', 'fuelType', 'tick'])
export class DemandRecord {
  @PrimaryGeneratedColumn() id: number;
  @Index() @Column() stationId: string;
  @Column() fuelType: string;
  @Index() @Column('int') tick: number;
  @Column('timestamp') simTime: Date;
  @Column('double precision') demand: number;
  @Column('double precision') served: number;
  @Column('double precision') unmet: number;
}

/** Inventory per entity/fuel per tick — lets us detect abnormal inventory changes and replay. */
@Entity('inventory_snapshots')
@Unique(['entityId', 'fuelType', 'tick'])
export class InventorySnapshot {
  @PrimaryGeneratedColumn() id: number;
  @Index() @Column('int') tick: number;
  @Column() entityType: 'depot' | 'station';
  @Column() entityId: string;
  @Column() fuelType: string;
  @Column('double precision') inventory: number;
}

export type RecommendationStatus =
  | 'PROPOSED'
  | 'NEEDS_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'SUBMITTED'
  | 'FAILED'
  | 'EXPIRED';

/** An inspectable allocation recommendation (problem statement §9). */
@Entity('recommendations')
export class Recommendation {
  @PrimaryGeneratedColumn('uuid') id: string;
  @CreateDateColumn() createdAt: Date;
  @Index() @Column('int') tick: number;
  @Column() stationId: string;
  @Column() fuelType: string;
  @Column() depotId: string;
  @Column() routeId: string;
  @Column('double precision') quantity: number;
  /** which policy produced it: 'lp_optimizer' | 'heuristic' | 'heuristic_fallback' | 'rl' ... */
  @Column() policy: string;
  @Column('double precision') confidence: number;
  @Column('double precision') riskBefore: number;
  @Column('double precision') riskAfter: number;
  @Column('double precision', { nullable: true }) hoursToStockout: number | null;
  /** signals, constraints, alternatives — everything the operator needs to inspect it */
  @Column('jsonb') rationale: Record<string, unknown>;
  @Column('text', { nullable: true }) explanation: string | null;
  @Index() @Column({ default: 'PROPOSED' }) status: RecommendationStatus;
  @Column('int', { nullable: true }) simAllocationId: number | null;
  @Column('varchar', { nullable: true }) decidedBy: string | null;
  @Column('text', { nullable: true }) error: string | null;
}

@Entity('alerts')
export class Alert {
  @PrimaryGeneratedColumn() id: number;
  @CreateDateColumn() createdAt: Date;
  @Column('int', { nullable: true }) tick: number | null;
  /** shortage | anomaly | disruption | system */
  @Index() @Column() kind: string;
  /** info | warning | critical */
  @Column() severity: string;
  @Column('varchar', { nullable: true }) entityId: string | null;
  @Column('text') message: string;
  @Column('jsonb', { default: {} }) data: Record<string, unknown>;
  @Column({ default: false }) acknowledged: boolean;
}

/** Decision audit history — every consequential action, who did it, and why. */
@Entity('audit_log')
export class AuditEntry {
  @PrimaryGeneratedColumn() id: number;
  @CreateDateColumn() at: Date;
  @Column('int', { nullable: true }) tick: number | null;
  @Column() actor: string;
  @Index() @Column() action: string;
  @Column('varchar', { nullable: true }) entityId: string | null;
  @Column('jsonb', { default: {} }) details: Record<string, unknown>;
}

export type RequestUrgency = 'routine' | 'urgent' | 'emergency';
export type RequestStatus = 'OPEN' | 'PLANNED' | 'FULFILLED' | 'DECLINED' | 'CANCELLED';

/**
 * Fuel request raised by a station manager. It is a demand SIGNAL for the decision engine
 * (raises priority / minimum quantity); the simulator remains the source of truth.
 */
@Entity('fuel_requests')
export class FuelRequest {
  @PrimaryGeneratedColumn() id: number;
  @CreateDateColumn() createdAt: Date;
  @Column('int') tick: number;
  @Index() @Column() stationId: string;
  @Column() fuelType: string;
  @Column('double precision') quantity: number;
  @Column() urgency: RequestUrgency;
  @Column('text', { nullable: true }) note: string | null;
  @Column() requestedBy: string;
  @Index() @Column({ default: 'OPEN' }) status: RequestStatus;
  @Column('varchar', { nullable: true }) recommendationId: string | null;
  @Column('int', { nullable: true }) allocationId: number | null;
  @Column('text', { nullable: true }) resolution: string | null;
  @Column('int', { nullable: true }) resolvedTick: number | null;
}

export const ENTITIES = [DemandRecord, InventorySnapshot, Recommendation, Alert, AuditEntry, FuelRequest];
