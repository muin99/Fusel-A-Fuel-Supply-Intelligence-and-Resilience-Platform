import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createParser } from 'eventsource-parser';
import type { Env } from '../config/env.js';
import { MetricsService } from '../metrics/metrics.service.js';

/**
 * Subscribes to GET /v1/stream and re-emits events internally as `sim.<event-name>`.
 * SSE is only a HINT — listeners must re-GET REST state (integration guide §2).
 * Reconnects with backoff; emits `sim.stream.reconnected` so state can be refetched
 * (there is no Last-Event-ID replay).
 */
@Injectable()
export class SimulatorStream implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SimulatorStream.name);
  private abort?: AbortController;
  private stopped = false;
  connected = false;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly events: EventEmitter2,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit() {
    void this.loop();
  }

  onModuleDestroy() {
    this.stopped = true;
    this.abort?.abort();
  }

  private async loop() {
    let attempt = 0;
    while (!this.stopped) {
      try {
        await this.connectOnce();
        attempt = 0;
      } catch (err) {
        if (this.stopped) return;
        this.log.warn(`SSE stream error: ${(err as Error).message}`);
      }
      this.setConnected(false);
      const wait = Math.min(15_000, 500 * 2 ** attempt++);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  private async connectOnce() {
    this.abort = new AbortController();
    const url = `${this.config.get('SIMULATOR_URL', { infer: true })}/v1/stream`;
    const res = await fetch(url, { signal: this.abort.signal, headers: { Accept: 'text/event-stream' } });
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`stream HTTP ${res.status}`);
    }

    this.setConnected(true);
    this.events.emit('sim.stream.reconnected', {});
    this.log.log('Connected to simulator SSE stream');

    const parser = createParser({
      onEvent: (ev) => {
        let data: unknown = ev.data;
        try {
          data = JSON.parse(ev.data);
        } catch {
          /* keep raw */
        }
        this.events.emit(`sim.${ev.event ?? 'message'}`, data);
      },
    });
    const decoder = new TextDecoder();
    let watchdog = setTimeout(() => this.abort?.abort(), 45000);
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => this.abort?.abort(), 45000);
        parser.feed(decoder.decode(chunk, { stream: true }));
      }
    } finally {
      clearTimeout(watchdog);
      // Always release the HTTP connection (each open stream holds a simulator DB session).
      this.abort?.abort();
    }
    throw new Error('stream ended');
  }

  private setConnected(v: boolean) {
    this.connected = v;
    this.metrics.simStreamConnected.set(v ? 1 : 0);
  }
}
