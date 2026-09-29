import { Global, Module } from '@nestjs/common';
import { ExplainService } from './explain.service.js';

@Global()
@Module({ providers: [ExplainService], exports: [ExplainService] })
export class ExplainModule {}
