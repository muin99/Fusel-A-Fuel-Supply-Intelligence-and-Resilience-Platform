import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Every metric the platform exposes at GET /api/metrics.
 * Layers follow the problem statement §14: application, system, intelligence.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  // ---- Application ----
  readonly httpRequests = new Counter({
    name: 'http_requests_total',
    help: 'HTTP requests served by the API',
    labelNames: ['method', 'route', 'status'],
    registers: [this.registry],
  });
  readonly httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'API request latency',
    labelNames: ['method', 'route'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  // ---- Simulator integration ----
  readonly simRequests = new Counter({
    name: 'simulator_requests_total',
    help: 'Calls to the fuel simulator',
    labelNames: ['endpoint', 'outcome'],
    registers: [this.registry],
  });
  readonly simDuration = new Histogram({
    name: 'simulator_request_duration_seconds',
    help: 'Simulator call latency (including retries)',
    labelNames: ['endpoint'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [this.registry],
  });
  readonly simCircuitState = new Gauge({
    name: 'simulator_circuit_state',
    help: '0=closed, 1=half-open, 2=open',
    registers: [this.registry],
  });
  readonly simStaleResponses = new Counter({
    name: 'simulator_stale_responses_total',
    help: 'Responses flagged X-Simulator-Stale',
    registers: [this.registry],
  });
  readonly simInvalidResponses = new Counter({
    name: 'simulator_invalid_responses_total',
    help: 'Responses rejected by schema validation',
    labelNames: ['endpoint'],
    registers: [this.registry],
  });
  readonly simStreamConnected = new Gauge({
    name: 'simulator_stream_connected',
    help: '1 when the SSE stream to the simulator is connected',
    registers: [this.registry],
  });
  readonly simTick = new Gauge({ name: 'sim_tick', help: 'Current simulator tick', registers: [this.registry] });
  readonly simServiceLevel = new Gauge({
    name: 'sim_service_level',
    help: 'Simulator ground-truth service level (served / demand)',
    registers: [this.registry],
  });
  readonly degradedMode = new Gauge({
    name: 'platform_degraded_mode',
    help: '1 when serving cached state because the simulator is unreachable',
    registers: [this.registry],
  });

  readonly aiRequests = new Counter({ name: 'ai_requests_total', help: 'GPT requests by outcome', labelNames: ['outcome'], registers: [this.registry] });
  readonly aiDuration = new Histogram({ name: 'ai_duration_seconds', help: 'GPT generation latency', buckets: [1, 3, 5, 10, 20, 30], registers: [this.registry] });
  // ---- Intelligence ----
  readonly forecastAbsError = new Histogram({
    name: 'forecast_abs_error_liters',
    help: 'Absolute error of 1-tick-ahead demand forecast',
    labelNames: ['fuel_type'],
    buckets: [1, 5, 10, 25, 50, 100, 250, 500],
    registers: [this.registry],
  });
  readonly predictionConfidence = new Gauge({
    name: 'prediction_confidence',
    help: 'Mean confidence of the latest forecast batch (0..1)',
    registers: [this.registry],
  });
  readonly shortageAlerts = new Counter({
    name: 'shortage_alerts_total',
    help: 'Shortage alerts raised',
    labelNames: ['severity'],
    registers: [this.registry],
  });
  readonly anomalies = new Counter({
    name: 'anomalies_detected_total',
    help: 'Anomalies detected',
    labelNames: ['kind'],
    registers: [this.registry],
  });
  readonly decisions = new Counter({
    name: 'decisions_total',
    help: 'Allocation recommendations produced / acted on',
    labelNames: ['policy', 'outcome'],
    registers: [this.registry],
  });
  readonly decisionFallback = new Counter({
    name: 'decision_fallback_total',
    help: 'Times the decision engine fell back to the safe heuristic',
    labelNames: ['reason'],
    registers: [this.registry],
  });

  /** Rolling 60s window for the in-app status panel (Prometheus has the full picture). */
  private window: { at: number; ms: number; error: boolean }[] = [];

  recordRequest(ms: number, error: boolean) {
    const now = Date.now();
    this.window.push({ at: now, ms, error });
    if (this.window.length > 5000 || this.window[0].at < now - 60_000) {
      this.window = this.window.filter((w) => w.at >= now - 60_000).slice(-5000);
    }
  }

  rollingStats() {
    const now = Date.now();
    const recent = this.window.filter((w) => w.at >= now - 60_000);
    const sorted = recent.map((w) => w.ms).sort((a, b) => a - b);
    const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
    return {
      requestsPerMin: recent.length,
      p50Ms: q(0.5),
      p95Ms: q(0.95),
      p99Ms: q(0.99),
      errorRate: recent.length ? recent.filter((w) => w.error).length / recent.length : 0,
    };
  }

  constructor() {
    // ---- System: CPU, memory, event loop, GC ----
    collectDefaultMetrics({ register: this.registry });
  }
}
