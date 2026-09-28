import { router } from 'expo-router';
import { Linking, Share } from 'react-native';
import type { LocalItem } from '../db/repo.ts';
import { hostOf } from '../ui/format.ts';
import type { IconName } from '../ui/icons.tsx';
import { openFile } from './openExternally.ts';

export type PrimaryAction = { label: string; icon: IconName; run: () => Promise<void> | void };

const openDetail = (id: string) => router.push({ pathname: '/item/[id]', params: { id } });

/**
 * The big button in the action sheet: the one thing you most likely came back
 * for. Links open where they live, files open in their app, images and notes
 * open in drowa itself.
 */
export function primaryAction(item: LocalItem): PrimaryAction {
  if (item.kind === 'link' && item.url) {
    const url = item.url;
    return { label: `Open in ${item.linkSiteName ?? hostOf(url)}`, icon: 'external', run: () => Linking.openURL(url) };
  }
  if ((item.kind === 'document' || item.kind === 'video' || item.kind === 'audio') && item.localPath) {
    const path = item.localPath;
    return { label: 'Open with…', icon: 'external', run: () => openFile(path, item.mimeType) };
  }
  if (item.kind === 'text') return { label: 'Edit note', icon: 'note', run: () => openDetail(item.id) };
  return { label: 'View', icon: 'image', run: () => openDetail(item.id) };
}

/**
 * Share out again: the original bytes if we hold them, else the link or the text.
 *
 * expo-sharing is loaded on first use for the same reason as the intent
 * launcher in openExternally.ts: a static import of a native module the
 * installed dev client lacks crashes the whole route tree, not just Share.
 */
export async function shareItem(item: LocalItem): Promise<void> {
  if (item.localPath) {
    let sharing: typeof import('expo-sharing');
    try {
      sharing = await import('expo-sharing');
    } catch {
      throw new Error('This build is missing expo-sharing. Rebuild the dev client (make android).');
    }
    if (await sharing.isAvailableAsync()) {
      await sharing.shareAsync(item.localPath, {
        mimeType: item.mimeType ?? undefined,
        dialogTitle: item.title ?? undefined,
      });
      return;
    }
  }
  const message = item.url ?? item.body;
  if (!message) throw new Error('The original isn’t on this device, so there is nothing to share yet.');
  await Share.share({ message, title: item.title ?? item.linkTitle ?? undefined });
}

export function canShare(item: LocalItem): boolean {
  return Boolean(item.localPath || item.url || item.body);
}
