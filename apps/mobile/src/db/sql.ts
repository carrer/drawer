/**
 * The slice of a synchronous SQLite handle the repository needs.
 *
 * expo-sqlite's SQLiteDatabase satisfies it on the phone (see expo.ts); node:sqlite
 * satisfies it in tests (see testing.ts). Keeping the repository behind this
 * interface is what lets the whole data layer be tested with plain `node --test`,
 * no simulator — so nothing in src/db may import an Expo module except expo.ts.
 */
export type SqlValue = string | number | null;

export interface SqlDb {
  exec(sql: string): void;
  run(sql: string, params?: SqlValue[]): { changes: number };
  all<T>(sql: string, params?: SqlValue[]): T[];
  get<T>(sql: string, params?: SqlValue[]): T | null;
  /** Runs fn in a transaction; commits if it returns, rolls back if it throws. */
  tx(fn: () => void): void;
}
