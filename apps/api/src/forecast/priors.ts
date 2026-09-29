import type { FuelType } from '../simulator/simulator.schemas.js';

/**
 * Domain priors published in the integration guide §8.5–8.6.
 * Used for cold start (no history yet) and as the seasonal shape the learned model scales.
 * Documented as "derived data" per problem statement §16.
 */
export const DAILY_DEMAND: Record<string, Record<FuelType, number>> = {
  urban_high: { DIESEL: 8500, PETROL: 10500, OCTANE: 5600 },
  industrial: { DIESEL: 14000, PETROL: 4500, OCTANE: 2200 },
  highway: { DIESEL: 10500, PETROL: 11000, OCTANE: 6200 },
  regional: { DIESEL: 7200, PETROL: 7600, OCTANE: 3600 },
};

export const NOISE: Record<string, number> = { urban_high: 0.1, industrial: 0.08, highway: 0.12, regional: 0.1 };

export function hourFactor(profile: string, hour: number): number {
  switch (profile) {
    case 'industrial':
      return hour >= 6 && hour < 18 ? 1.55 : 0.45;
    case 'highway':
      return (hour >= 6 && hour < 10) || (hour >= 16 && hour < 21) ? 1.35 : 0.75;
    case 'urban_high':
      return (hour >= 7 && hour < 10) || (hour >= 16 && hour < 21) ? 1.45 : 0.7;
    case 'regional':
      return hour >= 7 && hour < 21 ? 1.25 : 0.65;
    default:
      return 1;
  }
}
