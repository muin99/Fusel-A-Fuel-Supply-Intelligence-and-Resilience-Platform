import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { ExplainService } from './explain.service.js';
const config = (key?: string) => new ConfigService({ GPT_API_KEY: key, OPENAI_MODEL: 'test-model' }) as ConfigService<Env, true>;
afterEach(() => vi.unstubAllGlobals());
describe('GPT grounding and fallback', () => {
  it('uses GPT_API_KEY and extracts Responses API output', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: 'Grounded finding' }] }] }) });
    vi.stubGlobal('fetch', fetchMock);
    const answer = await new ExplainService(config('test-secret')).complete('allocation constraints', () => 'fallback');
    expect(answer.source).toBe('llm');
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.store).toBe(false);
    expect(JSON.parse(request.input).retrievedEvidence.length).toBeGreaterThan(0);
  });
  it('falls back on rate limits without exposing provider error bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    const service = new ExplainService(config('test-secret'));
    expect((await service.complete('allocation', () => 'safe fallback')).text).toBe('safe fallback');
    expect(service.lastError).toBe('OpenAI HTTP 429');
  });
  it('works without credentials', async () => {
    expect((await new ExplainService(config()).complete('allocation', () => 'offline')).source).toBe('template');
  });
});
