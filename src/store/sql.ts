import { Pool, PoolClient, PoolConfig } from 'pg';

export interface SqlExecutor {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[]
  ): Promise<T[]>;
  exec(text: string): Promise<void>;
}

export interface SqlDatabase extends SqlExecutor {
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export interface PostgresOptions {
  connectionString: string;
  max?: number;
  ssl?: PoolConfig['ssl'];
}

const RETRYABLE_CODES = new Set(['40001', '40P01']);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class PostgresSqlDatabase implements SqlDatabase {
  private readonly pool: Pool;

  constructor(options: PostgresOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.max ?? 10,
      ssl: options.ssl
    });
    this.pool.on('error', () => undefined);
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[]
  ): Promise<T[]> {
    const result = await this.pool.query(text, params);
    return result.rows as T[];
  }

  async exec(text: string): Promise<void> {
    await this.pool.query(text);
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const client = await this.pool.connect();
      let retry = false;
      try {
        await client.query('BEGIN');
        const result = await fn(executorFor(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        retry = attempt < 2 && RETRYABLE_CODES.has(errorCode(error) ?? '');
        if (!retry) throw error;
      } finally {
        client.release();
      }
      await delay(10 * (attempt + 1));
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function executorFor(client: PoolClient): SqlExecutor {
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params?: unknown[]
    ): Promise<T[]> {
      const result = await client.query(text, params);
      return result.rows as T[];
    },
    async exec(text: string): Promise<void> {
      await client.query(text);
    }
  };
}
