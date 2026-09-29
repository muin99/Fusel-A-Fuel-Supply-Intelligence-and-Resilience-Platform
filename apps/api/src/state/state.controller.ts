import { Controller, Get, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { StateService } from './state.service.js';

@ApiTags('network')
@Controller('network')
export class StateController {
  constructor(private readonly state: StateService) {}

  @Get()
  async snapshot() {
    const s = await this.state.get();
    if (!s) throw new ServiceUnavailableException('No network state yet (simulator unreachable, no cache)');
    return s;
  }

  @Get('stations')
  async stations() {
    return (await this.snapshot()).stations;
  }

  @Get('depots')
  async depots() {
    return (await this.snapshot()).depots;
  }

  @Get('routes')
  async routes() {
    return (await this.snapshot()).routes;
  }

  @Get('events')
  async events() {
    return (await this.snapshot()).events;
  }

  @Get('supply')
  async supply() {
    return (await this.snapshot()).supplyArrivals;
  }

  @Get('allocations')
  async allocations() {
    const s = await this.snapshot();
    if (!s.allocations) throw new NotFoundException();
    return s.allocations;
  }
}
