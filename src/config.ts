import dotenv from 'dotenv';
import { DISPATCH_DRIVER_ID } from './services/BatchProcessingService';
import { ValidationError } from './errors';

dotenv.config();

export interface AppConfig {
  apiKey?: string;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  dispatchDriverIds: string[];
  trustProxy: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const apiKey = env.API_KEY?.trim() || undefined;

  const rateLimitMax = Number(env.RATE_LIMIT_MAX ?? 0);
  const rateLimitWindowMs = Number(env.RATE_LIMIT_WINDOW_MS ?? 60_000);
  if (!Number.isInteger(rateLimitMax) || rateLimitMax < 0) {
    throw new ValidationError('RATE_LIMIT_MAX must be a non-negative integer');
  }
  if (!Number.isInteger(rateLimitWindowMs) || rateLimitWindowMs < 100) {
    throw new ValidationError('RATE_LIMIT_WINDOW_MS must be an integer of at least 100');
  }

  const dispatchDriverIds = (env.DISPATCH_DRIVER_IDS ?? DISPATCH_DRIVER_ID)
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (dispatchDriverIds.length === 0) {
    throw new ValidationError('DISPATCH_DRIVER_IDS must contain at least one driver id');
  }

  return {
    apiKey,
    rateLimitWindowMs,
    rateLimitMax,
    dispatchDriverIds,
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true'
  };
}
