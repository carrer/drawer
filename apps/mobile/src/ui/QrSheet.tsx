import { useKeepAwake } from 'expo-keep-awake';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { QrSource } from '../data/qrSource.ts';
import { mintShare } from '../data/server.ts';
import type { LocalItem } from '../db/repo.ts';
import { font, useTheme } from '../theme.ts';
import { itemTitle } from './format.ts';
import { qrPath } from './qrPath.ts';

/**
 * Codes are counted down on the phone's clock from when the mint request was
 * *sent*, minus this margin — so the phone never shows a code the server has
 * already expired, whatever the two clocks think the time is.
 */
const SAFETY_MS = 1_000;
/** Ask for the next code this long before the current one runs out, so there's no gap. */
const PREFETCH_MS = 2_000;
/** Stop minting after this long: a sheet left open in a pocket shouldn't keep a live code up forever. */
const MAX_SESSION_MS = 5 * 60_000;

/**
 * Share as QR. Links and short notes are encoded directly; files get a
 * single-use link from the drawer that's replaced every 30 seconds while the
 * sheet is open. The code is always dark-on-white, even in dark mode — plenty
 * of scanners can't read an inverted code.
 */
export function QrSheet({
  item,
  source,
  onClose,
}: {
  item: LocalItem;
  source: Exclude<QrSource, { type: 'unavailable' }> | null;
  onClose: () => void;
}) {
  return (
    <Modal visible={source !== null} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      {source ? <Sheet item={item} source={source} onClose={onClose} /> : null}
    </Modal>
  );
}

function Sheet({
  item,
  source,
  onClose,
}: {
  item: LocalItem;
  source: Exclude<QrSource, { type: 'unavailable' }>;
  onClose: () => void;
}) {
  useKeepAwake();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const side = Math.min(width - 88, 320);

  const live = useLiveShare(source.type === 'server' ? item.id : null);
  const text = source.type === 'direct' ? source.text : live.code?.url ?? null;
  const qr = useMemo(() => (text ? qrPath(text) : null), [text]);
  // A whole number of points per module, so no row lands on a half-pixel seam.
  const drawn = qr ? Math.max(qr.size, Math.floor(side / qr.size) * qr.size) : side;

  const heading = source.type === 'direct' ? source.hint : 'Scan to download';
  const expired = source.type === 'server' && (!live.code || live.remainingMs <= 0);

  return (
    <View style={s.fill}>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: t.scrim }]} onPress={onClose} accessibilityLabel="Close" />
      <View style={[s.center, { paddingBottom: insets.bottom }]} pointerEvents="box-none">
        <View style={[s.card, { backgroundColor: t.surface }]}>
          <Text style={[s.heading, { color: t.text }]}>{heading}</Text>
          <Text style={[s.sub, { color: t.muted }]} numberOfLines={1}>
            {itemTitle(item)}
          </Text>

          <Pressable
            onPress={live.paused || live.error ? live.restart : undefined}
            accessibilityRole={live.paused || live.error ? 'button' : 'image'}
            accessibilityLabel={live.paused || live.error ? 'Show a new code' : 'QR code'}
            style={[s.qrCard, { width: side + 32, height: side + 32 }]}
          >
            {qr ? (
              <Svg width={drawn} height={drawn} viewBox={`0 0 ${qr.size} ${qr.size}`} style={expired && s.faded}>
                <Path d={qr.d} fill="#0F1B3D" />
              </Svg>
            ) : null}
            {expired ? (
              <View style={s.overlay}>
                {live.error ? (
                  <Text style={s.overlayText}>{live.error}{'\n\n'}Tap to try again</Text>
                ) : live.paused ? (
                  <Text style={s.overlayText}>Tap to show a new code</Text>
                ) : (
                  <ActivityIndicator color="#0F1B3D" size="large" />
                )}
              </View>
            ) : null}
          </Pressable>

          {source.type === 'server' ? (
            <View style={s.countdown}>
              <View style={[s.track, { backgroundColor: t.subtle }]}>
                <View
                  style={[
                    s.bar,
                    {
                      backgroundColor: t.primary,
                      width: `${live.code ? Math.max(0, Math.min(1, live.remainingMs / live.code.ttlMs)) * 100 : 0}%`,
                    },
                  ]}
                />
              </View>
              <Text style={[s.sub, { color: t.muted }]}>
                {expired
                  ? live.paused
                    ? 'Paused'
                    : live.error
                      ? 'Couldn’t get a code'
                      : 'Getting a fresh code…'
                  : `Works once · new code in ${Math.ceil(live.remainingMs / 1000)} s`}
              </Text>
            </View>
          ) : null}

          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            style={({ pressed }) => [s.done, { borderColor: t.border }, pressed && { opacity: 0.6 }]}
          >
            <Text style={[s.doneText, { color: t.text }]}>Done</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

type LiveCode = { url: string; deadline: number; ttlMs: number };

/**
 * Keeps a fresh share code on hand for `itemId` (null: do nothing). Mints the
 * next code just before the current one lapses; stops after MAX_SESSION_MS or
 * on the first error, until `restart`.
 */
function useLiveShare(itemId: string | null) {
  const [code, setCode] = useState<LiveCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [now, setNow] = useState(Date.now);
  const minting = useRef(false);
  const mounted = useRef(true);
  const sessionStart = useRef(Date.now());

  const mint = useCallback(async () => {
    if (!itemId || minting.current) return;
    minting.current = true;
    const sent = Date.now();
    try {
      const share = await mintShare(itemId);
      if (!mounted.current) return;
      setCode({ url: share.url, deadline: sent + share.ttlSeconds * 1000 - SAFETY_MS, ttlMs: share.ttlSeconds * 1000 });
      setError(null);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      minting.current = false;
    }
  }, [itemId]);

  useEffect(() => {
    mounted.current = true;
    if (!itemId) return;
    void mint();
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => {
      mounted.current = false;
      clearInterval(tick);
    };
  }, [itemId, mint]);

  // Timers don't run while the app is backgrounded; on return the first tick
  // finds the code lapsed and fetches a new one, which is exactly right.
  useEffect(() => {
    if (!itemId || !code || paused || error) return;
    if (code.deadline - now > PREFETCH_MS) return;
    if (now - sessionStart.current > MAX_SESSION_MS) setPaused(true);
    else void mint();
  }, [itemId, code, now, paused, error, mint]);

  const restart = useCallback(() => {
    sessionStart.current = Date.now();
    setPaused(false);
    setError(null);
    void mint();
  }, [mint]);

  return { code, error, paused, remainingMs: code ? code.deadline - now : 0, restart };
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  card: { borderRadius: 28, padding: 20, alignItems: 'center', gap: 14, alignSelf: 'stretch' },
  heading: { fontFamily: font.heading900, fontSize: 22, textAlign: 'center' },
  sub: { fontFamily: font.body400, fontSize: 14, textAlign: 'center' },
  qrCard: { backgroundColor: '#FFFFFF', borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  faded: { opacity: 0.12 },
  overlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center', padding: 28 },
  overlayText: { fontFamily: font.heading800, fontSize: 16, color: '#0F1B3D', textAlign: 'center' },
  countdown: { alignSelf: 'stretch', gap: 8 },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  bar: { height: 6, borderRadius: 3 },
  done: { alignSelf: 'stretch', height: 52, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  doneText: { fontFamily: font.heading800, fontSize: 16 },
});
