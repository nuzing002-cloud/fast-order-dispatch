import { loadConfig } from '../src/config';
import { DISPATCH_DRIVER_ID } from '../src/services/BatchProcessingService';

test('uses development defaults', () => {
  const config = loadConfig({});
  expect(config.apiKey).toBeUndefined();
  expect(config.rateLimitMax).toBe(0);
  expect(config.rateLimitWindowMs).toBe(60_000);
  expect(config.dispatchDriverIds).toEqual([DISPATCH_DRIVER_ID]);
  expect(config.trustProxy).toBe(false);
});

test('parses configured values', () => {
  const config = loadConfig({
    API_KEY: ' secret ',
    RATE_LIMIT_MAX: '25',
    RATE_LIMIT_WINDOW_MS: '1000',
    DISPATCH_DRIVER_IDS: ' a, b ,, c',
    TRUST_PROXY: 'true'
  });
  expect(config.apiKey).toBe('secret');
  expect(config.rateLimitMax).toBe(25);
  expect(config.rateLimitWindowMs).toBe(1000);
  expect(config.dispatchDriverIds).toEqual(['a', 'b', 'c']);
  expect(config.trustProxy).toBe(true);
});

test('rejects invalid configuration', () => {
  expect(() => loadConfig({ RATE_LIMIT_MAX: 'many' })).toThrow('RATE_LIMIT_MAX');
  expect(() => loadConfig({ RATE_LIMIT_WINDOW_MS: '10' })).toThrow('RATE_LIMIT_WINDOW_MS');
  expect(() => loadConfig({ DISPATCH_DRIVER_IDS: ' , ' })).toThrow('DISPATCH_DRIVER_IDS');
});
