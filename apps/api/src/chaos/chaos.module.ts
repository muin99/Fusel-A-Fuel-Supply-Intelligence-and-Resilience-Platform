import { Module } from '@nestjs/common';
import { ChaosController } from './chaos.controller.js';

@Module({ controllers: [ChaosController] })
export class ChaosModule {}
