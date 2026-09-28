import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { SyncResponseSchema, uuidv7, type SyncResponse } from '@drawer/shared';
import { DRAWER_REV_LOCK } from '../../src/db.ts';
import { setup } from './harness.ts';

let h: Awaited<ReturnType<typeof setup>>;
let dev: Awaited<ReturnType<typeof h.device>>;
before(async () => {
  h = await setup();
  dev = await h.device();
});
after(() => h.teardown());

const text = (body: string, extra: object = {}) =>
  dev.request('POST', '/v1/items', { id: uuidv7(), kind: 'text', body, capturedAt: new Date().toISOString(), ...extra });

async function pull(since: number, limit = 500): Promise<SyncResponse> {
  const res = await dev.request('GET', `/v1/sync?since=${since}&limit=${limit}`);
  assert.equal(res.statusCode, 200);
  return SyncResponseSchema.parse(res.json()); // the wire format matches the shared contract
}

/** Pull everything from `since` in pages, the way the app will. */
async function pullAll(since: number, limit: number) {
  const seen: SyncResponse[] = [];
  let cursor = since;
  for (;;) {
    const page = await pull(cursor, limit);
    seen.push(page);
    cursor = page.cursor;
    if (!page.more) return { pages: seen, cursor };
  }
}

test('a first pull returns the seeded categories; an empty delta keeps the cursor', async () => {
  const first = await pull(0);
  assert.equal(first.categories.length, 4);
  assert.equal(first.more, false);
  const again = await pull(first.cursor);
  assert.deepEqual(again, { items: [], categories: [], cursor: first.cursor, more: false });
});

test('pages interleave both tables in rev order and never repeat or skip', async () => {
  const start = (await pull(0)).cursor;
  const ids = new Set<string>();
  for (let n = 0; n < 7; n++) ids.add((await text(`page ${n}`)).json().id);
  ids.add((await dev.request('POST', '/v1/categories', { id: uuidv7(), name: 'Paged' })).json().id);
  for (let n = 7; n < 10; n++) ids.add((await text(`page ${n}`)).json().id);

  const { pages, cursor } = await pullAll(start, 3);
  const got = pages.flatMap((p) => [...p.items, ...p.categories]);
  assert.equal(got.length, ids.size);
  assert.deepEqual(new Set(got.map((r) => r.id)), ids);
  assert.equal(pages.length, 4);
  assert.ok(pages.slice(0, -1).every((p) => p.more));
  assert.equal(cursor, Math.max(...got.map((r) => r.rev)));
});

test('edits and deletes come back as newer revs', async () => {
  const item = (await text('to edit')).json();
  const cursor = (await pull(0)).cursor;
  await dev.request('PATCH', `/v1/items/${item.id}`, { title: 'edited' });
  await dev.request('DELETE', `/v1/items/${item.id}`);
  const delta = await pull(cursor);
  assert.equal(delta.items.length, 1, 'one row per item, at its latest state');
  assert.equal(delta.items[0]!.title, 'edited');
  assert.ok(delta.items[0]!.deletedAt);
});

/**
 * The bug 003_rev_commit_order.sql fixes. Hold the rev lock from another
 * connection (standing in for a slow in-flight write); a write started after it
 * must not become visible with a rev the cursor could skip past.
 */
test('a slow transaction cannot be skipped by the cursor', async () => {
  const cursor = (await pull(0)).cursor;
  const slow = await h.pool.connect();
  try {
    await slow.query('BEGIN');
    await slow.query(
      `INSERT INTO items (id, owner_id, kind, body, captured_at)
       VALUES ($1, '00000000-0000-0000-0000-000000000001', 'text', 'slow', now())`,
      [uuidv7()],
    );
    // A second writer now has to wait for the first to commit before drawing a rev.
    const fast = text('fast');
    await new Promise((r) => setTimeout(r, 150));
    const during = await pull(cursor);
    assert.equal(during.items.length, 0, 'nothing may be visible past a gap');

    await slow.query('COMMIT');
    await fast;
    const bodies = (await pull(cursor)).items.map((i) => i.body);
    assert.deepEqual(bodies, ['slow', 'fast'], 'commit order == rev order');
  } finally {
    await slow.query('ROLLBACK').catch(() => {});
    slow.release();
  }
});

test('writers outside the API take the same lock via the trigger', async () => {
  const { rows } = await h.pool.query<{ fn: string }>(
    `SELECT pg_get_functiondef('drawer_bump_rev'::regproc) AS fn`,
  );
  assert.match(rows[0]!.fn, new RegExp(`pg_advisory_xact_lock\\(${DRAWER_REV_LOCK}\\)`));
});

test('search matches word prefixes across fields, best first, live items only', async () => {
  await text('ignore me', { title: 'Screenshot of the router config' });
  const noteHit = (await text('something else', { note: 'router password lives here' })).json();
  const gone = (await text('router router router')).json();
  await dev.request('DELETE', `/v1/items/${gone.id}`);

  const res = (await dev.request('GET', '/v1/search?q=rout')).json();
  assert.deepEqual(
    res.items.map((i: { title: string | null; note: string | null }) => i.title ?? i.note),
    ['Screenshot of the router config', 'router password lives here'],
    'title outranks note; the deleted item is absent',
  );
  assert.equal((await dev.request('GET', '/v1/search?q=scree+ROUT')).json().items.length, 1);
  assert.equal((await dev.request('GET', '/v1/search?q=' + encodeURIComponent("'):*&|!"))).json().items.length, 0);
  assert.equal((await dev.request('GET', '/v1/search?q=')).statusCode, 400);
  assert.ok(noteHit.id);
});
