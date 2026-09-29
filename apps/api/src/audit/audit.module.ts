import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Alert, AuditEntry } from '../common/entities.js';
import { AuditController } from './audit.controller.js';
import { AuditService } from './audit.service.js';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AuditEntry, Alert])],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
