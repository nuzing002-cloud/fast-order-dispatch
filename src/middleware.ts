import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { NextFunction, Request, RequestHandler, Response } from 'express';
import { logger } from './logger';

const PUBLIC_PATHS = new Set(['/health', '/ready', '/openapi.json', '/docs']);

function safeEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function extractToken(request: Request): string | undefined {
  const header = request.header('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const apiKeyHeader = request.header('x-api-key');
  return apiKeyHeader?.trim() || undefined;
}

export function createAuthMiddleware(apiKey?: string): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    if (!apiKey || PUBLIC_PATHS.has(request.path)) {
      next();
      return;
    }
    const token = extractToken(request);
    if (!token || !safeEqual(token, apiKey)) {
      response.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
}

export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (request: Request, response: Response, next: NextFunction) => {
    if (options.max <= 0 || PUBLIC_PATHS.has(request.path)) {
      next();
      return;
    }

    const now = Date.now();
    const key = request.ip ?? 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + options.windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    response.setHeader('X-RateLimit-Limit', String(options.max));
    response.setHeader('X-RateLimit-Remaining', String(Math.max(0, options.max - entry.count)));
    response.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > options.max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      response.setHeader('Retry-After', String(retryAfter));
      response.status(429).json({ error: 'Too many requests' });
      return;
    }

    if (hits.size > 10_000) {
      for (const [key2, value] of hits) {
        if (value.resetAt <= now) hits.delete(key2);
      }
    }

    next();
  };
}

export function securityHeaders(): RequestHandler {
  return (_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    next();
  };
}

export interface RequestWithId extends Request {
  requestId?: string;
}

export function requestLogger(): RequestHandler {
  return (request: RequestWithId, response: Response, next: NextFunction) => {
    const header = request.header('x-request-id');
    const requestId = header && header.length > 0 ? header : randomUUID();
    request.requestId = requestId;
    response.setHeader('X-Request-Id', requestId);

    const startedAt = process.hrtime.bigint();
    response.on('finish', () => {
      if (PUBLIC_PATHS.has(request.path)) return;
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      logger.info('request', {
        requestId,
        method: request.method,
        path: request.originalUrl,
        status: response.statusCode,
        durationMs: Number(durationMs.toFixed(1)),
        ip: request.ip
      });
    });

    next();
  };
}
