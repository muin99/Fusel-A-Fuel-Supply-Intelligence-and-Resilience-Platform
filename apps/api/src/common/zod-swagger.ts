import { applyDecorators } from '@nestjs/common';
import { ApiBody } from '@nestjs/swagger';
import { z } from 'zod';

type SchemaObject = NonNullable<Extract<Parameters<typeof ApiBody>[0], { schema?: unknown }>['schema']>;

/**
 * Documents a request body from the SAME Zod schema that validates it,
 * so Swagger can never drift from the real contract.
 */
export function ZodBody(schema: z.ZodType, example?: unknown) {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete json.$schema;
  return applyDecorators(ApiBody({ schema: { ...(json as SchemaObject), ...(example ? { example } : {}) } }));
}
