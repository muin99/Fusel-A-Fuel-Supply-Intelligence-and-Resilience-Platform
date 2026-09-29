import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Alert, AuditEntry } from '../common/entities.js';
import { CopilotService } from './copilot.service.js';
import { IntelligenceController } from './intelligence.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([Alert, AuditEntry])],
  controllers: [IntelligenceController],
  providers: [CopilotService],
  exports: [CopilotService],
})
export class IntelligenceModule {}
