import { IntelligenceModule } from './intelligence/intelligence.module.js';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoggerModule } from 'nestjs-pino';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ChaosModule } from './chaos/chaos.module.js';
import { ENTITIES } from './common/entities.js';
import { RedisModule } from './common/redis.module.js';
import { type Env, validateEnv } from './config/env.js';
import { DecisionModule } from './decision/decision.module.js';
import { RequestsModule } from './requests/requests.module.js';
import { DetectionModule } from './detection/detection.module.js';
import { ExplainModule } from './explain/explain.module.js';
import { ForecastModule } from './forecast/forecast.module.js';
import { HealthModule } from './health/health.module.js';
import { IngestionModule } from './ingestion/ingestion.module.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { SimulatorModule } from './simulator/simulator.module.js';
import { StateModule } from './state/state.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, envFilePath: ['.env', '../../.env'] }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty', options: { singleLine: true } },
        autoLogging: { ignore: (req) => /\/(metrics|health|stream)/.test(req.url ?? '') },
        serializers: {
          req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url }),
          res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
        },
      },
    }),
    EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => [{ ttl: 60_000, limit: config.get('RATE_LIMIT_PER_MIN', { infer: true }) }],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        type: 'postgres',
        url: config.get('DATABASE_URL', { infer: true }),
        entities: ENTITIES,
        // Hackathon: auto-sync schema. Switch to migrations before any real deployment.
        synchronize: true,
        retryAttempts: 20,
        retryDelay: 2000,
      }),
    }),
    MetricsModule,
    RedisModule,
    SimulatorModule,
    StateModule,
    AuditModule,
    AuthModule,
    IngestionModule,
    ForecastModule,
    DetectionModule,
    ExplainModule,
    RequestsModule,
    DecisionModule,
    HealthModule,
    RealtimeModule,
    ChaosModule,
    IntelligenceModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
