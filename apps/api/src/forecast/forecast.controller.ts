import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { StateService } from '../state/state.service.js';
import { FUEL_TYPES } from '../simulator/simulator.schemas.js';
import { ForecastService } from './forecast.service.js';
import { networkRunway } from './runway.js';
import { trainedModelInfo } from './trained.js';

@ApiTags('intelligence')
@Controller('forecast')
export class ForecastController {
  constructor(
    private readonly forecast: ForecastService,
    private readonly state: StateService,
  ) {}

  @Get('trained-model')
  trainedModel() { return trainedModelInfo(); }

  /** Network fuel runway per fuel (all stock + scheduled supply vs forecast demand). */
  @Get('runway')
  async runway() {
    const s = await this.state.get();
    if (!s) throw new ServiceUnavailableException('No network state');
    return networkRunway(s, this.forecast.available ? await this.forecast.assess(s) : null);
  }

  /** Risk table: stockout ETA, probability and forecast for every station × fuel. */
  @Get('risk')
  async risk() {
    const s = await this.state.get();
    if (!s) throw new ServiceUnavailableException('No network state');
    if (!this.forecast.available) {
      // Model offline: inventory-cover risk so operators still see where to act.
      return s.stations
        .flatMap((st) =>
          FUEL_TYPES.map((fuel) => {
            const inTransit = s.allocations
              .filter((a) => a.destination_station_id === st.id && a.fuel_type === fuel && (a.status === 'PENDING' || a.status === 'IN_TRANSIT'))
              .reduce((x, a) => x + a.quantity, 0);
            const fill = (st.inventory[fuel] + inTransit) / st.capacity[fuel];
            return {
              stationId: st.id,
              stationName: st.name,
              regionId: st.region_id,
              fuel,
              inventory: st.inventory[fuel],
              capacity: st.capacity[fuel],
              inTransit,
              stationOpen: st.status === 'OPEN',
              mode: 'fallback',
              arrivals: {},
              assessment: { ticksToStockout: null, hoursToStockout: null, probability: Math.max(0, Math.min(1, (0.4 - fill) / 0.4)), expectedDemand: 0, projectedMin: st.inventory[fuel] },
              forecast: { next: [], perTick: [], level: 1, cv: 0, confidence: 0, samples: 0, drift: false },
            };
          }),
        )
        .sort((a, b) => b.assessment.probability - a.assessment.probability);
    }
    const items = await this.forecast.assess(s);
    return items
      .map(({ arrivals, forecast, ...rest }) => ({
        ...rest,
        mode: 'model',
        arrivals: Object.fromEntries(arrivals),
        forecast: {
          ...forecast,
          next: forecast.perTick.slice(0, 8),
          level: forecast.level,
          cv: forecast.cv,
          confidence: forecast.confidence,
          samples: forecast.samples,
        },
      }))
      .sort((a, b) => b.assessment.probability - a.assessment.probability);
  }
}
