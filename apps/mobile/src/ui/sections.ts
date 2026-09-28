/**
 * Date headings for the feed ("Today", "This week", …), as a flat list of
 * header and item rows — the shape FlashList wants. A heading is emitted
 * whenever the bucket changes, so it works for either sort order.
 *
 * Pure and dependency-free so it runs under `node --test`.
 */
export type FeedRow<T> = { type: 'header'; key: string; label: string } | { type: 'item'; key: string; item: T };

const DAY = 86_400_000;

/** Local-midnight epoch ms for the day containing `t`. */
function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function bucketLabel(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  const today = startOfDay(now);
  if (t >= today) return 'Today';
  if (t >= today - DAY) return 'Yesterday';
  if (t >= today - 6 * DAY) return 'This week';
  const d = new Date(t);
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth()) return 'This month';
  return d.toLocaleDateString(undefined, {
    month: 'long',
    ...(d.getFullYear() === n.getFullYear() ? {} : { year: 'numeric' }),
  });
}

export function withSections<T extends { id: string; capturedAt: string }>(items: T[], now: number = Date.now()): FeedRow<T>[] {
  const rows: FeedRow<T>[] = [];
  let current: string | null = null;
  for (const item of items) {
    const label = bucketLabel(item.capturedAt, now);
    if (label !== current) {
      rows.push({ type: 'header', key: `h:${label}:${item.id}`, label });
      current = label;
    }
    rows.push({ type: 'item', key: item.id, item });
  }
  return rows;
}
