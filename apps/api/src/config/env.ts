import { z } from 'zod';

/** All runtime configuration. Validated at boot — the app refuses to start on bad config. */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),

  SIMULATOR_URL: z.url().default('http://localhost:8000'),
  SIMULATOR_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  SIMULATOR_RETRIES: z.coerce.number().int().min(0).max(10).default(3),

  DATABASE_URL: z.string().default('postgres://fuelops:fuelops@localhost:5433/fuelops'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  JWT_SECRET: z.string().min(8),
  OPERATOR_PASSWORD: z.string().min(1),
  VIEWER_PASSWORD: z.string().min(1),
  /** shared password for station-manager logins (each login is scoped to one station) */
  STATION_PASSWORD: z.string().min(1).default('station'),
  /** shared password for depot-manager logins (each login is scoped to one depot) */
  DEPOT_PASSWORD: z.string().min(1).default('depot'),

  /** Demo mode: one-click role switching without passwords (roles/permissions still enforced). Never enable in production. */
  DEMO_MODE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),

  GPT_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4.1-mini'),

  /** Autopilot: routine, high-confidence, feasible recommendations dispatch automatically; exceptions wait for an operator. */
  AUTO_DISPATCH: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  /** per-IP requests/minute across the API (login has its own stricter limit) */
  RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(6000),
  MIN_CONFIDENCE_FOR_AUTO: z.coerce.number().min(0).max(1).default(0.6),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
