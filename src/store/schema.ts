import { SqlDatabase } from './sql';

interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS orders (
        id text PRIMARY KEY,
        order_id text NOT NULL,
        status text NOT NULL,
        payment_status text NOT NULL,
        queued_at timestamptz,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        assigned_driver_id text,
        assigned_at timestamptz,
        delivered_at timestamptz,
        total_amount numeric NOT NULL DEFAULT 0,
        data jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS orders_queue_idx
        ON orders (queued_at, created_at)
        WHERE status = 'PENDING' AND queued_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS orders_driver_idx
        ON orders (assigned_driver_id)
        WHERE assigned_driver_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS drivers (
        id text PRIMARY KEY,
        status text NOT NULL,
        is_available boolean NOT NULL,
        max_orders_per_batch integer NOT NULL,
        data jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS drivers_available_idx
        ON drivers (status, is_available);

      CREATE TABLE IF NOT EXISTS batches (
        id text PRIMARY KEY,
        driver_id text NOT NULL,
        order_ids jsonb NOT NULL,
        created_at timestamptz NOT NULL,
        completed_at timestamptz,
        data jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS batches_driver_idx ON batches (driver_id);

      CREATE TABLE IF NOT EXISTS batch_orders (
        batch_id text NOT NULL REFERENCES batches (id) ON DELETE CASCADE,
        order_id text NOT NULL,
        position integer NOT NULL,
        PRIMARY KEY (batch_id, order_id)
      );
      CREATE INDEX IF NOT EXISTS batch_orders_order_idx ON batch_orders (order_id);

      CREATE TABLE IF NOT EXISTS payments (
        id text PRIMARY KEY,
        order_id text NOT NULL,
        provider_transaction_id text,
        created_at timestamptz NOT NULL,
        data jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS payments_order_idx ON payments (order_id);
      CREATE INDEX IF NOT EXISTS payments_provider_idx
        ON payments (provider_transaction_id)
        WHERE provider_transaction_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS audits (
        id text PRIMARY KEY,
        timestamp timestamptz NOT NULL,
        data jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audits_timestamp_idx ON audits (timestamp);

      CREATE TABLE IF NOT EXISTS idempotency (
        key text PRIMARY KEY,
        fingerprint text NOT NULL,
        claim_token text,
        status integer NOT NULL,
        body jsonb,
        created_at bigint NOT NULL,
        expires_at bigint NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idempotency_expiry_idx ON idempotency (expires_at);
    `
  },
  {
    version: 2,
    sql: `
      ALTER TABLE idempotency ADD COLUMN IF NOT EXISTS claim_token text;
    `
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS driver_earnings (
        id text PRIMARY KEY,
        driver_id text NOT NULL,
        order_id text NOT NULL UNIQUE,
        status text NOT NULL,
        amount numeric NOT NULL,
        created_at timestamptz NOT NULL,
        paid_at timestamptz,
        payout_id text,
        data jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS driver_earnings_driver_idx
        ON driver_earnings (driver_id, status, created_at);

      CREATE TABLE IF NOT EXISTS payouts (
        id text PRIMARY KEY,
        driver_id text NOT NULL,
        status text NOT NULL,
        amount numeric NOT NULL,
        created_at timestamptz NOT NULL,
        paid_at timestamptz,
        data jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS payouts_driver_idx ON payouts (driver_id, created_at);

      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint text PRIMARY KEY,
        driver_id text NOT NULL,
        created_at timestamptz NOT NULL,
        data jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS push_subscriptions_driver_idx
        ON push_subscriptions (driver_id);
    `
  }
];

export async function applyMigrations(database: SqlDatabase): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('fast-order-dispatch-schema'))");
    await tx.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    const rows = await tx.query<{ version: number }>('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((row) => Number(row.version)));

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      await tx.exec(migration.sql);
      await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [migration.version]);
    }
  });
}
