import { Global, Module } from '@nestjs/common';
import { ForecastController } from './forecast.controller.js';
import { ForecastService } from './forecast.service.js';

@Global()
@Module({ controllers: [ForecastController], providers: [ForecastService], exports: [ForecastService] })
export class ForecastModule {}
