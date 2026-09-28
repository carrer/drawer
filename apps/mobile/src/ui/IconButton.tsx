import { Pressable, StyleSheet } from 'react-native';
import { useTheme } from '../theme.ts';
import { Icon, type IconName } from './icons.tsx';

/** The design's 44pt square header button. `active` fills it navy (e.g. a non-default sort). */
export function IconButton({
  name,
  label,
  onPress,
  active = false,
}: {
  name: IconName;
  label: string;
  onPress: () => void;
  active?: boolean;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [
        s.button,
        active
          ? { backgroundColor: t.primary, borderColor: t.primary }
          : { backgroundColor: t.surface, borderColor: t.border },
        pressed && { opacity: 0.7 },
      ]}
    >
      <Icon name={name} color={active ? t.onPrimary : t.text} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  button: { width: 44, height: 44, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
