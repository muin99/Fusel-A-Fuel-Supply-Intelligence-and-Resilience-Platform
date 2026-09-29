import type { RiskItem } from '../forecast/forecast.service.js';
import type { NetworkSnapshot } from '../state/state.types.js';
import { buildProblem, heuristicPolicy, lpPolicy, type Proposal } from '../decision/policies.js';

/** Forward projection, separate from the authoritative simulator. No state mutations. */
export function comparePolicies(s: NetworkSnapshot, risk: RiskItem[], multiplier = 1.5, delay = 2) {
  const problem = buildProblem(s, risk);
  const policies: Record<string, Proposal[]> = { no_action: [], heuristic: heuristicPolicy(problem), lp_optimizer: lpPolicy(problem) };
  const scenarios = [{ name: 'forecast_mean', multiplier: 1, delay: 0 }, { name: 'demand_stress', multiplier, delay: 0 }, { name: 'combined_stress', multiplier, delay }];
  const rows = [];
  for (const scenario of scenarios) for (const [policy, actions] of Object.entries(policies)) {
    let unmet = 0; let demand = 0; let stockouts = 0;
    for (const item of risk) {
      let inventory = item.inventory; let depleted = false;
      const arrivals = new Map(item.arrivals);
      for (const p of actions.filter((a) => a.stationId === item.stationId && a.fuel === item.fuel)) {
        const eta = p.transitTicks + 1 + scenario.delay;
        arrivals.set(eta, (arrivals.get(eta) ?? 0) + p.quantity);
      }
      item.forecast.perTick.forEach((mean, i) => {
        inventory = Math.min(item.capacity, inventory + (arrivals.get(i + 1) ?? 0));
        const d = mean * scenario.multiplier;
        const served = item.stationOpen ? Math.min(inventory, d) : 0;
        unmet += d - served; demand += d; inventory -= served;
        if (d > served) depleted = true;
      });
      if (depleted) stockouts++;
    }
    rows.push({ scenario: scenario.name, policy, expectedUnmetLiters: Math.round(unmet), serviceLevel: demand ? 1 - unmet / demand : 1,
      stationFuelStockouts: stockouts, allocatedLiters: actions.reduce((v, p) => v + p.quantity, 0) });
  }
  return { tick: s.instance.tick, horizonTicks: risk[0]?.forecast.perTick.length ?? 0, rows,
    assumptions: 'One allocation batch, fixed routes, expected demand with stress multipliers. Delay stress affects proposed shipments only. No future resupply decisions. Projections are not official simulator outcomes.', dispatched: false };
}
