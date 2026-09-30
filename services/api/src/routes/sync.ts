import { SearchQuerySchema, SyncQuerySchema, type SearchResponse, type SyncResponse } from '@drawer/shared';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { withSnapshot } from '../db.ts';
import { loadItems } from '../items.ts';
import { CATEGORY_COLUMNS, toCategory, type CategoryRow } from '../rows.ts';

/**
 * `simple`-config prefix query from free text: every word must match as a
 * prefix ("scree" finds "screenshot"). Only letters and digits survive, so the
 * result is always a valid tsquery — no user input reaches to_tsquery raw.
 */
export function toPrefixQuery(q: string): string | null {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return words ? words.map((w) => `${w}:*`).join(' & ') : null;
}

export function syncRoutes(app: FastifyInstance, pool: pg.Pool) {
  /**
   * Delta pull: every item and category with rev > since, in rev order, both
   * tables interleaved so one cursor covers them. Read from a single snapshot;
   * with rev order equal to commit order (003_rev_commit_order.sql) that
   * snapshot is a gap-free prefix, so `cursor` can never skip a row.
   */
  app.get('/sync', async (req): Promise<SyncResponse> => {
    const { since, limit } = SyncQuerySchema.parse(req.query);
    const ownerId = req.auth.ownerId;

    return withSnapshot(pool, async (tx) => {
      const { rows: page } = await tx.query<{ t: 'item' | 'category'; id: string; rev: string }>(
        `SELECT 'item' AS t, id, rev FROM items WHERE owner_id = $1 AND rev > $2
         UNION ALL
         SELECT 'category', id, rev FROM categories WHERE owner_id = $1 AND rev > $2
         ORDER BY rev LIMIT $3`,
        [ownerId, since, limit + 1],
      );
      const more = page.length > limit;
      const taken = page.slice(0, limit);
      const ids = (t: string) => taken.filter((r) => r.t === t).map((r) => r.id);

      // Owner filters on both: category ids are only unique per owner — every
      // account has an Inbox with the same id.
      const items = await loadItems(tx, 'i.owner_id = $1 AND i.id = ANY($2::uuid[])', [ownerId, ids('item')], 'ORDER BY i.rev');
      const { rows: cats } = await tx.query<CategoryRow>(
        `SELECT ${CATEGORY_COLUMNS} FROM categories WHERE owner_id = $1 AND id = ANY($2::uuid[]) ORDER BY rev`,
        [ownerId, ids('category')],
      );
      return {
        items,
        categories: cats.map(toCategory),
        cursor: taken.length ? Number(taken.at(-1)!.rev) : since,
        more,
      };
    });
  });

  app.get('/search', async (req): Promise<SearchResponse> => {
    const { q, limit } = SearchQuerySchema.parse(req.query);
    const query = toPrefixQuery(q);
    if (!query) return { items: [] };
    const items = await loadItems(
      pool,
      `i.owner_id = $1 AND i.deleted_at IS NULL AND i.search @@ to_tsquery('simple', $2)`,
      [req.auth.ownerId, query, limit],
      `ORDER BY ts_rank(i.search, to_tsquery('simple', $2)) DESC, i.captured_at DESC LIMIT $3`,
    );
    return { items };
  });
}
