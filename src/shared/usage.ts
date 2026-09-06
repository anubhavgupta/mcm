import { z } from 'zod';
import type { UsageTotals } from './types';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const usageTotalsSchema = z.object({
  inputTokens: count,
  outputTokens: count,
  costUsd: z.number().finite().min(0).nullable(),
  unpricedTokens: count,
  requestCount: count,
  missingUsageRequests: count,
});
export const usageSummarySchema = z.object({
  allTime: usageTotalsSchema,
  session: usageTotalsSchema,
  sessionId: z.string(),
  sessionStartedAt: z.string(),
  trackingStartedAt: z.string(),
  error: z.string().optional(),
});

export function emptyUsageTotals(): UsageTotals {
  return {
    inputTokens: 0, outputTokens: 0, costUsd: null, unpricedTokens: 0,
    requestCount: 0, missingUsageRequests: 0,
  };
}
