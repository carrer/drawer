-- Make `rev` order equal commit order, or the sync cursor can skip rows.
--
-- A sequence alone isn't enough under concurrency: tx A draws rev 10, tx B draws
-- rev 11 and commits first, a sync reads up to 11 and advances its cursor past
-- 10 — then A commits rev 10 behind the cursor and that device never sees it.
--
-- Fix: every writer to a synced table takes one transaction-scoped advisory lock
-- *before* drawing its rev, and holds it until commit. No rev can be drawn while
-- a smaller one is uncommitted, so any snapshot sees a gap-free prefix of revs.
-- This serializes writes to items/categories, which for one user is free.
--
-- The API takes the same lock at the start of each write transaction (before any
-- row locks, so the two can't deadlock); in here it's the backstop for every
-- other writer (psql, the worker).

CREATE OR REPLACE FUNCTION drawer_bump_rev() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(7239011);   -- DRAWER_REV_LOCK in services/api/src/db.ts
  NEW.updated_at := now();
  NEW.rev := nextval('drawer_rev_seq');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- INSERTs were drawing rev from the column DEFAULT, outside any lock. Defaults
-- are evaluated before BEFORE triggers, so the default's value is simply
-- replaced (sequence gaps are harmless).
DROP TRIGGER items_bump_rev ON items;
DROP TRIGGER categories_bump_rev ON categories;
CREATE TRIGGER items_bump_rev BEFORE INSERT OR UPDATE ON items
  FOR EACH ROW EXECUTE FUNCTION drawer_bump_rev();
CREATE TRIGGER categories_bump_rev BEFORE INSERT OR UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION drawer_bump_rev();
