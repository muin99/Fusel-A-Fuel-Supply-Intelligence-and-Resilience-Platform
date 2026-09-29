import { Global, Module } from '@nestjs/common';
import { StateController } from './state.controller.js';
import { StateService } from './state.service.js';

@Global()
@Module({ controllers: [StateController], providers: [StateService], exports: [StateService] })
export class StateModule {}
