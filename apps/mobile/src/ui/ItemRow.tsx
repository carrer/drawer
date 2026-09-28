import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { LocalItem } from '../db/repo.ts';
import { font, useTheme } from '../theme.ts';
import { itemDescriptor, itemTitle } from './format.ts';
import { Icon } from './icons.tsx';
import { ItemIcon } from './ItemIcon.tsx';

type Props = {
  item: LocalItem;
  onPress: (item: LocalItem) => void;
  /** ⋯ or long-press: the action sheet. */
  onActions: (item: LocalItem) => void;
  /** The compact variant used inside an open drawer. */
  compact?: boolean;
};

export function subtitleFor(item: LocalItem): string {
  const tags = item.tags.map((tag) => `#${tag}`).join(' ');
  return tags ? `${itemDescriptor(item)} · ${tags}` : itemDescriptor(item);
}

export const ItemRow = memo(function ItemRow({ item, onPress, onActions, compact = false }: Props) {
  const t = useTheme();
  const title = itemTitle(item);
  return (
    <Pressable
      onPress={() => onPress(item)}
      onLongPress={() => onActions(item)}
      accessibilityRole="button"
      accessibilityLabel={title}
      style={({ pressed }) => [
        compact ? s.compact : s.row,
        { backgroundColor: t.surface },
        pressed && { opacity: 0.8 },
      ]}
    >
      {compact ? null : <ItemIcon item={item} />}
      <View style={s.text}>
        <Text numberOfLines={1} style={[compact ? s.titleCompact : s.title, { color: t.text }]}>
          {title}
        </Text>
        <Text numberOfLines={1} style={[compact ? s.subCompact : s.sub, { color: t.muted }]}>
          {subtitleFor(item)}
        </Text>
      </View>
      <Pressable
        onPress={() => onActions(item)}
        hitSlop={4}
        accessibilityRole="button"
        accessibilityLabel={`More actions for ${title}`}
        style={({ pressed }) => [s.more, pressed && { opacity: 0.5 }]}
      >
        <Icon name="dots" color={t.muted} size={compact ? 18 : 20} />
      </Pressable>
    </Pressable>
  );
});

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingLeft: 12,
    paddingRight: 8,
    borderRadius: 18,
  },
  compact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingLeft: 10,
    paddingRight: 4,
    borderRadius: 12,
  },
  text: { flex: 1, minWidth: 0, gap: 3 },
  title: { fontFamily: font.body700, fontSize: 16 },
  sub: { fontFamily: font.body400, fontSize: 13 },
  titleCompact: { fontFamily: font.body700, fontSize: 15 },
  subCompact: { fontFamily: font.body400, fontSize: 12 },
  more: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
});
