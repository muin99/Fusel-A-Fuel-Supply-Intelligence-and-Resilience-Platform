import { ZodBody } from '../common/zod-swagger.js';
import { Throttle } from '@nestjs/throttler';
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { AuthGuard, type AuthedRequest, Roles } from '../auth/auth.guard.js';
import { DetectionService } from '../detection/detection.service.js';
import { ExplainService } from '../explain/explain.service.js';
import { StateService } from '../state/state.service.js';
import { DecisionService } from './decision.service.js';

const WhatIfSchema = z.object({
  stationId: z.string(),
  fuel: z.enum(['DIESEL', 'PETROL', 'OCTANE']),
  routeId: z.string(),
  quantity: z.number().positive().max(100_000),
});
const RejectSchema = z.object({ reason: z.string().max(500).optional() });
const AskSchema = z.object({ question: z.string().min(3).max(1000) });
const PolicySchema = z.object({ policy: z.enum(['lp_optimizer', 'heuristic']).nullable() });
const AutopilotSchema = z.object({ enabled: z.boolean() });

@ApiTags('decisions')
@Controller()
export class DecisionController {
  constructor(
    private readonly decisions: DecisionService,
    private readonly detection: DetectionService,
    private readonly explain: ExplainService,
    private readonly state: StateService,
    private readonly audit: AuditService,
  ) {}

  @Get('recommendations')
  list(@Query('status') status?: string, @Query('limit') limit?: string) {
    return this.decisions.list(status, Number(limit) || 50);
  }

  @Get('recommendations/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.decisions.get(id);
  }

  @Get('detections')
  detections() {
    return this.detection.current;
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('recommendations/:id/explain')
  explainOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.decisions.explainWithLlm(id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('operator')
  @Post('recommendations/:id/approve')
  approve(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return this.decisions.execute(id, req.user.sub);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('operator')
  @ZodBody(RejectSchema, { reason: 'Prefer the cross-region route' })
  @Post('recommendations/:id/reject')
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    return this.decisions.reject(id, req.user.sub, RejectSchema.parse(body ?? {}).reason);
  }

  @ZodBody(WhatIfSchema, { stationId: 'station-mirpur', fuel: 'DIESEL', routeId: 'route-gazipur-mirpur', quantity: 3000 })
  @Post('decisions/what-if')
  async whatIf(@Body() body: unknown) {
    const s = await this.state.get();
    if (!s) throw new ServiceUnavailableException();
    return this.decisions.whatIf(s, WhatIfSchema.parse(body));
  }

  /** Decision-engine posture for the operator console (autopilot, policy, queue size). */
  @Get('decisions/status')
  status() {
    return this.decisions.status();
  }

  /** Autopilot: routine recommendations dispatch automatically; exceptions stay in the queue. */
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('operator')
  @ZodBody(AutopilotSchema, { enabled: true })
  @Post('decisions/autopilot')
  autopilot(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.decisions.setAutopilot(AutopilotSchema.parse(body).enabled, req.user.sub);
  }

  /** Policy rollback: force the heuristic (or clear with null). */
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('operator')
  @ZodBody(PolicySchema, { policy: 'heuristic' })
  @Post('decisions/policy')
  async setPolicy(@Body() body: unknown, @Req() req: AuthedRequest) {
    const { policy } = PolicySchema.parse(body);
    this.decisions.forcedPolicy = policy;
    await this.audit.record(req.user.sub, 'policy.changed', null, { policy });
    return { forcedPolicy: policy };
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Get('assistant/summary')
  async summary() {
    const s = await this.state.get();
    if (!s) throw new ServiceUnavailableException();
    return this.explain.summarize(s, { detections: this.detection.current.slice(0, 20) });
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ZodBody(AskSchema, { question: 'Which station is most at risk and why?' })
  @Post('assistant/ask')
  async ask(@Body() body: unknown) {
    const { question } = AskSchema.parse(body);
    const s = await this.state.get();
    const open = await this.decisions.list('PROPOSED', 10);
    return this.explain.ask(question, {
      tick: s?.instance.tick,
      metrics: s?.metrics,
      stations: s?.stations,
      depots: s?.depots,
      routes: s?.routes,
      detections: this.detection.current,
      openRecommendations: open,
    });
  }
}
