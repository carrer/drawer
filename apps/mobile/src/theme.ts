import { useColorScheme } from 'react-native';

export type Palette = {
  bg: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentSoft: string;
  good: string;
  warn: string;
};

const palettes: Record<'light' | 'dark', Palette> = {
  light: {
    bg: '#faf9f7',
    surface: '#ffffff',
    border: '#e5e1da',
    text: '#1b1917',
    muted: '#6f6a64',
    accent: '#b4530a',
    accentSoft: '#fdf1e5',
    good: '#2f7d4f',
    warn: '#9a6100',
  },
  dark: {
    bg: '#161513',
    surface: '#201e1b',
    border: '#332f2a',
    text: '#f2efe9',
    muted: '#a09a92',
    accent: '#f0954a',
    accentSoft: '#2c2118',
    good: '#6dc08d',
    warn: '#e0a94a',
  },
};

export function useTheme(): Palette {
  return useColorScheme() === 'dark' ? palettes.dark : palettes.light;
}

export const kindGlyph: Record<string, string> = {
  image: '🖼',
  video: '🎬',
  audio: '🎵',
  document: '📄',
  link: '🔗',
  text: '📝',
};
