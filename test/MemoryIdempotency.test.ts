import { MemoryDispatchStore } from '../src/store/DispatchStore';

describe('MemoryDispatchStore idempotency', () => {
  test('reclaims expired claims without letting stale completions overwrite', async () => {
    const store = new MemoryDispatchStore();
    const now = Date.now();
    const first = await store.claimIdempotency('key', 'fingerprint', now, now + 60_000);

    await store.completeIdempotency({
      ...first.record,
      status: 201,
      body: { first: true },
      createdAt: now,
      expiresAt: now + 60_000
    });
    await store.completeIdempotency({
      ...first.record,
      status: 500,
      body: { late: true },
      createdAt: now,
      expiresAt: now + 60_000
    });
    expect((await store.getIdempotency('key'))?.body).toEqual({ first: true });

    const second = await store.claimIdempotency('key', 'fingerprint', now + 120_000, now + 180_000);
    expect(second.claimed).toBe(true);
    await store.completeIdempotency({
      ...first.record,
      status: 500,
      body: { stale: true },
      createdAt: now,
      expiresAt: now + 60_000
    });
    expect((await store.getIdempotency('key'))?.status).toBe(0);

    await store.releaseIdempotency('key', first.record.claimToken);
    expect(await store.getIdempotency('key')).toBeDefined();
    await store.releaseIdempotency('key', second.record.claimToken);
    expect(await store.getIdempotency('key')).toBeUndefined();
  });
});
