import { Image } from 'expo-image';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { canShare, primaryAction, shareItem } from '@/data/actions';
import { useCategories, useItem, useWrite } from '@/data/store';
import { deleteItem, setImageSize, updateItem, type LocalItem } from '@/db/repo';
import { categoryHue, font, useTheme, type Theme } from '@/theme';
import { Chip } from '@/ui/Chip';
import { formatBytes, itemDescriptor, itemTitle, savedAgo } from '@/ui/format';
import { Icon } from '@/ui/icons';
import { ItemIcon } from '@/ui/ItemIcon';

/** Images keep their shape, within reason: at most twice as tall as wide, or as wide as tall. */
function aspectOf(item: Pick<LocalItem, 'width' | 'height'>): number {
  if (!item.width || !item.height) return 1;
  return Math.min(2, Math.max(0.5, item.width / item.height));
}

export default function ItemDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const s = styles(t);
  const insets = useSafeAreaInsets();
  const write = useWrite();
  const item = useItem(id);
  const categories = useCategories();

  const header = (
    <Stack.Screen
      options={{
        headerShown: true,
        title: '',
        headerStyle: { backgroundColor: t.bg },
        headerTintColor: t.text,
        headerShadowVisible: false,
      }}
    />
  );

  if (!item || item.deletedAt) {
    return (
      <View style={[s.screen, s.gone]}>
        {header}
        <Text style={s.goneText}>{item ? 'This item was deleted.' : 'No such item.'}</Text>
        <Pressable onPress={() => router.back()} hitSlop={8} accessibilityRole="button">
          <Text style={s.goneLink}>Back to your drawer</Text>
        </Pressable>
      </View>
    );
  }

  const toggleCategory = (categoryId: string) => {
    const next = item.categoryIds.includes(categoryId)
      ? item.categoryIds.filter((c) => c !== categoryId)
      : [...item.categoryIds, categoryId];
    write((db) => updateItem(db, item.id, { categoryIds: next }));
  };

  const confirmDelete = () =>
    Alert.alert('Delete this item?', 'It disappears from every device once synced.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          write((db) => deleteItem(db, item.id));
          router.back();
        },
      },
    ]);

  const fail = (what: string) => (err: unknown) => Alert.alert(what, err instanceof Error ? err.message : String(err));
  // On this screen the item is already open — only an action that leaves the app earns the big button.
  const primary = item.kind === 'image' || item.kind === 'text' ? null : primaryAction(item);

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
      keyboardShouldPersistTaps="handled"
    >
      {header}

      {item.kind === 'image' && item.localPath ? (
        <ImageHero item={item} s={s} onSize={(w, h) => write((db) => setImageSize(db, item.id, w, h))} />
      ) : null}

      <View style={s.head}>
        {item.kind === 'image' && item.localPath ? null : <ItemIcon item={item} size={64} />}
        <View style={s.headText}>
          <Text style={s.title}>{itemTitle(item)}</Text>
          <Text style={s.sub}>
            {itemDescriptor(item)} · {savedAgo(item.capturedAt)}
          </Text>
        </View>
      </View>

      <View style={s.actions}>
        {primary ? (
          <Pressable
            onPress={() => Promise.resolve(primary.run()).catch(fail('Could not open it'))}
            accessibilityRole="button"
            style={({ pressed }) => [s.primary, pressed && { opacity: 0.85 }]}
          >
            <Icon name={primary.icon} color={t.onPrimary} strokeWidth={2.2} />
            <Text style={s.primaryText} numberOfLines={1}>
              {primary.label}
            </Text>
          </Pressable>
        ) : null}
        <View style={s.actionRow}>
          <Pressable
            onPress={() => shareItem(item).catch(fail('Could not share it'))}
            disabled={!canShare(item)}
            accessibilityRole="button"
            style={({ pressed }) => [s.secondary, (pressed || !canShare(item)) && { opacity: 0.5 }]}
          >
            <Icon name="share" color={t.text} strokeWidth={2.2} />
            <Text style={s.secondaryText}>Share</Text>
          </Pressable>
          <Pressable
            onPress={confirmDelete}
            accessibilityRole="button"
            style={({ pressed }) => [s.secondary, s.danger, pressed && { opacity: 0.7 }]}
          >
            <Icon name="trash" color={t.danger} strokeWidth={2.2} />
            <Text style={[s.secondaryText, { color: t.danger }]}>Delete</Text>
          </Pressable>
        </View>
      </View>

      <View style={s.section}>
        <Field
          key={`title-${item.id}`}
          s={s}
          label="Title"
          value={item.title}
          placeholder={item.linkTitle ?? 'Add a title'}
          onSave={(title) => write((db) => updateItem(db, item.id, { title }))}
        />
        {item.kind === 'text' ? (
          <Field
            key={`body-${item.id}`}
            s={s}
            label="Note"
            value={item.body}
            multiline
            onSave={(body) => write((db) => updateItem(db, item.id, { body: body ?? '' }))}
          />
        ) : null}
        <Field
          key={`note-${item.id}`}
          s={s}
          label={item.kind === 'text' ? 'Why you saved it' : 'Note'}
          value={item.note}
          placeholder="Why did you save this?"
          multiline
          onSave={(note) => write((db) => updateItem(db, item.id, { note }))}
        />
      </View>

      <View style={s.section}>
        <Text style={s.label}>Categories</Text>
        <View style={s.chips}>
          {categories.map((c, index) => (
            <Chip
              key={c.id}
              label={c.name}
              bar={categoryHue(t, c.color, index).bar}
              selected={item.categoryIds.includes(c.id)}
              onPress={() => toggleCategory(c.id)}
            />
          ))}
        </View>
      </View>

      <View style={s.section}>
        <Text style={s.label}>Details</Text>
        <View style={s.card}>
          {item.url ? <Detail s={s} k="Link" v={item.url} /> : null}
          <Detail s={s} k="Saved" v={new Date(item.capturedAt).toLocaleString()} />
          {item.mimeType ? <Detail s={s} k="Type" v={item.mimeType} /> : null}
          {item.byteSize !== null ? <Detail s={s} k="Size" v={formatBytes(item.byteSize)} /> : null}
          {item.width && item.height ? <Detail s={s} k="Pixels" v={`${item.width} × ${item.height}`} /> : null}
          {item.sha256 ? <Detail s={s} k="SHA-256" v={item.sha256} mono /> : null}
          {item.sourceApp ? <Detail s={s} k="From" v={item.sourceApp} /> : null}
          <Detail s={s} k="Sync" v={item.uploadError ? `${item.syncState} — ${item.uploadError}` : item.syncState} />
          {item.localPath ? null : <Detail s={s} k="Original" v="Not on this device" />}
        </View>
      </View>
    </ScrollView>
  );
}

function ImageHero({ item, s, onSize }: { item: LocalItem; s: Styles; onSize: (w: number, h: number) => void }) {
  const [viewing, setViewing] = useState(false);
  return (
    <>
      <Pressable onPress={() => setViewing(true)} accessibilityLabel="View full screen" style={s.heroWrap}>
        <Image
          source={{ uri: item.localPath! }}
          style={[s.hero, { aspectRatio: aspectOf(item) }]}
          contentFit="cover"
          onLoad={(e) => {
            if (!item.width || !item.height) onSize(e.source.width, e.source.height);
          }}
        />
      </Pressable>
      <Modal visible={viewing} animationType="fade" onRequestClose={() => setViewing(false)} statusBarTranslucent>
        <Pressable style={s.viewer} onPress={() => setViewing(false)} accessibilityLabel="Close">
          <Image source={{ uri: item.localPath! }} style={s.viewerImage} contentFit="contain" />
        </Pressable>
      </Modal>
    </>
  );
}

/**
 * A text field that saves when it loses focus, and only if it changed. Keeps its
 * own draft so typing doesn't write to SQLite (and re-render) per keystroke.
 */
function Field({
  s,
  label,
  value,
  onSave,
  ...input
}: {
  s: Styles;
  label: string;
  value: string | null;
  onSave: (value: string | null) => void;
} & Pick<TextInputProps, 'placeholder' | 'multiline'>) {
  const t = useTheme();
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => setDraft(value ?? ''), [value]);

  return (
    <View style={s.field}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        {...input}
        value={draft}
        onChangeText={setDraft}
        onEndEditing={() => {
          if (draft !== (value ?? '')) onSave(draft.trim() === '' ? null : draft);
        }}
        placeholderTextColor={t.placeholder}
        style={[s.input, input.multiline && s.inputMulti]}
        textAlignVertical={input.multiline ? 'top' : 'center'}
      />
    </View>
  );
}

function Detail({ s, k, v, mono }: { s: Styles; k: string; v: string; mono?: boolean }) {
  return (
    <View style={s.detail}>
      <Text style={s.detailKey}>{k}</Text>
      <Text style={[s.detailValue, mono && s.mono]} selectable>
        {v}
      </Text>
    </View>
  );
}

type Styles = ReturnType<typeof styles>;
const styles = (t: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.bg },
    gone: { alignItems: 'center', justifyContent: 'center', gap: 12 },
    goneText: { fontFamily: font.body400, color: t.muted, fontSize: 16 },
    goneLink: { fontFamily: font.heading800, color: t.hues.blue.ink, fontSize: 15 },

    heroWrap: { marginHorizontal: 20, marginBottom: 16, borderRadius: 20, overflow: 'hidden' },
    hero: { width: '100%', backgroundColor: t.surface },
    viewer: { flex: 1, backgroundColor: '#000' },
    viewerImage: { flex: 1 },

    head: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20 },
    headText: { flex: 1, minWidth: 0, gap: 4 },
    title: { fontFamily: font.heading900, fontSize: 24, color: t.text },
    sub: { fontFamily: font.body400, fontSize: 14, color: t.muted },

    actions: { paddingHorizontal: 20, paddingTop: 20, gap: 10 },
    primary: {
      height: 56,
      borderRadius: 18,
      backgroundColor: t.primary,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      paddingHorizontal: 16,
    },
    primaryText: { fontFamily: font.heading800, fontSize: 17, color: t.onPrimary },
    actionRow: { flexDirection: 'row', gap: 10 },
    secondary: {
      flex: 1,
      height: 56,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: t.border,
      backgroundColor: t.surface,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    },
    danger: { backgroundColor: t.dangerBg, borderColor: t.dangerBorder },
    secondaryText: { fontFamily: font.heading800, fontSize: 16, color: t.text },

    section: { paddingHorizontal: 20, paddingTop: 24, gap: 10 },
    label: {
      fontFamily: font.heading800,
      fontSize: 13,
      letterSpacing: 0.8,
      textTransform: 'uppercase',
      color: t.muted,
      paddingHorizontal: 4,
    },
    field: { gap: 8 },
    input: {
      backgroundColor: t.surface,
      borderColor: t.border,
      borderWidth: 1,
      borderRadius: 16,
      paddingHorizontal: 16,
      paddingVertical: 12,
      fontFamily: font.body400,
      fontSize: 16,
      color: t.text,
    },
    inputMulti: { minHeight: 104 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },

    card: { backgroundColor: t.surface, borderRadius: 18, padding: 16, gap: 10 },
    detail: { flexDirection: 'row', gap: 12 },
    detailKey: { width: 72, fontFamily: font.body600, fontSize: 13, color: t.muted },
    detailValue: { flex: 1, fontFamily: font.body400, fontSize: 13, color: t.text },
    mono: { fontFamily: 'monospace', fontSize: 12 },
  });
