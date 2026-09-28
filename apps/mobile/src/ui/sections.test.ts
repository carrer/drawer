import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bucketLabel, withSections } from './sections.ts';

// Local-time noon on a Wednesday, so "this week" has room on both sides.
const now = new Date(2026, 8, 30, 12, 0).getTime();
const local = (month: number, day: number, hour = 9, year = 2026) => new Date(year, month, day, hour).toISOString();

test('buckets by local calendar day, not by 24-hour distance', () => {
  assert.equal(bucketLabel(local(8, 30, 0), now), 'Today');
  assert.equal(bucketLabel(local(8, 29, 23), now), 'Yesterday', '13 hours ago but a different day');
  assert.equal(bucketLabel(local(8, 24), now), 'This week');
  assert.equal(bucketLabel(local(8, 2), now), 'This month');
  assert.match(bucketLabel(local(6, 4), now), /July/);
  assert.match(bucketLabel(local(11, 25, 9, 2025), now), /2025/, 'other years carry the year');
});

test('withSections emits a header only when the bucket changes, in either order', () => {
  const items = [
    { id: 'a', capturedAt: local(8, 30, 10) },
    { id: 'b', capturedAt: local(8, 30, 8) },
    { id: 'c', capturedAt: local(8, 25) },
  ];
  const labels = (rows: ReturnType<typeof withSections>) =>
    rows.map((r) => (r.type === 'header' ? `#${r.label}` : r.key));
  assert.deepEqual(labels(withSections(items, now)), ['#Today', 'a', 'b', '#This week', 'c']);
  assert.deepEqual(labels(withSections([...items].reverse(), now)), ['#This week', 'c', '#Today', 'b', 'a']);
  assert.deepEqual(withSections([], now), []);
});
