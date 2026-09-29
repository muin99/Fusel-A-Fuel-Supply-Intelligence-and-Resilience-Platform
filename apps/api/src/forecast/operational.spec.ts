import fixtures from './operational-fixtures.json' with { type: 'json' };
import { inventoryFeatures, operationalInfo, predict, type TaskKey } from './operational.js';

describe('operational ML models (TypeScript inference matches scikit-learn)', () => {
  it('loads all five tasks', () => {
    const info = operationalInfo();
    expect(info.available).toBe(true);
    expect(Object.keys(info.tasks).sort()).toEqual(['depot_runway', 'network_runway', 'stockout_probability', 'stockout_time', 'transport_delay']);
  });
  it('reproduces the exported fixtures', () => {
    for (const f of fixtures as { task: TaskKey; features: number[]; expected: number }[]) expect(predict(f.task, f.features)).toBeCloseTo(f.expected, 4);
  });
  it('an empty tank with no deliveries is high risk; a full tank is low risk', () => {
    const f = Array(24).fill(100);
    const empty = predict('stockout_probability', inventoryFeatures(50, f, Array(24).fill(0), 0.1));
    const full = predict('stockout_probability', inventoryFeatures(20000, f, Array(24).fill(0), 0.1));
    expect(empty).toBeGreaterThan(0.8);
    expect(full).toBeLessThan(0.2);
  });
});
