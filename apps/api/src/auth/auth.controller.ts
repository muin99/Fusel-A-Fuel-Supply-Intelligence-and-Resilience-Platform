import { ZodBody } from '../common/zod-swagger.js';
import { Body, Controller, Get, NotFoundException, Post, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Env } from '../config/env.js';
import { StateService } from '../state/state.service.js';
import type { Role } from './auth.guard.js';

const LoginSchema = z
  .object({
    username: z.string().min(1).max(64),
    role: z.enum(['operator', 'viewer', 'station', 'depot']),
    password: z.string(),
    stationId: z.string().regex(/^station-[a-z0-9-]+$/).optional(),
    depotId: z.string().regex(/^depot-[a-z0-9-]+$/).optional(),
  })
  .refine((b) => b.role !== 'station' || !!b.stationId, { message: 'stationId is required for station managers', path: ['stationId'] })
  .refine((b) => b.role !== 'depot' || !!b.depotId, { message: 'depotId is required for depot managers', path: ['depotId'] });

const DemoSchema = z
  .object({ role: z.enum(['operator', 'viewer', 'station', 'depot']), stationId: z.string().optional(), depotId: z.string().optional() })
  .refine((b) => b.role !== 'station' || !!b.stationId, { path: ['stationId'], message: 'stationId required' })
  .refine((b) => b.role !== 'depot' || !!b.depotId, { path: ['depotId'], message: 'depotId required' });

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Hackathon-grade auth: shared per-role passwords from env, short-lived JWT. */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
    private readonly state: StateService,
  ) {}

  /** Tells the UI whether one-click demo role switching is enabled. */
  @Get('config')
  authConfig() {
    return { demoMode: this.config.get('DEMO_MODE', { infer: true }) };
  }

  /**
   * DEMO_MODE only: issue a role token without a password so a presenter can switch
   * between operator / depot manager / station manager instantly. Permissions per role
   * are still enforced by the same guards. Returns 404 when demo mode is off.
   */
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post('demo')
  async demo(@Body() body: unknown) {
    if (!this.config.get('DEMO_MODE', { infer: true })) throw new NotFoundException();
    const { role, stationId, depotId } = DemoSchema.parse(body);
    const snapshot = this.state.current();
    if (role === 'station' && snapshot && !snapshot.stations.some((s) => s.id === stationId)) throw new UnauthorizedException('Unknown station');
    if (role === 'depot' && snapshot && !snapshot.depots.some((d) => d.id === depotId)) throw new UnauthorizedException('Unknown depot');
    const username = role === 'station' ? `${stationId}-manager` : role === 'depot' ? `${depotId}-manager` : role;
    const claims = { sub: username, role: role as Role, ...(role === 'station' ? { stationId } : {}), ...(role === 'depot' ? { depotId } : {}) };
    return { token: await this.jwt.signAsync(claims), role, username, stationId: claims.stationId ?? null, depotId: claims.depotId ?? null };
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Get a JWT. Paste the token into Authorize (top right) to call operator endpoints.' })
  @ZodBody(LoginSchema, { username: 'operator', role: 'operator', password: 'operator', stationId: undefined })
  @Post('login')
  async login(@Body() body: unknown) {
    const { username, role, password, stationId, depotId } = LoginSchema.parse(body);
    const key = ({ operator: 'OPERATOR_PASSWORD', station: 'STATION_PASSWORD', depot: 'DEPOT_PASSWORD', viewer: 'VIEWER_PASSWORD' } as const)[role];
    if (!safeEqual(password, this.config.get(key, { infer: true }))) throw new UnauthorizedException('Invalid credentials');
    const snapshot = this.state.current();
    if (role === 'station' && snapshot && !snapshot.stations.some((s) => s.id === stationId)) throw new UnauthorizedException('Unknown station');
    if (role === 'depot' && snapshot && !snapshot.depots.some((d) => d.id === depotId)) throw new UnauthorizedException('Unknown depot');
    const claims = { sub: username, role: role as Role, ...(role === 'station' ? { stationId } : {}), ...(role === 'depot' ? { depotId } : {}) };
    const token = await this.jwt.signAsync(claims);
    return { token, role, username, stationId: role === 'station' ? stationId : null, depotId: role === 'depot' ? depotId : null };
  }
}
