import { useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { canShare, primaryAction, shareItem } from '../data/actions.ts';
import { qrSource, type QrSource } from '../data/qrSource.ts';
import { useCategories, useItem, useWrite } from '../data/store.tsx';
import { deleteItem, getItem, updateItem } from '../db/repo.ts';
import { categoryHue, font, useTheme } from '../theme.ts';
import { Pill } from './Chip.tsx';
import { itemDescriptor, itemTitle, normalizeTag, savedAgo } from './format.ts';
import { Icon } from './icons.tsx';
import { ItemIcon } from './ItemIcon.tsx';
import { QrSheet } from './QrSheet.tsx';

/**
 * Item actions (⋯ or long-press on a row): what it is, where it's filed, and
 * what you do with a saved thing — open it, share it (as a file or a QR code
 * someone else scans), bin it.
 */
export function ActionSheet({ itemId, onClose }: { itemId: string | null; onClose: () => void }) {
  return (
    <Modal visible={itemId !== null} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      {itemId ? <Sheet itemId={itemId} onClose={onClose} /> : null}
    </Modal>
  );
}

function Sheet({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const write = useWrite();
  const item = useItem(itemId);
  const categories = useCategories();
  const [tagDraft, setTagDraft] = useState<string | null>(null);
  const [qr, setQr] = useState<Exclude<QrSource, { type: 'unavailable' }> | null>(null);

  // Deleted from elsewhere (or just now): nothing left to act on.
  useEffect(() => {
    if (!item || item.deletedAt) onClose();
  }, [item, onClose]);
  if (!item || item.deletedAt) return null;

  const primary = primaryAction(item);
  const filed = categories
    .map((c, index) => ({ c, hue: categoryHue(t, c.color, index) }))
    .filter(({ c }) => item.categoryIds.includes(c.id));

  const fail = (what: string) => (err: unknown) =>
    Alert.alert(what, err instanceof Error ? err.message : String(err));

  // Tag edits read the row's current tags inside the write: Done fires both
  // submit and blur, and both would otherwise act on the same stale render.
  const addTag = () => {
    const tag = normalizeTag(tagDraft ?? '');
    setTagDraft(null);
    if (!tag) return;
    write((db) => {
      const tags = getItem(db, item.id)?.tags ?? [];
      if (!tags.includes(tag)) updateItem(db, item.id, { tags: [...tags, tag] });
    });
  };
  const removeTag = (tag: string) =>
    write((db) => {
      const tags = getItem(db, item.id)?.tags ?? [];
      updateItem(db, item.id, { tags: tags.filter((x) => x !== tag) });
    });

  const showQr = () => {
    const source = qrSource(item);
    if (source.type === 'unavailable') Alert.alert('Can’t share as QR', source.reason);
    else setQr(source);
  };

  const confirmDelete = () =>
    Alert.alert('Delete this item?', 'It disappears from every device once synced.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => write((db) => deleteItem(db, item.id)) },
    ]);

  return (
    <KeyboardAvoidingView behavior="padding" style={s.fill}>
      <Pressable style={[s.fill, { backgroundColor: t.scrim }]} onPress={onClose} accessibilityLabel="Close" />
      <View style={[s.sheet, { backgroundColor: t.surface, paddingBottom: insets.bottom + 28 }]}>
        <View style={[s.handle, { backgroundColor: t.handle }]} />

        <View style={s.head}>
          <ItemIcon item={item} size={64} />
          <View style={s.headText}>
            <Text style={[s.title, { color: t.text }]} numberOfLines={2}>
              {itemTitle(item)}
            </Text>
            <Text style={[s.sub, { color: t.muted }]} numberOfLines={1}>
              {itemDescriptor(item)} · {savedAgo(item.capturedAt)}
            </Text>
          </View>
        </View>

        <View style={s.pills}>
          {filed.map(({ c, hue }) => (
            <Pill key={c.id} label={c.name} background={hue.tint} color={hue.ink} />
          ))}
          {item.tags.map((tag) => (
            <Pill
              key={tag}
              label={`#${tag}  ×`}
              background={t.subtle}
              color={t.text}
              onPress={() => removeTag(tag)}
              accessibilityLabel={`Remove tag ${tag}`}
            />
          ))}
          {tagDraft === null ? (
            <Pill
              label="+ Tag"
              background={t.surface}
              color={t.secondary}
              dashed
              borderColor={t.dashed}
              onPress={() => setTagDraft('')}
            />
          ) : (
            <TextInput
              autoFocus
              value={tagDraft}
              onChangeText={setTagDraft}
              onSubmitEditing={addTag}
              onBlur={addTag}
              placeholder="tag"
              placeholderTextColor={t.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              style={[s.tagInput, { borderColor: t.dashed, color: t.text }]}
            />
          )}
        </View>

        <View style={s.actions}>
          <Pressable
            onPress={() => {
              onClose();
              Promise.resolve(primary.run()).catch(fail('Could not open it'));
            }}
            accessibilityRole="button"
            style={({ pressed }) => [s.primary, { backgroundColor: t.primary }, pressed && { opacity: 0.85 }]}
          >
            <Icon name={primary.icon} color={t.onPrimary} strokeWidth={2.2} />
            <Text style={[s.primaryText, { color: t.onPrimary }]} numberOfLines={1}>
              {primary.label}
            </Text>
          </Pressable>
          <View style={s.row}>
            <Pressable
              onPress={() => shareItem(item).catch(fail('Could not share it'))}
              disabled={!canShare(item)}
              accessibilityRole="button"
              style={({ pressed }) => [
                s.secondary,
                { backgroundColor: t.surface, borderColor: t.border },
                (pressed || !canShare(item)) && { opacity: 0.5 },
              ]}
            >
              <Icon name="share" color={t.text} strokeWidth={2.2} />
              <Text style={[s.secondaryText, { color: t.text }]}>Share</Text>
            </Pressable>
            <Pressable
              onPress={showQr}
              accessibilityRole="button"
              accessibilityLabel="Share as QR code"
              style={({ pressed }) => [
                s.secondary,
                { backgroundColor: t.surface, borderColor: t.border },
                pressed && { opacity: 0.5 },
              ]}
            >
              <Icon name="qr" color={t.text} strokeWidth={2.2} />
              <Text style={[s.secondaryText, { color: t.text }]}>QR</Text>
            </Pressable>
            <Pressable
              onPress={confirmDelete}
              accessibilityRole="button"
              style={({ pressed }) => [
                s.secondary,
                { backgroundColor: t.dangerBg, borderColor: t.dangerBorder },
                pressed && { opacity: 0.7 },
              ]}
            >
              <Icon name="trash" color={t.danger} strokeWidth={2.2} />
              <Text style={[s.secondaryText, { color: t.danger }]}>Delete</Text>
            </Pressable>
          </View>
        </View>
      </View>
      <QrSheet item={item} source={qr} onClose={() => setQr(null)} />
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 12,
    paddingHorizontal: 20,
    gap: 20,
  },
  handle: { width: 40, height: 5, borderRadius: 3, alignSelf: 'center' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  headText: { flex: 1, minWidth: 0, gap: 4 },
  title: { fontFamily: font.heading900, fontSize: 20 },
  sub: { fontFamily: font.body400, fontSize: 14 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  tagInput: {
    height: 32,
    minWidth: 96,
    paddingHorizontal: 12,
    paddingVertical: 0,
    borderRadius: 16,
    borderWidth: 1,
    borderStyle: 'dashed',
    fontFamily: font.body600,
    fontSize: 14,
  },
  actions: { gap: 10 },
  primary: {
    height: 56,
    borderRadius: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 16,
  },
  primaryText: { fontFamily: font.heading800, fontSize: 17 },
  row: { flexDirection: 'row', gap: 10 },
  secondary: {
    flex: 1,
    height: 56,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  secondaryText: { fontFamily: font.heading800, fontSize: 16 },
});
