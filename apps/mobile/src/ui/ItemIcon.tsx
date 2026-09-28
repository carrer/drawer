import { Image } from 'expo-image';
import { View } from 'react-native';
import type { LocalItem } from '../db/repo.ts';
import { kindHue, useTheme } from '../theme.ts';
import { Icon, kindIcon } from './icons.tsx';

/**
 * The tinted square that leads every row. Images whose bytes are on the device
 * show themselves instead of the glyph — a picture is its own best icon.
 */
export function ItemIcon({ item, size = 48 }: { item: Pick<LocalItem, 'id' | 'kind' | 'localPath'>; size?: number }) {
  const t = useTheme();
  const hue = t.hues[kindHue[item.kind]];
  const radius = size >= 64 ? 18 : 14;

  if (item.kind === 'image' && item.localPath) {
    return (
      <Image
        source={{ uri: item.localPath }}
        recyclingKey={item.id}
        contentFit="cover"
        transition={100}
        style={{ width: size, height: size, borderRadius: radius, backgroundColor: hue.tint }}
      />
    );
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        backgroundColor: hue.tint,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon name={kindIcon[item.kind]} color={hue.ink} size={Math.round(size * 0.46)} />
    </View>
  );
}
