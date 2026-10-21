require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }
  const retentionDays = Number(process.env.AUDIT_RETENTION_DAYS ?? 90);
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error('AUDIT_RETENTION_DAYS must be a positive integer');
  }

  const ssl = process.env.DATABASE_SSL === 'true' ? true : undefined;
  const client = new Client({ connectionString, ssl });
  await client.connect();
  try {
    const idempotency = await client.query(
      'DELETE FROM idempotency WHERE expires_at <= $1',
      [Date.now()]
    );
    const audits = await client.query(
      "DELETE FROM audits WHERE timestamp < now() - ($1::text || ' days')::interval",
      [String(retentionDays)]
    );
    console.log(
      JSON.stringify({
        deletedIdempotencyKeys: idempotency.rowCount,
        deletedAuditEntries: audits.rowCount,
        auditRetentionDays: retentionDays
      })
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
