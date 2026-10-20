import dotenv from 'dotenv';
import { ApiKeyEntry, parseApiKeys } from './auth';
import { ValidationError } from './errors';
import { DISPATCH_DRIVER_ID } from './services/BatchProcessingService';

dotenv.config();

export type PaymentProviderName = 'mock' | 'http' | 'stripe';

export interface AppConfig {
  apiKey?: string;
  apiKeys: ApiKeyEntry[];
  rateLimitWindowMs: number;
  rateLimitMax: number;
  dispatchDriverIds: string[];
  trustProxy: boolean;
  idempotencyTtlMs: number;
  paymentProvider: PaymentProviderName;
  paymentGatewayUrl?: string;
  paymentGatewayApiKey?: string;
  paymentWebhookSecret?: string;
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  stripeApiBase?: string;
  redisUrl?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const apiKey = env.API_KEY?.trim() || undefined;
  const apiKeys = parseApiKeys(env.API_KEYS, apiKey);

  const rateLimitMax = integer(env.RATE_LIMIT_MAX, 0, 0, 'RATE_LIMIT_MAX');
  const rateLimitWindowMs = integer(env.RATE_LIMIT_WINDOW_MS, 60_000, 100, 'RATE_LIMIT_WINDOW_MS');

  const dispatchDriverIds = (env.DISPATCH_DRIVER_IDS ?? DISPATCH_DRIVER_ID)
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (dispatchDriverIds.length === 0) {
    throw new ValidationError('DISPATCH_DRIVER_IDS must contain at least one driver id');
  }

  const paymentProvider = (env.PAYMENT_PROVIDER ?? 'mock').trim().toLowerCase();
  if (!['mock', 'http', 'stripe'].includes(paymentProvider)) {
    throw new ValidationError('PAYMENT_PROVIDER must be one of: mock, http, stripe');
  }

  const paymentGatewayUrl = env.PAYMENT_GATEWAY_URL?.trim() || undefined;
  if (paymentProvider === 'http' && !paymentGatewayUrl) {
    throw new ValidationError('PAYMENT_GATEWAY_URL is required when PAYMENT_PROVIDER=http');
  }
  const stripeSecretKey = env.STRIPE_SECRET_KEY?.trim() || undefined;
  if (paymentProvider === 'stripe' && !stripeSecretKey) {
    throw new ValidationError('STRIPE_SECRET_KEY is required when PAYMENT_PROVIDER=stripe');
  }

  return {
    apiKey,
    apiKeys,
    rateLimitWindowMs,
    rateLimitMax,
    dispatchDriverIds,
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    idempotencyTtlMs: integer(env.IDEMPOTENCY_TTL_MS, 86_400_000, 1_000, 'IDEMPOTENCY_TTL_MS'),
    paymentProvider: paymentProvider as PaymentProviderName,
    paymentGatewayUrl,
    paymentGatewayApiKey: env.PAYMENT_GATEWAY_API_KEY?.trim() || undefined,
    paymentWebhookSecret: env.PAYMENT_WEBHOOK_SECRET?.trim() || undefined,
    stripeSecretKey,
    stripeWebhookSecret:
      env.STRIPE_WEBHOOK_SECRET?.trim() || env.PAYMENT_WEBHOOK_SECRET?.trim() || undefined,
    stripeApiBase: env.STRIPE_API_BASE?.trim() || undefined,
    redisUrl: env.REDIS_URL?.trim() || undefined
  };
}

function integer(
  value: string | undefined,
  fallback: number,
  minimum: number,
  field: string
): number {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new ValidationError(`${field} must be an integer of at least ${minimum}`);
  }
  return parsed;
}
