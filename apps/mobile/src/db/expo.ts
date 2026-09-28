import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';
import { migrate } from './migrations.ts';
import type { SqlDb } from './sql.ts';

export function fromExpo(db: SQLiteDatabase): SqlDb {
  return {
    exec: (sql) => db.execSync(sql),
    run: (sql, params = []) => ({ changes: db.runSync(sql, params).changes }),
    all: (sql, params = []) => db.getAllSync(sql, params),
    get: (sql, params = []) => db.getFirstSync(sql, params),
    tx: (fn) => db.withTransactionSync(fn),
  };
}

/** Opens (creating on first launch) the app database and brings its schema up to date. */
export function openAppDb(): SqlDb {
  const db = fromExpo(openDatabaseSync('drawer.db'));
  migrate(db);
  return db;
}
