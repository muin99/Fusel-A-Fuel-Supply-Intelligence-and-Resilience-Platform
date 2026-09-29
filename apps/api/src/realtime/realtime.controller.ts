import { SkipThrottle } from '@nestjs/throttler';
import { Controller, MessageEvent, Sse } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ApiTags } from '@nestjs/swagger';
import { Observable, interval, map, merge, throttleTime, fromEvent } from 'rxjs';
import type { NetworkSnapshot } from '../state/state.types.js';

/**
 * Push channel to the UI. Like the simulator's own stream, it is a HINT:
 * the frontend invalidates its queries and re-fetches over REST.
 */
@ApiTags('realtime')
@Controller('stream')
@SkipThrottle()
export class RealtimeController {
  constructor(private readonly events: EventEmitter2) {}

  @Sse()
  stream(): Observable<MessageEvent> {
    const on = (name: string) => fromEvent(this.events as never, name) as Observable<unknown>;
    return merge(
      on('network.updated').pipe(
        throttleTime(1000, undefined, { leading: true, trailing: true }),
        map((e) => {
          const s = (e as { snapshot: NetworkSnapshot }).snapshot;
          return { type: 'network', data: { tick: s.instance.tick, status: s.instance.status, stale: s.meta.stale, degraded: s.meta.degraded } };
        }),
      ),
      on('ui.alert').pipe(map((data) => ({ type: 'alert', data: data as object }))),
      on('ui.recommendations').pipe(map((data) => ({ type: 'recommendations', data: data as object }))),
      interval(15_000).pipe(map(() => ({ type: 'keepalive', data: {} }))),
    );
  }
}
