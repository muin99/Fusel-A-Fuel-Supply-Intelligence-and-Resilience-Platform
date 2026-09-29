import { Global, Module } from '@nestjs/common';
import { SimulatorClient } from './simulator.client.js';
import { SimulatorStream } from './simulator.stream.js';

@Global()
@Module({
  providers: [SimulatorClient, SimulatorStream],
  exports: [SimulatorClient, SimulatorStream],
})
export class SimulatorModule {}
