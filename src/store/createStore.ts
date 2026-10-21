import { AppConfig } from '../config';
import { DispatchStore, MemoryDispatchStore } from './DispatchStore';
import { PostgresDispatchStore } from './PostgresDispatchStore';
import { PgliteSqlDatabase } from './pglite';
import { PostgresSqlDatabase } from './sql';

export function createDispatchStore(config: AppConfig): DispatchStore {
  if (config.databaseUrl) {
    return new PostgresDispatchStore(
      new PostgresSqlDatabase({
        connectionString: config.databaseUrl,
        max: config.dbPoolMax,
        ssl: config.databaseSsl ? true : undefined
      }),
      'postgres'
    );
  }
  if (config.pglitePath) {
    return new PostgresDispatchStore(new PgliteSqlDatabase(config.pglitePath), 'pglite');
  }
  return new MemoryDispatchStore();
}
