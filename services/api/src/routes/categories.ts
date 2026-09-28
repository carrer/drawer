import {
  CategoryPatchSchema,
  CategoryUpsertSchema,
  INBOX_CATEGORY_ID,
  Uuid,
  type Category,
} from '@drawer/shared';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { withWriteTx } from '../db.ts';
import { HttpError, isUniqueViolation } from '../errors.ts';
import { CATEGORY_COLUMNS, toCategory, type CategoryRow } from '../rows.ts';

const IdParams = z.object({ id: Uuid });

const nameTaken = (err: unknown) =>
  isUniqueViolation(err) ? new HttpError(409, 'name_taken', 'a category with that name already exists') : err;

async function getCategory(db: pg.Pool | pg.PoolClient, ownerId: string, id: string) {
  const { rows } = await db.query<CategoryRow>(
    `SELECT ${CATEGORY_COLUMNS} FROM categories WHERE id = $1 AND owner_id = $2`,
    [id, ownerId],
  );
  return rows[0] ? toCategory(rows[0]) : null;
}

/**
 * Same rules as items: client-generated ids, idempotent upsert, soft delete,
 * no resurrection, and a no-op write doesn't advance rev.
 */
export function categoryRoutes(app: FastifyInstance, pool: pg.Pool) {
  /** Live categories in display order. Sync is the complete feed; this is a convenience. */
  app.get('/categories', async (req): Promise<{ categories: Category[] }> => {
    const { rows } = await pool.query<CategoryRow>(
      `SELECT ${CATEGORY_COLUMNS} FROM categories
        WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY sort_order, lower(name)`,
      [req.auth.ownerId],
    );
    return { categories: rows.map(toCategory) };
  });

  app.post('/categories', async (req, reply): Promise<Category> => {
    const c = CategoryUpsertSchema.parse(req.body);
    const ownerId = req.auth.ownerId;
    const { category, created } = await withWriteTx(pool, async (tx) => {
      const fields = [c.name, c.color ?? null, c.icon ?? null, c.sortOrder];
      const res = await tx.query<{ inserted: boolean }>(
        `INSERT INTO categories (id, owner_id, name, color, icon, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, color = EXCLUDED.color, icon = EXCLUDED.icon, sort_order = EXCLUDED.sort_order
         WHERE categories.owner_id = EXCLUDED.owner_id
           AND categories.deleted_at IS NULL
           AND (categories.name, categories.color, categories.icon, categories.sort_order)
               IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.color, EXCLUDED.icon, EXCLUDED.sort_order)
         RETURNING xmax = 0 AS inserted`,
        [c.id, ownerId, ...fields],
      ).catch((err) => { throw nameTaken(err); });
      // No row back means unchanged, deleted, or someone else's id; the read sorts it out.
      const category = await getCategory(tx, ownerId, c.id);
      if (!category) throw new HttpError(404, 'not_found', 'no such category');
      return { category, created: !!res.rows[0]?.inserted };
    });
    reply.code(created ? 201 : 200);
    return category;
  });

  app.patch('/categories/:id', async (req): Promise<Category> => {
    const { id } = IdParams.parse(req.params);
    const p = CategoryPatchSchema.parse(req.body);
    const ownerId = req.auth.ownerId;
    return withWriteTx(pool, async (tx) => {
      // Column names come from this fixed map, never from the request.
      const columns = { name: 'name', color: 'color', icon: 'icon', sortOrder: 'sort_order' } as const;
      const cols: string[] = [];
      const params: unknown[] = [id, ownerId];
      for (const [key, col] of Object.entries(columns) as [keyof typeof columns, string][]) {
        if (p[key] === undefined) continue;
        cols.push(col);
        params.push(p[key]);
      }
      if (cols.length) {
        const vals = cols.map((_, n) => `$${n + 3}`);
        await tx.query(
          `UPDATE categories SET ${cols.map((c, n) => `${c} = ${vals[n]}`).join(', ')}
            WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL
              AND ROW(${cols.join(', ')}) IS DISTINCT FROM ROW(${vals.join(', ')})`,
          params,
        ).catch((err) => { throw nameTaken(err); });
      }
      const category = await getCategory(tx, ownerId, id);
      if (!category || category.deletedAt) throw new HttpError(404, 'not_found', 'no such category');
      return category;
    });
  });

  /**
   * Soft delete. Its items lose the membership, and since an item's category
   * set travels with the item, each of them gets a new rev so devices re-pull it.
   */
  app.delete('/categories/:id', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    if (id === INBOX_CATEGORY_ID) {
      throw new HttpError(409, 'protected', 'the Inbox is where one-tap saves go; rename it instead');
    }
    const ownerId = req.auth.ownerId;
    await withWriteTx(pool, async (tx) => {
      const { rows } = await tx.query<{ deleted: boolean }>(
        'SELECT deleted_at IS NOT NULL AS deleted FROM categories WHERE id = $1 AND owner_id = $2 FOR UPDATE',
        [id, ownerId],
      );
      if (!rows[0]) throw new HttpError(404, 'not_found', 'no such category');
      if (rows[0].deleted) return;
      await tx.query('UPDATE categories SET deleted_at = now() WHERE id = $1', [id]);
      await tx.query(
        `WITH gone AS (DELETE FROM item_categories WHERE category_id = $1 RETURNING item_id)
         UPDATE items SET updated_at = now() WHERE id IN (SELECT item_id FROM gone)`,
        [id],
      );
    });
    return reply.code(204).send();
  });
}
