import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FuelRequest } from '../common/entities.js';
import { RequestsController } from './requests.controller.js';
import { RequestsService } from './requests.service.js';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([FuelRequest])],
  controllers: [RequestsController],
  providers: [RequestsService],
  exports: [RequestsService],
})
export class RequestsModule {}
