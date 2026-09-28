import { Pressable, StyleSheet, Text, View } from 'react-native';
import { font, useTheme } from '../theme.ts';

type Props = {
  label: string;
  /** The coloured bar before the label (category chips). */
  bar?: string | null;
  selected?: boolean;
  /** Dashed outline, for "Edit" / "+ Tag" style affordances. */
  dashed?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityLabel?: string;
};

/** The design's 40pt pill: white with a colour bar, navy when selected. */
export function Chip({ label, bar, selected = false, dashed = false, onPress, onLongPress, accessibilityLabel }: Props) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        s.chip,
        bar && !selected ? s.withBar : null,
        selected
          ? { backgroundColor: t.primary, borderColor: t.primary }
          : { backgroundColor: t.surface, borderColor: dashed ? t.dashed : t.border },
        dashed && s.dashed,
        pressed && { opacity: 0.7 },
      ]}
    >
      {bar && !selected ? <View style={[s.bar, { backgroundColor: bar }]} /> : null}
      <Text
        numberOfLines={1}
        style={[
          s.label,
          { color: selected ? t.onPrimary : dashed ? t.secondary : t.text },
          { fontFamily: selected ? font.heading800 : font.heading700 },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** The small 32pt tag pill from the action sheet. */
export function Pill({
  label,
  background,
  color,
  dashed,
  borderColor,
  onPress,
  accessibilityLabel,
}: {
  label: string;
  background: string;
  color: string;
  dashed?: boolean;
  borderColor?: string;
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      hitSlop={4}
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        s.pill,
        { backgroundColor: background },
        dashed && { borderWidth: 1, borderStyle: 'dashed', borderColor },
        pressed && { opacity: 0.7 },
      ]}
    >
      <Text style={[s.pillLabel, { color }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 40,
    paddingHorizontal: 16,
    borderRadius: 20,
    borderWidth: 1,
  },
  withBar: { paddingLeft: 10, paddingRight: 14 },
  dashed: { borderStyle: 'dashed' },
  bar: { width: 10, height: 16, borderRadius: 4 },
  label: { fontSize: 14, maxWidth: 180 },
  pill: { height: 32, paddingHorizontal: 12, borderRadius: 16, justifyContent: 'center' },
  pillLabel: { fontFamily: font.body700, fontSize: 14, maxWidth: 200 },
});
