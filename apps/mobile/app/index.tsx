import { Image } from 'expo-image';
import { useShareIntentContext } from 'expo-share-intent';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatBytes, ingestShareIntent, type CapturedArtifact } from '@/capture';
import { clearAll, loadCaptures, saveCaptures } from '@/store';
import { kindGlyph, useTheme, type Palette } from '@/theme';

/**
 * Phase 0 capture harness.
 *
 * Not the gallery — this screen exists to prove the gate: share from a real app,
 * see the bytes land on disk, survive a restart. Phase 2 replaces it with the
 * actual grid.
 */
export default function Home() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { isReady, hasShareIntent, shareIntent, resetShareIntent, error } = useShareIntentContext();

  const [items, setItems] = useState<CapturedArtifact[]>(() => loadCaptures());
  const [lastRaw, setLastRaw] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const ingesting = useRef(false);

  useEffect(() => {
    if (!hasShareIntent || ingesting.current) return;
    ingesting.current = true;
    setIngestError(null);
    setLastRaw(JSON.stringify(shareIntent, null, 2));

    ingestShareIntent(shareIntent)
      .then((captured) => {
        if (captured.length === 0) {
          setIngestError('share intent contained nothing we could store');
          return;
        }
        setItems((prev) => {
          const next = [...captured, ...prev];
          saveCaptures(next);
          return next;
        });
      })
      .catch((err: unknown) => setIngestError(String(err)))
      .finally(() => {
        ingesting.current = false;
        resetShareIntent();
      });
  }, [hasShareIntent, shareIntent, resetShareIntent]);

  const onClear = useCallback(() => {
    Alert.alert('Clear everything?', 'Deletes the captured list and the stored blobs.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: () => {
          clearAll(items);
          setItems([]);
          setLastRaw(null);
        },
      },
    ]);
  }, [items]);

  const s = styles(theme);
  const status = error ?? ingestError;

  return (
    <ScrollView
      style={[s.screen, { paddingTop: insets.top }]}
      contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
    >
      <View style={s.header}>
        <View>
          <Text style={s.title}>Drowa</Text>
          <Text style={s.subtitle}>
            {isReady ? 'share target armed' : 'starting…'} · {items.length} captured
          </Text>
        </View>
        <View style={s.badge}>
          <Text style={s.badgeText}>PHASE 0</Text>
        </View>
      </View>

      {status ? (
        <View style={[s.card, s.errorCard]}>
          <Text style={s.errorText}>{status}</Text>
        </View>
      ) : null}

      {items.length === 0 ? (
        <View style={s.empty}>
          <Text style={s.emptyGlyph}>🗄️</Text>
          <Text style={s.emptyTitle}>Nothing captured yet</Text>
          <Text style={s.emptyBody}>
            Open any app, hit Share, and pick <Text style={s.strong}>Drowa</Text>. A screenshot, a
            link, a PDF — whatever arrives shows up here with its hash and where the bytes landed.
          </Text>
        </View>
      ) : (
        items.map((item) => <Row key={item.id} item={item} theme={theme} />)
      )}

      {lastRaw ? (
        <View style={s.rawBlock}>
          <Pressable onPress={() => setShowRaw((v) => !v)} hitSlop={8}>
            <Text style={s.rawToggle}>{showRaw ? '▾' : '▸'} last raw ShareIntent</Text>
          </Pressable>
          {showRaw ? <Text style={s.rawText}>{lastRaw}</Text> : null}
        </View>
      ) : null}

      {items.length > 0 ? (
        <Pressable onPress={onClear} style={s.clear} hitSlop={8}>
          <Text style={s.clearText}>Clear all</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

function Row({ item, theme }: { item: CapturedArtifact; theme: Palette }) {
  const s = styles(theme);
  const preview = item.kind === 'image' && item.localUri;

  return (
    <View style={s.card}>
      <View style={s.thumb}>
        {preview ? (
          <Image source={{ uri: item.localUri! }} style={s.thumbImage} contentFit="cover" transition={120} />
        ) : (
          <Text style={s.thumbGlyph}>{kindGlyph[item.kind] ?? '📦'}</Text>
        )}
      </View>

      <View style={s.rowBody}>
        <View style={s.rowTop}>
          <Text style={s.kind}>{item.kind}</Text>
          {item.duplicate ? <Text style={s.dupe}>already had it</Text> : null}
        </View>

        <Text style={s.rowTitle} numberOfLines={2}>
          {item.title ?? item.url ?? item.body ?? '(untitled)'}
        </Text>

        {item.note ? (
          <Text style={s.note} numberOfLines={2}>
            {item.note}
          </Text>
        ) : null}

        <Text style={s.meta}>
          {item.sha256
            ? `${item.sha256.slice(0, 12)}… · ${formatBytes(item.byteSize)} · ${item.mimeType}`
            : new Date(item.capturedAt).toLocaleString()}
        </Text>
      </View>
    </View>
  );
}

const styles = (t: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.bg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 20,
      paddingTop: 16,
      paddingBottom: 12,
    },
    title: { fontSize: 30, fontWeight: '700', color: t.text, letterSpacing: -0.5 },
    subtitle: { fontSize: 13, color: t.muted, marginTop: 2 },
    badge: {
      backgroundColor: t.accentSoft,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    badgeText: { fontSize: 10, fontWeight: '700', color: t.accent, letterSpacing: 1 },

    card: {
      flexDirection: 'row',
      gap: 12,
      backgroundColor: t.surface,
      borderColor: t.border,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 14,
      padding: 12,
      marginHorizontal: 16,
      marginBottom: 10,
    },
    errorCard: { borderColor: t.warn, backgroundColor: t.accentSoft },
    errorText: { color: t.warn, fontSize: 13, flex: 1 },

    thumb: {
      width: 60,
      height: 60,
      borderRadius: 10,
      backgroundColor: t.bg,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    },
    thumbImage: { width: '100%', height: '100%' },
    thumbGlyph: { fontSize: 26 },

    rowBody: { flex: 1, gap: 3 },
    rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    kind: { fontSize: 11, fontWeight: '700', color: t.accent, textTransform: 'uppercase', letterSpacing: 0.6 },
    dupe: { fontSize: 11, color: t.good, fontWeight: '600' },
    rowTitle: { fontSize: 15, color: t.text, fontWeight: '500' },
    note: { fontSize: 13, color: t.muted, fontStyle: 'italic' },
    meta: { fontSize: 11, color: t.muted, fontVariant: ['tabular-nums'] },

    empty: { alignItems: 'center', paddingHorizontal: 40, paddingTop: 60, gap: 8 },
    emptyGlyph: { fontSize: 48 },
    emptyTitle: { fontSize: 18, fontWeight: '600', color: t.text },
    emptyBody: { fontSize: 14, color: t.muted, textAlign: 'center', lineHeight: 21 },
    strong: { color: t.accent, fontWeight: '700' },

    rawBlock: { marginHorizontal: 16, marginTop: 14 },
    rawToggle: { fontSize: 12, color: t.muted, fontWeight: '600' },
    rawText: {
      marginTop: 8,
      padding: 12,
      backgroundColor: t.surface,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      color: t.muted,
      fontSize: 11,
      fontFamily: 'monospace',
    },

    clear: { alignSelf: 'center', marginTop: 20, padding: 10 },
    clearText: { color: t.warn, fontSize: 14, fontWeight: '600' },
  });
