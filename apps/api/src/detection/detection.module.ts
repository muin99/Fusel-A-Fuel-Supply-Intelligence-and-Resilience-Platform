import { Global, Module } from '@nestjs/common';
import { DetectionService } from './detection.service.js';

@Global()
@Module({ providers: [DetectionService], exports: [DetectionService] })
export class DetectionModule {}
