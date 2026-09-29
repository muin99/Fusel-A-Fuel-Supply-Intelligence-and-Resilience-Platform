import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Recommendation } from '../common/entities.js';
import { DecisionController } from './decision.controller.js';
import { DecisionService } from './decision.service.js';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Recommendation])],
  controllers: [DecisionController],
  providers: [DecisionService],
  exports: [DecisionService],
})
export class DecisionModule {}
