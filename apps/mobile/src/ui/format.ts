import type { LocalItem } from '../db/repo.ts';


/** "example.com" from a URL, without the www. Falls back to the input. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** "PDF" from application/pdf or report.pdf. */
export function typeBadge(mimeType: string | null, fileName: string | null): string | null {
  const ext = fileName?.match(/\.([a-z0-9]{1,5})$/i)?.[1];
  if (ext) return ext.toUpperCase();
  const sub = mimeType?.split('/')[1]?.split(/[+;.]/)[0];
  return sub ? sub.toUpperCase() : null;
}

const KIND_NAME: Record<LocalItem['kind'], string> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  document: 'Document',
  link: 'Link',
  text: 'Note',
};

type Describable = Pick<
  LocalItem,
  'kind' | 'title' | 'linkTitle' | 'linkSiteName' | 'url' | 'body' | 'mimeType' | 'byteSize'
>;

/** The row's headline: what you'd call it, not what it technically is. */
export function itemTitle(item: Describable): string {
  const firstLine = item.body?.trim().split('\n')[0]?.trim();
  return (
    item.title ??
    item.linkTitle ??
    (item.kind === 'text' ? firstLine : null) ??
    (item.url ? hostOf(item.url) : null) ??
    KIND_NAME[item.kind]
  );
}

/** Where it came from or what it is: "uxdesign.cc", "PDF · 1.2 MB", "Image". */
export function itemDescriptor(item: Describable): string {
  switch (item.kind) {
    case 'link':
      return item.linkSiteName ?? (item.url ? hostOf(item.url) : 'Link');
    case 'text':
      return item.title ? (item.body?.trim().split('\n')[0] ?? 'Note') : 'Note';
    default: {
      const badge = item.kind === 'image' ? 'Image' : (typeBadge(item.mimeType, item.title) ?? KIND_NAME[item.kind]);
      return item.byteSize !== null && item.kind !== 'image' ? `${badge} · ${formatBytes(item.byteSize)}` : badge;
    }
  }
}

/** "saved today", "saved yesterday", "saved 3 days ago", "saved 2 Sep". */
export function savedAgo(iso: string, now: number = Date.now()): string {
  const day = (t: number) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((day(now) - day(Date.parse(iso))) / 86_400_000);
  if (days <= 0) return 'saved today';
  if (days === 1) return 'saved yesterday';
  if (days < 7) return `saved ${days} days ago`;
  return `saved ${new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}

export function formatBytes(n: number | null): string {
  if (n === null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

/** "#Road Trip " → "road-trip". Tags are loose labels; keep them easy to type and match. */
export function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 64);
}
