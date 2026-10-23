import { loadConfig } from '../src/config';
import { DISPATCH_DRIVER_ID } from '../src/services/BatchProcessingService';

test('uses development defaults', () => {
  const config = loadConfig({});
  expect(config.apiKey).toBeUndefined();
  expect(config.rateLimitMax).toBe(0);
  expect(config.rateLimitWindowMs).toBe(60_000);
  expect(config.dispatchDriverIds).toEqual([DISPATCH_DRIVER_ID]);
  expect(config.dispatchBatchSize).toBe(4);
  expect(config.minDeliveryFee).toBe(28);
  expect(config.trustProxy).toBe(false);
  expect(config.databaseUrl).toBeUndefined();
  expect(config.dbPoolMax).toBe(10);
  expect(config.shopeeBridgeUrl).toBeUndefined();
  expect(config.shopeeBridgeWebhookSecret).toBeUndefined();
  expect(config.shopeeBridgeSyncMs).toBe(15_000);
  expect(config.shopeeBridgeTimeoutMs).toBe(5_000);
  expect(config.shopeeBridgeStaleMs).toBe(60_000);
});

test('parses configured values', () => {
  const config = loadConfig({
    API_KEY: ' secret ',
    RATE_LIMIT_MAX: '25',
    RATE_LIMIT_WINDOW_MS: '1000',
    DISPATCH_DRIVER_IDS: ' a, b ,, c',
    DISPATCH_BATCH_SIZE: '6',
    MIN_DELIVERY_FEE: '35',
    TRUST_PROXY: 'true',
    DATABASE_POOL_MAX: '4',
    DATABASE_SSL: 'true'
  });
  expect(config.apiKey).toBe('secret');
  expect(config.rateLimitMax).toBe(25);
  expect(config.rateLimitWindowMs).toBe(1000);
  expect(config.dispatchDriverIds).toEqual(['a', 'b', 'c']);
  expect(config.dispatchBatchSize).toBe(6);
  expect(config.minDeliveryFee).toBe(35);
  expect(config.trustProxy).toBe(true);
  expect(config.dbPoolMax).toBe(4);
  expect(config.databaseSsl).toBe(true);
});

test('parses Shopee bridge configuration', () => {
  const config = loadConfig({
    SHOPEE_BRIDGE_URL: 'http://127.0.0.1:4020/',
    SHOPEE_BRIDGE_WEBHOOK_SECRET: ' bridge-secret ',
    SHOPEE_BRIDGE_SYNC_MS: '20000',
    SHOPEE_BRIDGE_TIMEOUT_MS: '2500',
    SHOPEE_BRIDGE_STALE_MS: '90000'
  });
  expect(config.shopeeBridgeUrl).toBe('http://127.0.0.1:4020');
  expect(config.shopeeBridgeWebhookSecret).toBe('bridge-secret');
  expect(config.shopeeBridgeSyncMs).toBe(20_000);
  expect(config.shopeeBridgeTimeoutMs).toBe(2_500);
  expect(config.shopeeBridgeStaleMs).toBe(90_000);
});

test('rejects invalid Shopee bridge configuration', () => {
  expect(() => loadConfig({ SHOPEE_BRIDGE_URL: 'not-a-url' })).toThrow('SHOPEE_BRIDGE_URL');
  expect(() => loadConfig({ SHOPEE_BRIDGE_URL: 'ftp://127.0.0.1:4020' })).toThrow(
    'SHOPEE_BRIDGE_URL'
  );
  expect(() => loadConfig({ SHOPEE_BRIDGE_URL: 'http://user:pass@127.0.0.1:4020' })).toThrow(
    'SHOPEE_BRIDGE_URL'
  );
  expect(() => loadConfig({ SHOPEE_BRIDGE_URL: 'http://127.0.0.1:4020?secret=1' })).toThrow(
    'SHOPEE_BRIDGE_URL'
  );
  expect(() => loadConfig({ SHOPEE_BRIDGE_SYNC_MS: '500' })).toThrow('SHOPEE_BRIDGE_SYNC_MS');
  expect(() => loadConfig({ SHOPEE_BRIDGE_TIMEOUT_MS: '50' })).toThrow(
    'SHOPEE_BRIDGE_TIMEOUT_MS'
  );
  expect(() => loadConfig({ SHOPEE_BRIDGE_STALE_MS: '500' })).toThrow(
    'SHOPEE_BRIDGE_STALE_MS'
  );
});

test('rejects invalid configuration', () => {
  expect(() => loadConfig({ DATABASE_URL: 'mysql://db/dispatch' })).toThrow('DATABASE_URL');
  expect(() => loadConfig({ DATABASE_URL: 'not-a-url' })).toThrow('DATABASE_URL');
  expect(() =>
    loadConfig({
      DATABASE_URL: 'postgres://db/dispatch',
      PGLITE_DATA_DIR: './.pglite'
    })
  ).toThrow('either DATABASE_URL or PGLITE_DATA_DIR');
  expect(() => loadConfig({ RATE_LIMIT_MAX: 'many' })).toThrow('RATE_LIMIT_MAX');
  expect(() => loadConfig({ RATE_LIMIT_WINDOW_MS: '10' })).toThrow('RATE_LIMIT_WINDOW_MS');
  expect(() => loadConfig({ DISPATCH_DRIVER_IDS: ' , ' })).toThrow('DISPATCH_DRIVER_IDS');
  expect(() => loadConfig({ DISPATCH_BATCH_SIZE: '0' })).toThrow('DISPATCH_BATCH_SIZE');
  expect(() => loadConfig({ DISPATCH_BATCH_SIZE: '51' })).toThrow('DISPATCH_BATCH_SIZE');
});

test('allows wildcard CORS outside production', () => {
  expect(loadConfig({}).corsOrigins).toEqual(['*']);
  expect(loadConfig({ CORS_ORIGIN: '*' }).corsOrigins).toEqual(['*']);
});

test('normalizes explicit CORS origins', () => {
  const config = loadConfig({
    CORS_ORIGIN: 'https://orders.example.com, https://admin.example.com/'
  });
  expect(config.corsOrigins).toEqual(['https://orders.example.com', 'https://admin.example.com']);
});

test('rejects invalid CORS origins', () => {
  expect(() => loadConfig({ CORS_ORIGIN: 'not-a-url' })).toThrow('CORS_ORIGIN');
  expect(() => loadConfig({ CORS_ORIGIN: 'ftp://example.com' })).toThrow('CORS_ORIGIN');
  expect(() => loadConfig({ CORS_ORIGIN: 'https://example.com/path' })).toThrow('CORS_ORIGIN');
});

const productionEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  API_KEYS: 'production-token-0123456789:admin',
  RATE_LIMIT_MAX: '120',
  DISPATCH_DRIVER_IDS: 'driver-1',
  CORS_ORIGIN: 'https://orders.example.com',
  DATABASE_URL: 'postgres://dispatch:secret@db:5432/dispatch',
  REDIS_URL: 'redis://redis:6379',
  PAYMENT_PROVIDER: 'stripe',
  STRIPE_SECRET_KEY: 'sk_live_example',
  STRIPE_WEBHOOK_SECRET: 'whsec_example',
  VAPID_PUBLIC_KEY: 'BExampleVapidPublicKey012345678901234567890123456789012345678901',
  VAPID_PRIVATE_KEY: 'exampleVapidPrivateKey0123456789012345678901234'
};

test('accepts a hardened production configuration', () => {
  const config = loadConfig(productionEnv);
  expect(config.isProduction).toBe(true);
  expect(config.nodeEnv).toBe('production');
  expect(config.corsOrigins).toEqual(['https://orders.example.com']);
  expect(config.databaseUrl).toBe('postgres://dispatch:secret@db:5432/dispatch');
  expect(config.redisUrl).toBe('redis://redis:6379');
});

const unsafeProductionEnv: Array<[string, NodeJS.ProcessEnv, string]> = [
  ['missing api keys', { API_KEYS: undefined }, 'API_KEYS'],
  ['short api key', { API_KEYS: 'short:admin' }, 'at least 16 characters'],
  ['placeholder api key', { API_KEYS: 'replace-me-with-a-long-token:admin' }, 'placeholder'],
  ['wildcard cors', { CORS_ORIGIN: '*' }, 'CORS_ORIGIN'],
  ['missing cors', { CORS_ORIGIN: undefined }, 'CORS_ORIGIN'],
  ['disabled rate limit', { RATE_LIMIT_MAX: '0' }, 'RATE_LIMIT_MAX'],
  ['mock payment', { PAYMENT_PROVIDER: 'mock' }, 'PAYMENT_PROVIDER'],
  ['missing database url', { DATABASE_URL: undefined }, 'DATABASE_URL'],
  ['pglite in production', { PGLITE_DATA_DIR: './.pglite' }, 'PGLITE_DATA_DIR'],
  ['missing redis', { REDIS_URL: undefined }, 'REDIS_URL'],
  [
    'missing vapid keys',
    { VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined },
    'VAPID_PUBLIC_KEY'
  ],
  ['legacy sqlite path', { DB_PATH: './data/dispatch.sqlite3' }, 'DB_PATH'],
  ['missing stripe webhook secret', { STRIPE_WEBHOOK_SECRET: undefined }, 'STRIPE_WEBHOOK_SECRET'],
  [
    'missing http webhook secret',
    {
      PAYMENT_PROVIDER: 'http',
      PAYMENT_GATEWAY_URL: 'https://payments.example.com/charge',
      PAYMENT_WEBHOOK_SECRET: undefined
    },
    'PAYMENT_WEBHOOK_SECRET'
  ]
];

test.each(unsafeProductionEnv)('rejects unsafe production config: %s', (_name, env, message) => {
  expect(() => loadConfig({ ...productionEnv, ...env })).toThrow(message);
});
