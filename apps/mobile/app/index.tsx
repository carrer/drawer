import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCategories, useItems, useWrite } from '@/data/store';
import { useShareCapture } from '@/data/useShareCapture';
import type { LocalItem } from '@/db/repo';
import { seedSampleData } from '@/db/seed';
import { categoryHue, font, useTheme, type Theme } from '@/theme';
import { ActionSheet } from '@/ui/ActionSheet';
import { Chip } from '@/ui/Chip';
import { DrawersView } from '@/ui/DrawersView';
import { Icon, Logo } from '@/ui/icons';
import { IconButton } from '@/ui/IconButton';
import { ItemRow } from '@/ui/ItemRow';
import { withSections, type FeedRow } from '@/ui/sections';

/**
 * Home: everything saved, newest first, grouped by when you saved it — or, one
 * tap away, the same things as category drawers. Reads only local SQLite, so it
 * renders the same with the server unreachable.
 */
export default function Home() {
  const t = useTheme();
  const s = styles(t);
  const insets = useSafeAreaInsets();
  const write = useWrite();
  const { notice, dismiss } = useShareCapture();

  const [view, setView] = useState<'list' | 'drawers'>('list');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [order, setOrder] = useState<'newest' | 'oldest'>('newest');
  const [sheetItem, setSheetItem] = useState<string | null>(null);
  const search = useRef<TextInput>(null);

  const categories = useCategories();
  const { items, total, loadMore } = useItems({ categoryId, query, order });
  const rows = useMemo(() => withSections(items), [items]);

  // A filtered-on category can vanish (deleted on the categories screen).
  useEffect(() => {
    if (categoryId && !categories.some((c) => c.id === categoryId)) setCategoryId(null);
  }, [categories, categoryId]);

  useEffect(() => {
    if (notice?.tone !== 'ok') return;
    const timer = setTimeout(dismiss, 3500);
    return () => clearTimeout(timer);
  }, [notice, dismiss]);

  const openItem = useCallback(
    (item: LocalItem) => router.push({ pathname: '/item/[id]', params: { id: item.id } }),
    [],
  );
  const openActions = useCallback((item: LocalItem) => setSheetItem(item.id), []);
  const closeSheet = useCallback(() => setSheetItem(null), []);

  const filtered = categoryId !== null || query.trim() !== '';

  return (
    <View style={[s.screen, { paddingTop: insets.top + 14 }]}>
      <View style={s.header}>
        <View style={s.brandRow}>
          <Logo color={t.text} />
          <View style={s.buttons}>
            <IconButton name="user" label="Account" onPress={() => router.push('/account')} />
            {view === 'list' ? (
              <>
                <IconButton name="drawers" label="Switch to drawers view" onPress={() => setView('drawers')} />
                <IconButton
                  name="sort"
                  label={order === 'newest' ? 'Showing newest first; show oldest first' : 'Showing oldest first; show newest first'}
                  active={order === 'oldest'}
                  onPress={() => setOrder(order === 'newest' ? 'oldest' : 'newest')}
                />
              </>
            ) : (
              <IconButton
                name="search"
                label="Search"
                onPress={() => {
                  setView('list');
                  setTimeout(() => search.current?.focus(), 50);
                }}
              />
            )}
          </View>
        </View>

        {view === 'list' ? (
          <>
            <View style={s.search}>
              <Icon name="search" color={t.placeholder} />
              <TextInput
                ref={search}
                value={query}
                onChangeText={setQuery}
                placeholder="Search everything you saved"
                placeholderTextColor={t.placeholder}
                returnKeyType="search"
                autoCorrect={false}
                accessibilityLabel="Search your drawer"
                style={s.searchInput}
              />
              {query ? (
                <Pressable onPress={() => setQuery('')} hitSlop={10} accessibilityLabel="Clear search">
                  <Icon name="close" color={t.placeholder} size={18} />
                </Pressable>
              ) : null}
            </View>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={s.chipScroll}
              contentContainerStyle={s.chips}
              keyboardShouldPersistTaps="handled"
            >
              <Chip label="All" selected={categoryId === null} onPress={() => setCategoryId(null)} />
              {categories.map((c, index) => (
                <Chip
                  key={c.id}
                  label={c.name}
                  bar={categoryHue(t, c.color, index).bar}
                  selected={categoryId === c.id}
                  onPress={() => setCategoryId(categoryId === c.id ? null : c.id)}
                  onLongPress={() => router.push('/categories')}
                />
              ))}
              <Chip label="Edit" dashed onPress={() => router.push('/categories')} accessibilityLabel="Manage categories" />
            </ScrollView>
          </>
        ) : null}
      </View>

      {notice ? (
        <Pressable
          onPress={dismiss}
          style={[s.notice, notice.tone === 'error' ? s.noticeError : s.noticeOk]}
          accessibilityRole="alert"
        >
          <Text style={[s.noticeText, { color: notice.tone === 'error' ? t.danger : t.hues.green.ink }]}>
            {notice.text}
          </Text>
        </Pressable>
      ) : null}

      {view === 'drawers' ? (
        <DrawersView
          categories={categories}
          onOpenItem={openItem}
          onActions={openActions}
          onSeeAll={(id) => {
            setCategoryId(id);
            setView('list');
          }}
          onManage={() => router.push('/categories')}
          bottomInset={insets.bottom}
        />
      ) : total === 0 ? (
        <Empty
          s={s}
          filtered={filtered}
          onClear={() => {
            setCategoryId(null);
            setQuery('');
          }}
          onSeed={__DEV__ && !filtered ? () => write(seedSampleData) : undefined}
        />
      ) : (
        <FlashList<FeedRow<LocalItem>>
          data={rows}
          keyExtractor={(row) => row.key}
          getItemType={(row) => row.type}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          renderItem={({ item: row, index }) =>
            row.type === 'header' ? (
              <Text style={[s.section, index > 0 && s.sectionLater]}>{row.label}</Text>
            ) : (
              <View style={s.rowGap}>
                <ItemRow item={row.item} onPress={openItem} onActions={openActions} />
              </View>
            )
          }
          onEndReached={loadMore}
          onEndReachedThreshold={0.8}
          contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 4, paddingBottom: insets.bottom + 24 }}
        />
      )}

      <ActionSheet itemId={sheetItem} onClose={closeSheet} />
    </View>
  );
}

function Empty({
  s,
  filtered,
  onClear,
  onSeed,
}: {
  s: Styles;
  filtered: boolean;
  onClear: () => void;
  onSeed?: () => void;
}) {
  if (filtered) {
    return (
      <View style={s.empty}>
        <Text style={s.emptyTitle}>Nothing matches</Text>
        <Pressable onPress={onClear} hitSlop={8} accessibilityRole="button">
          <Text style={s.emptyLink}>Clear search and filters</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={s.empty}>
      <Text style={s.emptyTitle}>Your drawer is empty</Text>
      <Text style={s.emptyBody}>
        Open any app, tap Share, and pick drowa. Links, places, screenshots, PDFs and notes all land here.
      </Text>
      {onSeed ? (
        <Pressable onPress={onSeed} hitSlop={8} accessibilityRole="button">
          <Text style={s.emptyLink}>Load sample data (dev)</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

type Styles = ReturnType<typeof styles>;
const styles = (t: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.bg },
    header: { paddingHorizontal: 20, paddingBottom: 12, gap: 16 },
    brandRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    buttons: { flexDirection: 'row', gap: 8 },

    search: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      height: 48,
      paddingHorizontal: 16,
      backgroundColor: t.surface,
      borderColor: t.border,
      borderWidth: 1,
      borderRadius: 16,
    },
    searchInput: { flex: 1, fontFamily: font.body400, fontSize: 16, color: t.text, paddingVertical: 0 },

    // Bleeds off the right edge, like the design, so the row reads as scrollable.
    chipScroll: { marginRight: -20 },
    chips: { gap: 8, paddingRight: 20 },

    notice: { marginHorizontal: 20, marginBottom: 8, padding: 12, borderRadius: 14 },
    noticeOk: { backgroundColor: t.hues.green.tint },
    noticeError: { backgroundColor: t.dangerBg, borderWidth: 1, borderColor: t.dangerBorder },
    noticeText: { fontFamily: font.body700, fontSize: 14 },

    section: {
      fontFamily: font.heading800,
      fontSize: 13,
      letterSpacing: 0.8,
      textTransform: 'uppercase',
      color: t.muted,
      paddingTop: 6,
      paddingHorizontal: 4,
      paddingBottom: 10,
    },
    sectionLater: { paddingTop: 10 },
    rowGap: { paddingBottom: 10 },

    empty: { alignItems: 'center', paddingHorizontal: 36, paddingTop: 64, gap: 10 },
    emptyTitle: { fontFamily: font.heading800, fontSize: 20, color: t.text },
    emptyBody: { fontFamily: font.body400, fontSize: 15, color: t.muted, textAlign: 'center', lineHeight: 22 },
    emptyLink: { fontFamily: font.heading800, fontSize: 15, color: t.hues.blue.ink, marginTop: 6 },
  });
