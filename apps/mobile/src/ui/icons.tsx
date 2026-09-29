import type { ItemKind } from '@drawer/shared';
import Svg, { Circle, G, Line, Path, Rect } from 'react-native-svg';

/** Stroke icons from the design, drawn on a 24×24 grid. */
export type IconName =
  | 'music'
  | 'link'
  | 'doc'
  | 'image'
  | 'video'
  | 'note'
  | 'search'
  | 'sort'
  | 'drawers'
  | 'list'
  | 'dots'
  | 'external'
  | 'share'
  | 'qr'
  | 'trash'
  | 'close'
  | 'plus';

type Props = { name: IconName; size?: number; color: string; strokeWidth?: number };

export function Icon({ name, size = 20, color, strokeWidth = 2 }: Props) {
  if (name === 'dots') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
        <Circle cx="5" cy="12" r="2" />
        <Circle cx="12" cy="12" r="2" />
        <Circle cx="19" cy="12" r="2" />
      </Svg>
    );
  }
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </Svg>
  );
}

const paths: Record<Exclude<IconName, 'dots'>, React.ReactNode> = {
  music: (
    <>
      <Path d="M9 18V5l11-2v13" />
      <Circle cx="6" cy="18" r="3" />
      <Circle cx="17" cy="16" r="3" />
    </>
  ),
  link: (
    <>
      <Path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <Path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  ),
  doc: (
    <>
      <Path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <Path d="M14 3v5h5" />
    </>
  ),
  image: (
    <>
      <Rect x="3" y="4" width="18" height="16" rx="3" />
      <Circle cx="9" cy="10" r="2" />
      <Path d="M21 17l-5-5-9 8" />
    </>
  ),
  video: (
    <>
      <Rect x="3" y="5" width="18" height="14" rx="3" />
      <Path d="M10 9.5v5l4.5-2.5z" />
    </>
  ),
  note: (
    <>
      <Rect x="4" y="3" width="16" height="18" rx="3" />
      <Path d="M8 8h8M8 12h8M8 16h5" />
    </>
  ),
  search: (
    <>
      <Circle cx="11" cy="11" r="7" />
      <Path d="M20 20l-3.5-3.5" />
    </>
  ),
  sort: <Path d="M4 7h16M7 12h10M10 17h4" />,
  drawers: (
    <>
      <Rect x="3" y="4" width="18" height="7" rx="2" />
      <Rect x="3" y="13" width="18" height="7" rx="2" />
      <Path d="M10 7.5h4M10 16.5h4" />
    </>
  ),
  list: <Path d="M4 6h16M4 12h16M4 18h16" />,
  external: (
    <>
      <Path d="M14 4h6v6" />
      <Path d="M20 4l-9 9" />
      <Path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
    </>
  ),
  share: (
    <>
      <Path d="M12 3v13" />
      <Path d="M7 8l5-5 5 5" />
      <Path d="M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
    </>
  ),
  trash: (
    <>
      <Path d="M4 7h16" />
      <Path d="M10 11v6M14 11v6" />
      <Path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
      <Path d="M9 7V4h6v3" />
    </>
  ),
  qr: (
    <>
      <Rect x="4" y="4" width="6" height="6" rx="1" />
      <Rect x="14" y="4" width="6" height="6" rx="1" />
      <Rect x="4" y="14" width="6" height="6" rx="1" />
      <Path d="M14 14h2v2M20 14v.01M14 20h.01M17 17v3h3" />
    </>
  ),
  close: <Path d="M6 6l12 12M18 6L6 18" />,
  plus: <Path d="M12 5v14M5 12h14" />,
};

export const kindIcon: Record<ItemKind, IconName> = {
  link: 'link',
  image: 'image',
  document: 'doc',
  audio: 'music',
  video: 'video',
  text: 'note',
};

/** The drowa wordmark. The drawer "o" keeps its brand colours in both themes. */
export function Logo({ color, height = 34 }: { color: string; height?: number }) {
  return (
    <Svg width={(height * 124) / 34} height={height} viewBox="-10 60 1140 290" accessibilityLabel="drowa">
      <G fill="none" stroke={color} strokeWidth={52} strokeLinecap="round" strokeLinejoin="round">
        <Circle cx="130" cy="230" r="74" />
        <Line x1="204" y1="56" x2="204" y2="304" />
        <Path d="M290 304 V230 A74 74 0 0 1 364 156 H378" />
        <Path d="M706 156 L750 304 L791 200 L832 304 L876 156" />
        <Circle cx="1010" cy="230" r="74" />
        <Line x1="1084" y1="156" x2="1084" y2="304" />
      </G>
      <Rect x="452" y="92" width="44" height="80" rx="14" fill="#E8503A" />
      <Rect x="508" y="80" width="44" height="90" rx="14" fill="#F5B621" />
      <Rect x="564" y="96" width="44" height="80" rx="14" fill="#2E9E57" />
      <Rect x="430" y="130" width="200" height="200" rx="52" fill="#3478E8" />
      <Rect x="484" y="246" width="92" height="28" rx="14" fill="#FFFFFF" />
    </Svg>
  );
}
