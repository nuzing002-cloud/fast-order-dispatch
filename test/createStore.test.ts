import { AppConfig } from '../src/config';
import { createDispatchStore } from '../src/store/createStore';

const baseConfig: AppConfig = {
  nodeEnv: 'test',
  isProduction: false,
  corsOrigins: ['*'],
  databaseSsl: false,
  dbPoolMax: 2,
  apiKeys: [],
  rateLimitWindowMs: 60_000,
  rateLimitMax: 0,
  dispatchDriverIds: ['d1'],
  trustProxy: false,
  idempotencyTtlMs: 60_000,
  paymentProvider: 'mock'
};

describe('createDispatchStore', () => {
  test('falls back to the in-memory store without database configuration', async () => {
    const store = createDispatchStore(baseConfig);
    expect(store.kind).toBe('memory');
    await store.initialize();
    expect(await store.ping()).toBe(true);
    await store.close();
  });

  test('creates a PostgreSQL store from DATABASE_URL', async () => {
    const store = createDispatchStore({
      ...baseConfig,
      databaseUrl: 'postgres://user:pass@127.0.0.1:1/dispatch',
      databaseSsl: true,
      dbPoolMax: 3
    });
    expect(store.kind).toBe('postgres');
    await store.close();
  });
});
