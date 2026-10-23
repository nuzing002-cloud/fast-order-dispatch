import dotenv from 'dotenv';
import { ApiKeyEntry, parseApiKeys } from './auth';
import { ValidationError } from './errors';
import { DISPATCH_DRIVER_ID } from './services/BatchProcessingService';

dotenv.config();

export type PaymentProviderName = 'mock' | 'http' | 'stripe';

export interface AppConfig {
  nodeEnv: string;
  isProduction: boolean;
  corsOrigins: string[];
  databaseUrl?: string;
  databaseSsl: boolean;
  dbPoolMax: number;
  pglitePath?: string;
  apiKey?: string;
  apiKeys: ApiKeyEntry[];
  rateLimitWindowMs: number;
  rateLimitMax: number;
  dispatchDriverIds: string[];
  dispatchBatchSize: number;
  minDeliveryFee: number;
  driverSharePercent: number;
  trustProxy: boolean;
  idempotencyTtlMs: number;
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  vapidSubject?: string;
  paymentProvider: PaymentProviderName;
  paymentGatewayUrl?: string;
  paymentGatewayApiKey?: string;
  paymentWebhookSecret?: string;
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  stripeApiBase?: string;
  redisUrl?: string;
  shopeeBridgeUrl?: string;
  shopeeBridgeWebhookSecret?: string;
  shopeeBridgeSyncMs: number;
  shopeeBridgeTimeoutMs: number;
  shopeeBridgeStaleMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = (env.NODE_ENV ?? 'development').trim().toLowerCase() || 'development';
  const isProduction = nodeEnv === 'production';
  const corsOrigins = parseCorsOrigins(env.CORS_ORIGIN, isProduction);
  const databaseUrl = parseDatabaseUrl(env.DATABASE_URL);
  const pglitePath = env.PGLITE_DATA_DIR?.trim() || undefined;
  if (databaseUrl && pglitePath) {
    throw new ValidationError('Set either DATABASE_URL or PGLITE_DATA_DIR, not both');
  }
  if (env.DB_PATH?.trim()) {
    throw new ValidationError(
      'DB_PATH is no longer supported; use DATABASE_URL for PostgreSQL or PGLITE_DATA_DIR for local development'
    );
  }
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
  const dispatchBatchSize = integer(env.DISPATCH_BATCH_SIZE, 4, 1, 'DISPATCH_BATCH_SIZE');
  if (dispatchBatchSize > 50) {
    throw new ValidationError('DISPATCH_BATCH_SIZE must be at most 50');
  }
  const minDeliveryFee = boundedNumber(
    env.MIN_DELIVERY_FEE,
    28,
    0,
    10_000,
    'MIN_DELIVERY_FEE'
  );

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

  const config: AppConfig = {
    nodeEnv,
    isProduction,
    corsOrigins,
    databaseUrl,
    databaseSsl: env.DATABASE_SSL === '1' || env.DATABASE_SSL === 'true',
    dbPoolMax: integer(env.DATABASE_POOL_MAX, 10, 1, 'DATABASE_POOL_MAX'),
    pglitePath,
    apiKey,
    apiKeys,
    rateLimitWindowMs,
    rateLimitMax,
    dispatchDriverIds,
    dispatchBatchSize,
    minDeliveryFee,
    driverSharePercent: boundedNumber(env.DRIVER_SHARE_PERCENT, 80, 0, 100, 'DRIVER_SHARE_PERCENT'),
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    idempotencyTtlMs: integer(env.IDEMPOTENCY_TTL_MS, 86_400_000, 1_000, 'IDEMPOTENCY_TTL_MS'),
    vapidPublicKey: env.VAPID_PUBLIC_KEY?.trim() || undefined,
    vapidPrivateKey: env.VAPID_PRIVATE_KEY?.trim() || undefined,
    vapidSubject: env.VAPID_SUBJECT?.trim() || undefined,
    paymentProvider: paymentProvider as PaymentProviderName,
    paymentGatewayUrl,
    paymentGatewayApiKey: env.PAYMENT_GATEWAY_API_KEY?.trim() || undefined,
    paymentWebhookSecret: env.PAYMENT_WEBHOOK_SECRET?.trim() || undefined,
    stripeSecretKey,
    stripeWebhookSecret:
      env.STRIPE_WEBHOOK_SECRET?.trim() || env.PAYMENT_WEBHOOK_SECRET?.trim() || undefined,
    stripeApiBase: env.STRIPE_API_BASE?.trim() || undefined,
    redisUrl: env.REDIS_URL?.trim() || undefined,
    shopeeBridgeUrl: parseShopeeBridgeUrl(env.SHOPEE_BRIDGE_URL),
    shopeeBridgeWebhookSecret: env.SHOPEE_BRIDGE_WEBHOOK_SECRET?.trim() || undefined,
    shopeeBridgeSyncMs: integer(
      env.SHOPEE_BRIDGE_SYNC_MS,
      15_000,
      1_000,
      'SHOPEE_BRIDGE_SYNC_MS'
    ),
    shopeeBridgeTimeoutMs: integer(
      env.SHOPEE_BRIDGE_TIMEOUT_MS,
      5_000,
      100,
      'SHOPEE_BRIDGE_TIMEOUT_MS'
    ),
    shopeeBridgeStaleMs: integer(
      env.SHOPEE_BRIDGE_STALE_MS,
      60_000,
      1_000,
      'SHOPEE_BRIDGE_STALE_MS'
    )
  };

  validateProductionConfig(config);

  return config;
}

function parseCorsOrigins(value: string | undefined, isProduction: boolean): string[] {
  const raw = value?.trim();
  if (!raw) {
    if (isProduction) {
      throw new ValidationError('CORS_ORIGIN is required when NODE_ENV=production');
    }
    return ['*'];
  }

  const origins = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (origins.length === 0) {
    throw new ValidationError('CORS_ORIGIN must contain at least one origin');
  }
  if (origins.includes('*')) {
    if (isProduction) {
      throw new ValidationError('CORS_ORIGIN must not contain "*" when NODE_ENV=production');
    }
    return ['*'];
  }

  return [...new Set(origins.map(validateOrigin))];
}

function validateOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new ValidationError(`CORS_ORIGIN entry is not a valid URL: ${origin}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError(`CORS_ORIGIN entry must use http or https: ${origin}`);
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new ValidationError(
      `CORS_ORIGIN entry must be an origin without path, query, or credentials: ${origin}`
    );
  }

  return url.origin;
}

function validateProductionConfig(config: AppConfig): void {
  if (!config.isProduction) return;

  if (config.apiKeys.length === 0) {
    throw new ValidationError('API_KEYS or API_KEY is required when NODE_ENV=production');
  }
  for (const entry of config.apiKeys) {
    if (entry.key.length < 16) {
      throw new ValidationError('API keys must be at least 16 characters when NODE_ENV=production');
    }
    if (/change[-_]?me|replace[-_]?me/i.test(entry.key)) {
      throw new ValidationError(
        'API keys must not use placeholder values when NODE_ENV=production'
      );
    }
  }

  if (config.rateLimitMax <= 0) {
    throw new ValidationError('RATE_LIMIT_MAX must be greater than 0 when NODE_ENV=production');
  }
  if (config.paymentProvider === 'mock') {
    throw new ValidationError(
      'PAYMENT_PROVIDER must be http or stripe when NODE_ENV=production'
    );
  }
  if (config.paymentProvider === 'http' && !config.paymentWebhookSecret) {
    throw new ValidationError(
      'PAYMENT_WEBHOOK_SECRET is required when PAYMENT_PROVIDER=http and NODE_ENV=production'
    );
  }
  if (config.paymentProvider === 'stripe' && !config.stripeWebhookSecret) {
    throw new ValidationError(
      'STRIPE_WEBHOOK_SECRET (or PAYMENT_WEBHOOK_SECRET) is required when PAYMENT_PROVIDER=stripe and NODE_ENV=production'
    );
  }
  if (!config.databaseUrl) {
    throw new ValidationError('DATABASE_URL is required when NODE_ENV=production');
  }
  if (config.pglitePath) {
    throw new ValidationError('PGLITE_DATA_DIR must not be used when NODE_ENV=production');
  }
  if (!config.redisUrl) {
    throw new ValidationError('REDIS_URL is required when NODE_ENV=production');
  }
  if (!config.vapidPublicKey || !config.vapidPrivateKey) {
    throw new ValidationError(
      'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are required when NODE_ENV=production'
    );
  }
}

function parseShopeeBridgeUrl(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError('SHOPEE_BRIDGE_URL must be a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError('SHOPEE_BRIDGE_URL must use http or https');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ValidationError(
      'SHOPEE_BRIDGE_URL must not include credentials, query, or hash'
    );
  }
  return raw.replace(/\/$/, '');
}

function parseDatabaseUrl(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError('DATABASE_URL must be a valid PostgreSQL connection string');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new ValidationError('DATABASE_URL must use the postgres or postgresql protocol');
  }
  return raw;
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

function boundedNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string
): number {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new ValidationError(`${field} must be a number between ${minimum} and ${maximum}`);
  }
  return parsed;
}
