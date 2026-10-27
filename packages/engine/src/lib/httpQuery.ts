import { z } from 'zod';
import type { Context } from 'hono';
import { parseQueryParams } from './httpResponse.js';

interface PositiveIntQueryOptions {
  defaultValue?: number;
  max?: number;
}

export function positiveIntQueryParam(options: PositiveIntQueryOptions = {}) {
  const numberSchema = options.max === undefined
    ? z.number().int().positive()
    : z.number().int().positive().max(options.max);
  if (options.defaultValue !== undefined) {
    numberSchema.parse(options.defaultValue);
  }
  const valueSchema = options.defaultValue === undefined
    ? numberSchema.optional()
    : numberSchema.default(options.defaultValue);

  return z.preprocess(
    (value) => {
      if (value === undefined || (typeof value === 'string' && value.trim() === '')) {
        return undefined;
      }
      return Number(value);
    },
    valueSchema,
  );
}

const optionalPositiveInt = positiveIntQueryParam();

export const PaginationQuerySchema = z.object({
  limit: optionalPositiveInt,
  before: z.string().optional(),
  after: z.string().optional(),
});

export const LimitQuerySchema = z.object({
  limit: optionalPositiveInt,
});

export function parsePaginationQuery(c: Context, invalidMessage = 'Invalid pagination query') {
  return parseQueryParams(c, PaginationQuerySchema, invalidMessage);
}
