import { retrieve } from './retrieval.js';
describe('organizer evidence retrieval', () => {
  it('retrieves exact source references for idempotency', () => {
    const results = retrieve('idempotency_key IDEMPOTENCY_KEY_MISMATCH');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.text.includes('IDEMPOTENCY_KEY_MISMATCH'))).toBe(true);
    expect(results.every((r) => (r.line ?? 0) > 0 && r.id.includes(r.source))).toBe(true);
  });
  it('does not invent evidence for an unknown token', () => { expect(retrieve('zzzxq987654')).toEqual([]); });
});
