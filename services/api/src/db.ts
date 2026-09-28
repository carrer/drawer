import type pg from 'pg';

/** The single owner every row belongs to until multi-user exists (seeded by 001_init.sql). */
export const OWNER_ID = '00000000-0000-0000-0000-000000000001';

/** Advisory lock that makes rev order equal commit order — see 003_rev_commit_order.sql. */
export const DRAWER_REV_LOCK = 7239011;

/** Anything reads can run on: the pool, or a connection inside a transaction. */
export type Db = pg.Pool | pg.PoolClient;

async function inTx<T>(pool: pg.Pool, begin: string, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query(begin);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // If ROLLBACK itself fails the connection is unusable; destroy it rather than pool it.
    await client.query('ROLLBACK').catch(() => {
      broken = true;
    });
    throw err;
  } finally {
    client.release(broken);
  }
}

/** Run `fn` in a transaction on one pooled connection; roll back on any throw. */
export function withTx<T>(pool: pg.Pool, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  return inTx(pool, 'BEGIN', fn);
}

/**
 * A transaction that writes items or categories. Takes the rev lock *first*,
 * before any row locks: the trigger would take it anyway, but taking it midway
 * while holding row locks is how two writers deadlock.
 */
export function withWriteTx<T>(pool: pg.Pool, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  return inTx(pool, 'BEGIN', async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [DRAWER_REV_LOCK]);
    return fn(tx);
  });
}

/** One consistent snapshot across several reads (sync pages span two tables). */
export function withSnapshot<T>(pool: pg.Pool, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  return inTx(pool, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', fn);
}
