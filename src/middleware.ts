import { randomUUID } from 'crypto';
import { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  ApiKeyInput,
  authenticate,
  AuthenticatedKey,
  normalizeApiKeyInput,
  Role
} from './auth';
import { logger } from './logger';

export const PUBLIC_PATHS = new Set([
  '/health',
  '/ready',
  '/openapi.json',
  '/docs',
  '/webhooks/payments'
]);

export function extractToken(request: Request): string | undefined {
  const header = request.header('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const apiKeyHeader = request.header('x-api-key');
  return apiKeyHeader?.trim() || undefined;
}

export function createAuthMiddleware(input: ApiKeyInput): RequestHandler {
  const entries = normalizeApiKeyInput(input);

  return (request: Request, response: Response, next: NextFunction) => {
    if (entries.length === 0 || PUBLIC_PATHS.has(request.path)) {
      next();
      return;
    }

    const token = extractToken(request);
    const identity: AuthenticatedKey | undefined = token
      ? authenticate(entries, token)
      : undefined;
    if (!identity) {
      response.status(401).json({ error: 'Unauthorized' });
      return;
    }

    request.auth = identity;
    if (identity.role === 'viewer' && !isReadMethod(request.method)) {
      response.status(403).json({ error: 'This API key is read-only' });
      return;
    }
    next();
  };
}

export function requireRole(...roles: Role[]): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    if (!request.auth) {
      next();
      return;
    }
    if (!roles.includes(request.auth.role)) {
      response.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
      return;
    }
    next();
  };
}

function isReadMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
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

    const max = request.auth?.limit ?? options.max;
    const now = Date.now();
    const key = rateLimitKey(request);
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + options.windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    response.setHeader('X-RateLimit-Limit', String(max));
    response.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    response.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > max) {
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

export function rateLimitKey(request: Request): string {
  const ip = request.ip ?? 'unknown';
  return request.auth ? `${ip}:${request.auth.keyId}` : ip;
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
        ip: request.ip,
        actor: request.auth?.label,
        role: request.auth?.role
      });
    });

    next();
  };
}
