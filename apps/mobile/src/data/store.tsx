import { createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { openAppDb } from '../db/expo.ts';
import {
  countItems,
  getItem,
  listCategories,
  listItems,
  type ItemFilter,
  type LocalCategory,
  type LocalItem,
} from '../db/repo.ts';
import type { SqlDb } from '../db/sql.ts';
import { importLegacyCaptures } from './legacy.ts';

/**
 * One database handle for the app, plus a change counter.
 *
 * Every write goes through `write()`, which bumps the counter; every read hook
 * re-runs when it moves. Coarse — any write refreshes every mounted query — but
 * the queries are indexed local SQLite reads measured in microseconds, and it
 * makes a stale screen impossible without per-table bookkeeping.
 */
type Store = {
  db: SqlDb;
  subscribe: (listener: () => void) => () => void;
  version: () => number;
  write: <T>(fn: (db: SqlDb) => T) => T;
};

function createStore(db: SqlDb): Store {
  let version = 0;
  const listeners = new Set<() => void>();
  return {
    db,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    version: () => version,
    write: (fn) => {
      try {
        return fn(db);
      } finally {
        // Bump even on failure: a throw can land after a partial non-tx write.
        version += 1;
        for (const l of listeners) l();
      }
    },
  };
}

const StoreContext = createContext<Store | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  // Synchronous on purpose: the first frame renders real data, no loading flash.
  const [store] = useState(() => {
    const db = openAppDb();
    importLegacyCaptures(db);
    return createStore(db);
  });
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore outside <DataProvider>');
  return store;
}

/** Runs a read against the local db, re-running after every write. */
function useLiveQuery<T>(read: (db: SqlDb) => T, deps: unknown[]): T {
  const store = useStore();
  const version = useSyncExternalStore(store.subscribe, store.version);
  return useMemo(() => read(store.db), [store, version, ...deps]);
}

/** `write(db => updateItem(db, …))` — every mutation goes through here so readers refresh. */
export function useWrite(): Store['write'] {
  return useStore().write;
}

const PAGE = 60;

/**
 * The gallery feed for a filter, grown a page at a time. Reset to one page when
 * the filter changes so switching categories doesn't re-read a long scroll.
 */
export function useItems(filter: Omit<ItemFilter, 'limit'>) {
  const key = `${filter.categoryId ?? ''}|${filter.kind ?? ''}|${filter.query?.trim() ?? ''}|${filter.order ?? ''}`;
  const [paging, setPaging] = useState({ key, limit: PAGE });
  const limit = paging.key === key ? paging.limit : PAGE;

  const items = useLiveQuery((db) => listItems(db, { ...filter, limit }), [key, limit]);
  const total = useLiveQuery((db) => countItems(db, filter), [key]);

  const loadMore = useCallback(() => {
    if (items.length < limit) return; // already have everything
    setPaging({ key, limit: limit + PAGE });
  }, [items.length, key, limit]);

  return { items, total, loadMore };
}

export function useItem(id: string): LocalItem | null {
  return useLiveQuery((db) => getItem(db, id), [id]);
}

export function useCategories(): LocalCategory[] {
  return useLiveQuery(listCategories, []);
}
