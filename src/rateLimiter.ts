import { NextFunction, Request, RequestHandler, Response } from 'express';
import { logger } from './logger';
import { createRateLimiter, PUBLIC_PATHS, rateLimitKey } from './middleware';

export interface RedisRateLimiterOptions {
  url: string;
  windowMs: number;
  max: number;
  prefix?: string;
}

export interface RateLimiterHandle {
  middleware: RequestHandler;
  close(): Promise<void>;
}

interface RedisLimiterClient {
  incr(key: string): Promise<number>;
  pExpire(key: string, milliseconds: number): Promise<boolean>;
  pTTL(key: string): Promise<number>;
  quit(): Promise<string>;
  connect(): Promise<unknown>;
  on(event: string, listener: (error: Error) => void): unknown;
}

/**
 * Fixed-window rate limiter backed by Redis so multiple service instances share
 * the same counters. Falls back to the in-process limiter if Redis is down.
 */
export function createRedisRateLimiter(options: RedisRateLimiterOptions): RateLimiterHandle {
  const fallback = createRateLimiter({ windowMs: options.windowMs, max: options.max });
  const prefix = options.prefix ?? 'fast-order-dispatch:ratelimit';
  let client: RedisLimiterClient | undefined;
  let connecting: Promise<unknown> | undefined;

  const getClient = async (): Promise<RedisLimiterClient> => {
    if (!client) {
      const { createClient } = require('redis') as typeof import('redis');
      const created = createClient({
        url: options.url,
        socket: { reconnectStrategy: (retries: number) => Math.min(retries * 200, 2_000) }
      }) as unknown as RedisLimiterClient;
      created.on('error', (error: Error) => {
        logger.warn('redis_rate_limit_error', { error: error.message });
      });
      client = created;
    }
    if (!connecting) {
      const timeout = new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Redis rate limiter connection timed out')),
          500
        );
        timer.unref?.();
      });
      connecting = Promise.race([client.connect(), timeout]).catch((error) => {
        connecting = undefined;
        throw error;
      });
    }
    await connecting;
    return client;
  };

  const middleware = async (
    request: Request,
    response: Response,
    next: NextFunction
  ): Promise<void> => {
    if (options.max <= 0 || PUBLIC_PATHS.has(request.path)) {
      next();
      return;
    }

    try {
      const redis = await getClient();
      const max = request.auth?.limit ?? options.max;
      const key = `${prefix}:${rateLimitKey(request)}`;
      const count = await redis.incr(key);
      if (count === 1) await redis.pExpire(key, options.windowMs);
      let ttl = await redis.pTTL(key);
      if (ttl < 0) {
        await redis.pExpire(key, options.windowMs);
        ttl = options.windowMs;
      }

      const resetAt = Math.ceil((Date.now() + ttl) / 1000);
      response.setHeader('X-RateLimit-Limit', String(max));
      response.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - count)));
      response.setHeader('X-RateLimit-Reset', String(resetAt));

      if (count > max) {
        const retryAfter = Math.max(1, Math.ceil(ttl / 1000));
        response.setHeader('Retry-After', String(retryAfter));
        response.status(429).json({ error: 'Too many requests' });
        return;
      }

      next();
    } catch (error) {
      logger.warn('redis_rate_limit_fallback', {
        error: error instanceof Error ? error.message : String(error)
      });
      fallback(request, response, next);
    }
  };

  return {
    middleware,
    async close(): Promise<void> {
      if (!client) return;
      try {
        await client.quit();
      } catch {
        // ignore shutdown errors
      }
      client = undefined;
      connecting = undefined;
    }
  };
}
