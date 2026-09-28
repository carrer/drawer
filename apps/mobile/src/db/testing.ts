import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrations.ts';
import type { SqlDb } from './sql.ts';

/** A migrated in-memory database over node:sqlite, for tests. */
export function memoryDb(): SqlDb {
  const raw = new DatabaseSync(':memory:');
  const db: SqlDb = {
    exec: (sql) => raw.exec(sql),
    run: (sql, params = []) => ({ changes: Number(raw.prepare(sql).run(...params).changes) }),
    all: <T>(sql: string, params: (string | number | null)[] = []) => raw.prepare(sql).all(...params) as T[],
    get: <T>(sql: string, params: (string | number | null)[] = []) =>
      (raw.prepare(sql).get(...params) as T | undefined) ?? null,
    tx: (fn) => {
      raw.exec('BEGIN');
      try {
        fn();
        raw.exec('COMMIT');
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
  };
  migrate(db);
  return db;
}
