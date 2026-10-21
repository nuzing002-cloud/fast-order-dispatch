import { SqlDatabase, SqlExecutor } from './sql';

export class PgliteSqlDatabase implements SqlDatabase {
  private readonly database: import('@electric-sql/pglite').PGlite;

  constructor(dataDir?: string) {
    const { PGlite } = require('@electric-sql/pglite') as typeof import('@electric-sql/pglite');
    this.database = new PGlite(dataDir);
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[]
  ): Promise<T[]> {
    const result = await this.database.query<T>(text, params);
    return result.rows;
  }

  async exec(text: string): Promise<void> {
    await this.database.exec(text);
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.database.transaction(async (tx) =>
      fn({
        async query<R extends Record<string, unknown> = Record<string, unknown>>(
          text: string,
          params?: unknown[]
        ): Promise<R[]> {
          const result = await tx.query<R>(text, params);
          return result.rows;
        },
        async exec(text: string): Promise<void> {
          await tx.exec(text);
        }
      })
    );
  }

  async ping(): Promise<boolean> {
    try {
      await this.database.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.database.close();
  }
}
