import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DemandRecord, InventorySnapshot } from '../common/entities.js';
import { IngestionService } from './ingestion.service.js';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([DemandRecord, InventorySnapshot])],
  providers: [IngestionService],
  exports: [IngestionService],
})
export class IngestionModule {}
