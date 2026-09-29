import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthGuard, type AuthedRequest, Roles } from '../auth/auth.guard.js';
import { ZodBody } from '../common/zod-swagger.js';
import { RequestsService } from './requests.service.js';

const CreateSchema = z.object({
  stationId: z.string().optional(),
  fuel: z.enum(['DIESEL', 'PETROL', 'OCTANE']),
  quantity: z.number().int().min(500).max(20_000),
  urgency: z.enum(['routine', 'urgent', 'emergency']).default('routine'),
  note: z.string().max(300).optional(),
});
const DeclineSchema = z.object({ reason: z.string().min(3).max(300) });

/** Station-manager fuel requests: the "customer side" demand signal into the decision engine. */
@ApiTags('requests')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('requests')
export class RequestsController {
  constructor(private readonly requests: RequestsService) {}

  @Get()
  list(@Req() req: AuthedRequest, @Query('limit') limit?: string) {
    return this.requests.list(req.user, Number(limit) || 100);
  }

  @Roles('station', 'operator')
  @ZodBody(CreateSchema, { fuel: 'DIESEL', quantity: 4000, urgency: 'urgent', note: 'Truck convoy expected tonight' })
  @Post()
  create(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.requests.create(req.user, CreateSchema.parse(body));
  }

  @Roles('station', 'operator')
  @Post(':id/cancel')
  cancel(@Param('id', ParseIntPipe) id: number, @Req() req: AuthedRequest) {
    return this.requests.cancel(id, req.user);
  }

  @Roles('operator')
  @ZodBody(DeclineSchema, { reason: 'Station tank is above 80%; no shortage projected' })
  @Post(':id/decline')
  decline(@Param('id', ParseIntPipe) id: number, @Body() body: unknown, @Req() req: AuthedRequest) {
    return this.requests.decline(id, req.user, DeclineSchema.parse(body).reason);
  }
}
