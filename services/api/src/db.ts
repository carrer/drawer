import type pg from 'pg';

/** The single owner every row belongs to until multi-user exists (seeded by 001_init.sql). */
export const OWNER_ID = '00000000-0000-0000-0000-000000000001';

/** Run `fn` in a transaction on one pooled connection; roll back on any throw. */
export async function withTx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
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
