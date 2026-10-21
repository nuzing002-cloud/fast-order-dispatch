jest.mock('pg', () => {
  const poolQuery = jest.fn();
  const clientQuery = jest.fn();
  const release = jest.fn();
  const client = { query: clientQuery, release };
  const pool = {
    query: poolQuery,
    connect: jest.fn(),
    on: jest.fn(),
    end: jest.fn()
  };
  return { Pool: jest.fn(() => pool), __mockPool: pool, __mockClient: client };
});

import { PostgresSqlDatabase } from '../src/store/sql';

interface PoolMock {
  query: jest.Mock;
  connect: jest.Mock;
  on: jest.Mock;
  end: jest.Mock;
}

interface ClientMock {
  query: jest.Mock;
  release: jest.Mock;
}

const pgMock = jest.requireMock('pg') as unknown as {
  Pool: jest.Mock;
  __mockPool: PoolMock;
  __mockClient: ClientMock;
};

describe('PostgresSqlDatabase', () => {
  let database: PostgresSqlDatabase;

  beforeEach(() => {
    jest.clearAllMocks();
    pgMock.__mockPool.query.mockResolvedValue({ rows: [] });
    pgMock.__mockPool.connect.mockResolvedValue(pgMock.__mockClient);
    pgMock.__mockPool.end.mockResolvedValue(undefined);
    pgMock.__mockClient.query.mockResolvedValue({ rows: [] });
    pgMock.__mockClient.release.mockReturnValue(undefined);
    database = new PostgresSqlDatabase({
      connectionString: 'postgres://user:pass@localhost:5432/dispatch',
      max: 4,
      ssl: { rejectUnauthorized: false }
    });
  });

  test('configures the pool and delegates queries', async () => {
    expect(pgMock.Pool).toHaveBeenCalledWith({
      connectionString: 'postgres://user:pass@localhost:5432/dispatch',
      max: 4,
      ssl: { rejectUnauthorized: false }
    });
    expect(pgMock.__mockPool.on).toHaveBeenCalledWith('error', expect.any(Function));

    pgMock.__mockPool.query.mockResolvedValueOnce({ rows: [{ value: 1 }] });
    await expect(database.query('SELECT $1 AS value', [1])).resolves.toEqual([{ value: 1 }]);
    expect(pgMock.__mockPool.query).toHaveBeenCalledWith('SELECT $1 AS value', [1]);

    await database.exec('CREATE TABLE sample (id int)');
    expect(pgMock.__mockPool.query).toHaveBeenCalledWith('CREATE TABLE sample (id int)');
  });

  test('commits successful transactions and releases the client', async () => {
    pgMock.__mockClient.query.mockImplementation((text: string) =>
      Promise.resolve({ rows: text.startsWith('SELECT') ? [{ id: 'o1' }] : [] })
    );

    const result = await database.transaction(async (tx) => {
      const rows = await tx.query('SELECT id FROM orders');
      await tx.exec('INSERT INTO orders (id) VALUES ($1)');
      return rows;
    });

    expect(result).toEqual([{ id: 'o1' }]);
    expect(pgMock.__mockClient.query.mock.calls.map((call) => call[0])).toEqual([
      'BEGIN',
      'SELECT id FROM orders',
      'INSERT INTO orders (id) VALUES ($1)',
      'COMMIT'
    ]);
    expect(pgMock.__mockClient.release).toHaveBeenCalledTimes(1);
  });

  test('rolls back failed transactions', async () => {
    await expect(
      database.transaction(async (tx) => {
        await tx.exec('INSERT INTO orders (id) VALUES ($1)');
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(pgMock.__mockClient.query.mock.calls.map((call) => call[0])).toEqual([
      'BEGIN',
      'INSERT INTO orders (id) VALUES ($1)',
      'ROLLBACK'
    ]);
    expect(pgMock.__mockClient.release).toHaveBeenCalledTimes(1);
  });

  test('retries serialization failures and deadlocks', async () => {
    let attempts = 0;
    const result = await database.transaction(async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = Object.assign(new Error('could not serialize access'), { code: '40001' });
        throw error;
      }
      return 'committed';
    });

    expect(result).toBe('committed');
    expect(pgMock.__mockPool.connect).toHaveBeenCalledTimes(2);
    expect(pgMock.__mockClient.release).toHaveBeenCalledTimes(2);
  });

  test('does not retry client errors and stops after three attempts', async () => {
    await expect(
      database.transaction(async () => {
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      })
    ).rejects.toThrow('duplicate key');
    expect(pgMock.__mockPool.connect).toHaveBeenCalledTimes(1);

    pgMock.__mockPool.connect.mockClear();
    await expect(
      database.transaction(async () => {
        throw Object.assign(new Error('deadlock'), { code: '40P01' });
      })
    ).rejects.toThrow('deadlock');
    expect(pgMock.__mockPool.connect).toHaveBeenCalledTimes(3);
  });

  test('reports readiness and closes the pool', async () => {
    await expect(database.ping()).resolves.toBe(true);
    pgMock.__mockPool.query.mockRejectedValueOnce(new Error('down'));
    await expect(database.ping()).resolves.toBe(false);

    await database.close();
    expect(pgMock.__mockPool.end).toHaveBeenCalledTimes(1);
  });
});
