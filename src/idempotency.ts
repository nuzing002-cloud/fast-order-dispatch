import { createHash } from 'crypto';
import { NextFunction, Request, RequestHandler, Response } from 'express';
import { ValidationError } from './errors';

export interface IdempotencyRecord {
  key: string;
  fingerprint: string;
  status: number;
  body: unknown;
  createdAt: number;
}

export interface IdempotencyStore {
  getIdempotency(key: string): IdempotencyRecord | undefined;
  saveIdempotency(record: IdempotencyRecord): void;
}

export interface IdempotencyOptions {
  ttlMs?: number;
  timeoutMs?: number;
}

const APPLICABLE = [
  /^\/orders$/,
  /^\/orders\/[^/]+\/(?:pay|refund)$/,
  /^\/drivers$/,
  /^\/dispatch\/process$/
];

export const IDEMPOTENCY_HEADER = 'idempotency-key';

export function createIdempotencyMiddleware(
  store: IdempotencyStore,
  options: IdempotencyOptions = {}
): RequestHandler {
  const ttlMs = options.ttlMs ?? 86_400_000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pending = new Map<string, Promise<IdempotencyRecord>>();

  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    if (request.method !== 'POST' || !APPLICABLE.some((pattern) => pattern.test(request.path))) {
      next();
      return;
    }

    const key = request.header(IDEMPOTENCY_HEADER)?.trim();
    if (!key) {
      next();
      return;
    }

    // Scope keys per API identity so one client cannot replay another's response.
    const scopedKey = `${request.auth?.keyId ?? 'anonymous'}:${key}`;

    try {
      if (key.length > 255) {
        throw new ValidationError('Idempotency-Key must be at most 255 characters');
      }

      const fingerprint = fingerprintRequest(request);
      const existing = store.getIdempotency(scopedKey);
      if (existing && Date.now() - existing.createdAt <= ttlMs) {
        if (existing.fingerprint !== fingerprint) {
          response.status(409).json({
            error: 'Idempotency-Key was reused with a different request'
          });
          return;
        }
        replay(response, existing);
        return;
      }

      const inflight = pending.get(scopedKey);
      if (inflight) {
        const record = await withTimeout(inflight, timeoutMs);
        if (record.fingerprint !== fingerprint) {
          response.status(409).json({
            error: 'Idempotency-Key was reused with a different request'
          });
          return;
        }
        replay(response, record);
        return;
      }

      let resolveRecord: (record: IdempotencyRecord) => void = () => undefined;
      let rejectRecord: (error: Error) => void = () => undefined;
      const pendingRecord = new Promise<IdempotencyRecord>((resolve, reject) => {
        resolveRecord = resolve;
        rejectRecord = reject;
      });
      pending.set(scopedKey, pendingRecord);

      let captured: unknown;
      const originalJson = response.json.bind(response);
      response.json = ((body: unknown) => {
        captured = body;
        return originalJson(body);
      }) as Response['json'];

      const timer = setTimeout(() => {
        rejectRecord(new Error('Idempotent request timed out'));
        pending.delete(scopedKey);
      }, timeoutMs);
      timer.unref?.();

      response.once('finish', () => {
        clearTimeout(timer);
        const record: IdempotencyRecord = {
          key: scopedKey,
          fingerprint,
          status: response.statusCode,
          body: captured ?? null,
          createdAt: Date.now()
        };
        try {
          store.saveIdempotency(record);
          resolveRecord(record);
        } catch {
          rejectRecord(new Error('Failed to persist idempotency record'));
        } finally {
          pending.delete(scopedKey);
        }
      });

      next();
    } catch (error) {
      pending.delete(scopedKey);
      next(error);
    }
  };
}

function replay(response: Response, record: IdempotencyRecord): void {
  response.setHeader('Idempotent-Replayed', 'true');
  response.status(record.status).json(record.body);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Idempotent request timed out')), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function fingerprintRequest(request: Request): string {
  const payload = stableStringify({
    method: request.method,
    path: request.path,
    body: request.body ?? null
  });
  return createHash('sha256').update(payload).digest('hex');
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortValue(entry)]);
    return Object.fromEntries(entries);
  }
  return value;
}
