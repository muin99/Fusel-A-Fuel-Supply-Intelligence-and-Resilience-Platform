import { Global, Inject, Injectable, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { Env } from '../config/env.js';

export const REDIS = Symbol('REDIS');

/** Thin cache wrapper — every call is best-effort so a Redis outage never breaks a request. */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly log = new Logger(CacheService.name);
  constructor(@Inject(REDIS) readonly redis: Redis) {}

  async getJson<T>(key: string): Promise<T | null> {
    try {
      const v = await this.redis.get(key);
      return v ? (JSON.parse(v) as T) : null;
    } catch (e) {
      this.log.warn(`cache get ${key} failed: ${(e as Error).message}`);
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    try {
      const s = JSON.stringify(value);
      if (ttlSeconds) await this.redis.set(key, s, 'EX', ttlSeconds);
      else await this.redis.set(key, s);
    } catch (e) {
      this.log.warn(`cache set ${key} failed: ${(e as Error).message}`);
    }
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy() {
    await this.redis.quit().catch(() => undefined);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new Redis(config.get('REDIS_URL', { infer: true }), {
          lazyConnect: false,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
        }),
    },
    CacheService,
  ],
  exports: [CacheService, REDIS],
})
export class RedisModule {}
