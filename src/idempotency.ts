import { createHash } from 'crypto';
import { NextFunction, Request, RequestHandler, Response } from 'express';
import { ValidationError } from './errors';
import { logger } from './logger';

export interface IdempotencyRecord {
  key: string;
  fingerprint: string;
  /** 0 means the request is still in flight. */
  status: number;
  body: unknown;
  createdAt: number;
  expiresAt: number;
  /** Identifies the in-flight claim so a stale request cannot overwrite a newer one. */
  claimToken?: string;
}

export interface IdempotencyClaim {
  record: IdempotencyRecord;
  claimed: boolean;
}

export interface IdempotencyStore {
  getIdempotency(key: string): Promise<IdempotencyRecord | undefined>;
  claimIdempotency(
    key: string,
    fingerprint: string,
    now: number,
    expiresAt: number
  ): Promise<IdempotencyClaim>;
  completeIdempotency(record: IdempotencyRecord): Promise<void>;
  releaseIdempotency(key: string, claimToken?: string): Promise<void>;
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

const POLL_INTERVAL_MS = 50;

export const IDEMPOTENCY_HEADER = 'idempotency-key';

export function createIdempotencyMiddleware(
  store: IdempotencyStore,
  options: IdempotencyOptions = {}
): RequestHandler {
  const ttlMs = options.ttlMs ?? 86_400_000;
  const timeoutMs = options.timeoutMs ?? 30_000;

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
      const now = Date.now();
      const claim = await store.claimIdempotency(scopedKey, fingerprint, now, now + ttlMs);

      if (!claim.claimed) {
        if (claim.record.fingerprint !== fingerprint) {
          response.status(409).json({
            error: 'Idempotency-Key was reused with a different request'
          });
          return;
        }

        const record = await waitForCompletion(
          store,
          scopedKey,
          fingerprint,
          timeoutMs
        );
        if (!record) {
          response.status(409).json({
            error: 'Idempotency-Key is still being processed'
          });
          return;
        }
        replay(response, record);
        return;
      }

      const originalJson = response.json.bind(response);
      let persisted = false;
      response.json = ((body: unknown) => {
        if (persisted) return response;
        persisted = true;
        if (response.statusCode >= 500) {
          void store
            .releaseIdempotency(scopedKey, claim.record.claimToken)
            .catch(() => undefined);
          originalJson(body);
          return response;
        }
        const record: IdempotencyRecord = {
          key: scopedKey,
          fingerprint,
          status: response.statusCode,
          body,
          createdAt: Date.now(),
          expiresAt: Date.now() + ttlMs,
          claimToken: claim.record.claimToken
        };
        void store
          .completeIdempotency(record)
          .catch((error) => {
            logger.error('idempotency_persist_failed', {
              error: error instanceof Error ? error.message : String(error)
            });
            return store
              .releaseIdempotency(scopedKey, claim.record.claimToken)
              .catch(() => undefined);
          })
          .finally(() => {
            originalJson(body);
          });
        return response;
      }) as Response['json'];

      response.once('close', () => {
        if (persisted) return;
        void store
          .releaseIdempotency(scopedKey, claim.record.claimToken)
          .catch(() => undefined);
      });

      next();
    } catch (error) {
      next(error);
    }
  };
}

async function waitForCompletion(
  store: IdempotencyStore,
  key: string,
  fingerprint: string,
  timeoutMs: number
): Promise<IdempotencyRecord | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = await store.getIdempotency(key);
    if (record && record.status !== 0) {
      return record.fingerprint === fingerprint ? record : undefined;
    }
    await delay(POLL_INTERVAL_MS);
  }
  return undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function replay(response: Response, record: IdempotencyRecord): void {
  response.setHeader('Idempotent-Replayed', 'true');
  response.status(record.status).json(record.body);
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
