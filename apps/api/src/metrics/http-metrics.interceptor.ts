import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, finalize } from 'rxjs';
import { MetricsService } from './metrics.service.js';

@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    // Use the route template (not the raw URL) to keep label cardinality bounded.
    const route = (req.route?.path as string | undefined) ?? 'unmatched';
    const end = this.metrics.httpDuration.startTimer({ method: req.method, route });
    const started = performance.now();
    return next.handle().pipe(
      finalize(() => {
        end();
        if (!route.endsWith('/stream') && !route.endsWith('metrics'))
          this.metrics.recordRequest(performance.now() - started, res.statusCode >= 500);
        this.metrics.httpRequests.inc({ method: req.method, route, status: String(res.statusCode) });
      }),
    );
  }
}
