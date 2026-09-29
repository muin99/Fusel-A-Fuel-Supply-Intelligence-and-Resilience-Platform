import { Controller, Get, Param, ParseIntPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard, type AuthedRequest, Roles } from '../auth/auth.guard.js';
import { AuditService } from './audit.service.js';

@ApiTags('audit')
@Controller()
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get('audit')
  list(@Query('limit') limit?: string) {
    return this.audit.listAudit(Number(limit) || 100);
  }

  @Get('alerts')
  alerts(@Query('limit') limit?: string, @Query('kind') kind?: string) {
    return this.audit.listAlerts(Number(limit) || 100, kind);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('operator')
  @Post('alerts/:id/ack')
  ack(@Param('id', ParseIntPipe) id: number, @Req() req: AuthedRequest) {
    return this.audit.ackAlert(id, req.user.sub);
  }
}
