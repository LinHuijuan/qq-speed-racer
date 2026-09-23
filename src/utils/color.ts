/**
 * Append an alpha channel to a hex colour, for the places where a palette value
 * has to become a CSS glow (`--track-glow`, `--car-glow`).
 *
 * Only the `#rgb` and `#rrggbb` forms the track and car palettes actually use
 * are handled. Anything else is returned untouched, so a bad value degrades to
 * "no tint" instead of producing `rgba(NaN, NaN, NaN, ...)` and a dropped rule.
 */
export function withAlpha(color: string, alpha: number): string {
  const hex = color.trim();
  if (!hex.startsWith('#')) return hex;

  let r: number;
  let g: number;
  let b: number;
  if (hex.length === 4) {
    r = parseInt(hex[1] + hex[1], 16);
    g = parseInt(hex[2] + hex[2], 16);
    b = parseInt(hex[3] + hex[3], 16);
  } else if (hex.length === 7) {
    r = parseInt(hex.slice(1, 3), 16);
    g = parseInt(hex.slice(3, 5), 16);
    b = parseInt(hex.slice(5, 7), 16);
  } else {
    return hex;
  }

  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return hex;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
