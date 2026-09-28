import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useItems } from '../data/store.tsx';
import type { LocalCategory, LocalItem } from '../db/repo.ts';
import { categoryHue, font, useTheme, type Hue } from '../theme.ts';
import { ItemRow } from './ItemRow.tsx';

const PEEK = 5;

type Props = {
  categories: LocalCategory[];
  onOpenItem: (item: LocalItem) => void;
  onActions: (item: LocalItem) => void;
  /** "See all" — jump to the list, filtered to this category. */
  onSeeAll: (categoryId: string) => void;
  onManage: () => void;
  bottomInset: number;
};

/**
 * Categories as drawers: each one a card that opens in place to show what's
 * inside. One open at a time — it's a way to browse, the list is for scanning.
 */
export function DrawersView({ categories, onOpenItem, onActions, onSeeAll, onManage, bottomInset }: Props) {
  const t = useTheme();
  const [open, setOpen] = useState<string | null>(null);

  return (
    <ScrollView contentContainerStyle={[s.content, { paddingBottom: bottomInset + 24 }]}>
      {categories.map((c, index) => {
        const hue = categoryHue(t, c.color, index);
        const isOpen = open === c.id;
        return (
          <View key={c.id} style={[s.card, { backgroundColor: t.surface }]}>
            <Pressable
              onPress={() => setOpen(isOpen ? null : c.id)}
              accessibilityRole="button"
              accessibilityState={{ expanded: isOpen }}
              accessibilityLabel={`${c.name}, ${c.itemCount} items`}
              style={({ pressed }) => [s.drawer, pressed && { opacity: 0.8 }]}
            >
              <View style={[s.stripe, { backgroundColor: hue.bar }]} />
              <View style={s.drawerText}>
                <Text style={[s.name, { color: t.text }]} numberOfLines={1}>
                  {c.name}
                </Text>
                <Text style={[s.count, { color: t.muted }]}>
                  {c.itemCount === 0 ? 'Empty' : `${c.itemCount} ${c.itemCount === 1 ? 'item' : 'items'}`}
                </Text>
              </View>
              {/* The drawer handle: lights up in the drawer's colour when pulled open. */}
              <View style={[s.handle, { backgroundColor: isOpen ? hue.bar : t.border }]} />
            </Pressable>
            {isOpen ? (
              <Contents
                category={c}
                hue={hue}
                onOpenItem={onOpenItem}
                onActions={onActions}
                onSeeAll={() => onSeeAll(c.id)}
              />
            ) : null}
          </View>
        );
      })}

      <Pressable
        onPress={onManage}
        accessibilityRole="button"
        style={({ pressed }) => [s.manage, { borderColor: t.dashed }, pressed && { opacity: 0.6 }]}
      >
        <Text style={[s.manageText, { color: t.secondary }]}>Manage categories</Text>
      </Pressable>
    </ScrollView>
  );
}

function Contents({
  category,
  hue,
  onOpenItem,
  onActions,
  onSeeAll,
}: {
  category: LocalCategory;
  hue: Hue;
  onOpenItem: Props['onOpenItem'];
  onActions: Props['onActions'];
  onSeeAll: () => void;
}) {
  const t = useTheme();
  const { items, total } = useItems({ categoryId: category.id });
  const shown = items.slice(0, PEEK);

  return (
    <View style={[s.panel, { backgroundColor: hue.panel }]}>
      {shown.length === 0 ? (
        <Text style={[s.empty, { color: t.muted }]}>Nothing filed here yet.</Text>
      ) : (
        shown.map((item) => <ItemRow key={item.id} item={item} compact onPress={onOpenItem} onActions={onActions} />)
      )}
      {total > PEEK ? (
        <Pressable onPress={onSeeAll} hitSlop={6} accessibilityRole="button" style={s.seeAll}>
          <Text style={[s.seeAllText, { color: hue.ink }]}>See all {total}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 4, gap: 14 },
  card: { borderRadius: 20, overflow: 'hidden' },
  drawer: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, paddingHorizontal: 16 },
  stripe: { width: 6, height: 36, borderRadius: 3 },
  drawerText: { flex: 1, minWidth: 0, gap: 2 },
  name: { fontFamily: font.heading800, fontSize: 18 },
  count: { fontFamily: font.body400, fontSize: 13 },
  handle: { width: 40, height: 10, borderRadius: 5 },
  panel: {
    marginHorizontal: 10,
    marginBottom: 10,
    borderRadius: 14,
    padding: 8,
    gap: 6,
    // The design's inset shadow — the drawer's inside lip. RN has no inset
    // shadow, so a hairline top edge stands in for it.
    borderTopWidth: 3,
    borderTopColor: 'rgba(15, 27, 61, 0.06)',
  },
  empty: { fontFamily: font.body400, fontSize: 14, padding: 10 },
  seeAll: { alignSelf: 'center', paddingVertical: 8, paddingHorizontal: 12 },
  seeAllText: { fontFamily: font.heading800, fontSize: 14 },
  manage: {
    height: 52,
    borderRadius: 20,
    borderWidth: 1,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  manageText: { fontFamily: font.heading800, fontSize: 15 },
});
