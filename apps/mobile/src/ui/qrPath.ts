import QRCode from 'qrcode';

/** The spec's minimum quiet zone, in modules. Scanners miss codes without it. */
const QUIET_ZONE = 4;

/**
 * A QR code as a single SVG path on a `size`×`size` grid, one unit per module,
 * quiet zone included — draw it with `viewBox="0 0 size size"`. One path with
 * horizontal runs merged keeps a dense code to a few hundred segments instead
 * of thousands of <Rect>s.
 *
 * Error correction M for short payloads (URLs), L for long ones, so a long
 * note stays as coarse as it can.
 */
export function qrPath(text: string): { size: number; d: string } {
  const bytes = new TextEncoder().encode(text).length;
  const { modules } = QRCode.create(text, { errorCorrectionLevel: bytes > 200 ? 'L' : 'M' });
  const n = modules.size;
  const parts: string[] = [];
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (!modules.get(y, x)) {
        x++;
        continue;
      }
      const start = x;
      while (x < n && modules.get(y, x)) x++;
      parts.push(`M${start + QUIET_ZONE} ${y + QUIET_ZONE}h${x - start}v1h-${x - start}z`);
    }
  }
  return { size: n + QUIET_ZONE * 2, d: parts.join('') };
}
