import { createHash, timingSafeEqual } from 'crypto';
import { ValidationError } from './errors';

export type Role = 'admin' | 'operator' | 'viewer';

export const ROLES: readonly Role[] = ['admin', 'operator', 'viewer'];

export interface ApiKeyEntry {
  /** Raw secret, only kept in memory for startup parsing. */
  key: string;
  role: Role;
  label: string;
  /** Optional per-key request quota per rate-limit window. */
  limit?: number;
}

export type ApiKeyInput = string | ApiKeyEntry[] | undefined;
export type AuthenticatedKey = Omit<ApiKeyEntry, 'key'> & { keyId: string };

/**
 * Parse `API_KEYS` (`token:role[:limit]`) plus the legacy single `API_KEY`.
 * The legacy key is always treated as an admin key.
 */
export function parseApiKeys(apiKeysEnv?: string, legacyApiKey?: string): ApiKeyEntry[] {
  const entries: ApiKeyEntry[] = [];
  const seen = new Set<string>();

  const add = (entry: ApiKeyEntry): void => {
    if (seen.has(entry.key)) {
      throw new ValidationError('API keys must be unique');
    }
    seen.add(entry.key);
    entries.push(entry);
  };

  if (legacyApiKey && legacyApiKey.trim().length > 0) {
    add({ key: legacyApiKey.trim(), role: 'admin', label: 'api-key' });
  }

  if (apiKeysEnv && apiKeysEnv.trim().length > 0) {
    for (const rawEntry of apiKeysEnv.split(',')) {
      const raw = rawEntry.trim();
      if (raw.length === 0) continue;
      const parts = raw.split(':');
      if (parts.length < 2 || parts.length > 3) {
        throw new ValidationError('API_KEYS entries must use token:role[:limit]');
      }
      const [token, rawRole, rawLimit] = parts;
      if (!token || token.length > 255) {
        throw new ValidationError('API_KEYS tokens must be 1-255 characters');
      }
      if (!ROLES.includes(rawRole as Role)) {
        throw new ValidationError(`API_KEYS role must be one of: ${ROLES.join(', ')}`);
      }
      let limit: number | undefined;
      if (rawLimit !== undefined && rawLimit.length > 0) {
        limit = Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1) {
          throw new ValidationError('API_KEYS limit must be a positive integer');
        }
      }
      add({
        key: token,
        role: rawRole as Role,
        label: `key_${entries.length + 1}`,
        limit
      });
    }
  }

  return entries;
}

export function normalizeApiKeyInput(input: ApiKeyInput): ApiKeyEntry[] {
  if (input === undefined) return [];
  if (typeof input === 'string') {
    return input.trim().length > 0
      ? [{ key: input.trim(), role: 'admin', label: 'api-key' }]
      : [];
  }
  return input.map((entry, index) => ({
    ...entry,
    label: entry.label || `key_${index + 1}`
  }));
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export function authenticate(entries: ApiKeyEntry[], token: string): AuthenticatedKey | undefined {
  const candidate = hashToken(token);
  for (const entry of entries) {
    if (timingSafeEqual(candidate, hashToken(entry.key))) {
      return {
        keyId: hashToken(entry.key).toString('hex').slice(0, 16),
        role: entry.role,
        label: entry.label,
        limit: entry.limit
      };
    }
  }
  return undefined;
}

export function canWrite(role: Role): boolean {
  return role === 'admin' || role === 'operator';
}
