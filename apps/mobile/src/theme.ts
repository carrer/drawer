import type { ItemKind } from '@drawer/shared';
import { useColorScheme } from 'react-native';

/**
 * Design tokens from the "drowa app screens" design (light). The design defines
 * no dark theme; the dark palette below keeps its navy identity and inverts the
 * surfaces, and is ours rather than the designer's.
 */
export type Palette = {
  bg: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  placeholder: string;
  /** Neutral chip fill (tags). */
  subtle: string;
  /** Secondary label on neutral controls. */
  secondary: string;
  handle: string;
  dashed: string;
  scrim: string;
  primary: string;
  onPrimary: string;
  danger: string;
  dangerBg: string;
  dangerBorder: string;
  good: string;
};

export type Hue = {
  /** Solid mark: chip bar, drawer stripe, open-drawer pill. */
  bar: string;
  /** Icon square / category chip fill. */
  tint: string;
  /** Icon stroke / text on tint. */
  ink: string;
  /** Inside an open drawer. */
  panel: string;
};

type Theme = Palette & { hues: Record<HueName, Hue>; dark: boolean };

export type HueName = 'red' | 'yellow' | 'green' | 'blue' | 'purple' | 'slate';

const light: Theme = {
  dark: false,
  bg: '#F4F5FA',
  surface: '#FFFFFF',
  border: '#E2E5EE',
  text: '#0F1B3D',
  muted: '#5B6478',
  placeholder: '#6B7489',
  subtle: '#F0F2F7',
  secondary: '#3F4A63',
  handle: '#D5D9E4',
  dashed: '#B8BFCF',
  scrim: 'rgba(15, 27, 61, 0.45)',
  primary: '#0F1B3D',
  onPrimary: '#FFFFFF',
  danger: '#B3321F',
  dangerBg: '#FFF5F3',
  dangerBorder: '#F6CFC7',
  good: '#1E7A41',
  hues: {
    red: { bar: '#E8503A', tint: '#FDE6E2', ink: '#C23A26', panel: '#FEF3F1' },
    yellow: { bar: '#F5B621', tint: '#FEF2D3', ink: '#8A5E00', panel: '#FFF9EA' },
    green: { bar: '#2E9E57', tint: '#DDF3E5', ink: '#1E7A41', panel: '#EEF8F1' },
    blue: { bar: '#3478E8', tint: '#E1ECFD', ink: '#1F5BC4', panel: '#F0F5FE' },
    purple: { bar: '#7A5AF0', tint: '#ECE7FD', ink: '#5A3FC4', panel: '#F5F3FE' },
    slate: { bar: '#6B7489', tint: '#E9ECF3', ink: '#3F4A63', panel: '#F4F5FA' },
  },
};

const dark: Theme = {
  dark: true,
  bg: '#0B1226',
  surface: '#151D35',
  border: '#26304D',
  text: '#EEF1F8',
  muted: '#9AA3B8',
  placeholder: '#7D869B',
  subtle: '#1E2742',
  secondary: '#C3C9D6',
  handle: '#3A4460',
  dashed: '#4A5470',
  scrim: 'rgba(0, 0, 0, 0.6)',
  primary: '#EEF1F8',
  onPrimary: '#0F1B3D',
  danger: '#FF8A78',
  dangerBg: '#2A1618',
  dangerBorder: '#5A2A26',
  good: '#6ED396',
  hues: {
    red: { bar: '#E8503A', tint: '#3A1F24', ink: '#FF8B78', panel: '#1F1A2A' },
    yellow: { bar: '#F5B621', tint: '#3A3020', ink: '#F7C957', panel: '#1F1F28' },
    green: { bar: '#2E9E57', tint: '#173524', ink: '#6ED396', panel: '#14222A' },
    blue: { bar: '#3478E8', tint: '#1A2B4D', ink: '#8AB4FF', panel: '#16213D' },
    purple: { bar: '#7A5AF0', tint: '#2A2250', ink: '#B3A0FF', panel: '#1B1B3D' },
    slate: { bar: '#6B7489', tint: '#232C47', ink: '#C3C9D6', panel: '#18203A' },
  },
};

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}
export type { Theme };

/** Loaded in app/_layout.tsx. Android picks faces by family name, not fontWeight. */
export const font = {
  heading700: 'Nunito_700Bold',
  heading800: 'Nunito_800ExtraBold',
  heading900: 'Nunito_900Black',
  body400: 'NunitoSans_400Regular',
  body600: 'NunitoSans_600SemiBold',
  body700: 'NunitoSans_700Bold',
} as const;

/** Each kind's icon square colour. */
export const kindHue: Record<ItemKind, HueName> = {
  link: 'red',
  image: 'blue',
  document: 'purple',
  audio: 'green',
  video: 'yellow',
  text: 'slate',
};

export const kindLabel: Record<ItemKind, string> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  document: 'Document',
  link: 'Link',
  text: 'Note',
};

/** Swatches offered for a category, in the design's order. */
export const CATEGORY_HUES: HueName[] = ['red', 'yellow', 'green', 'blue', 'purple', 'slate'];

/**
 * A category's colours. Stored colours are hex (they sync); one that matches a
 * design hue gets that hue's full set, anything else is tinted from itself.
 * Uncoloured categories — the server's seeds have none — take a hue by
 * position, so the chip row is never grey.
 */
export function categoryHue(t: Theme, color: string | null, index: number): Hue {
  if (color) {
    const known = CATEGORY_HUES.find((h) => t.hues[h].bar.toLowerCase() === color.toLowerCase());
    if (known) return t.hues[known];
    return { bar: color, tint: `${color}29`, ink: t.text, panel: `${color}14` };
  }
  return t.hues[CATEGORY_HUES[index % (CATEGORY_HUES.length - 1)]!];
}
