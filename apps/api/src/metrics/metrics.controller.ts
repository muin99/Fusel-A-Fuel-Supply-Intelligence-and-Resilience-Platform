import { SkipThrottle } from '@nestjs/throttler';
import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { MetricsService } from './metrics.service.js';

@ApiExcludeController()
@Controller('metrics')
@SkipThrottle()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
