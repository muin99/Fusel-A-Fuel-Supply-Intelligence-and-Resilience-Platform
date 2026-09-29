/** Normalised simulator failure. `code` is the simulator's UPPER_SNAKE code when available. */
export class SimulatorError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'SimulatorError';
  }
}

/** Extracts `{detail:{code}}` (domain errors) or `{error:{code}}` (injected faults). */
export function extractCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, any>;
  if (b.detail && typeof b.detail === 'object' && !Array.isArray(b.detail)) return b.detail.code;
  if (Array.isArray(b.detail)) return 'VALIDATION_ERROR';
  if (b.error && typeof b.error === 'object') return b.error.code;
  return undefined;
}
