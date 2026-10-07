// Colour-blind-safe ramp for sun-hours (cividis, after matplotlib) and the debug palette.
export type Rgb = [number, number, number];

const CIVIDIS: Rgb[] = [
  [0x00, 0x22, 0x4e], [0x12, 0x35, 0x70], [0x3b, 0x49, 0x6c], [0x57, 0x5d, 0x6d], [0x70, 0x71, 0x73],
  [0x8a, 0x86, 0x78], [0xa5, 0x9c, 0x74], [0xc3, 0xb3, 0x69], [0xfe, 0xe8, 0x38],
];

/** t in [0, 1] → cividis; dark blue (no sun) to yellow (full sun). */
export function cividis(t: number): Rgb {
  const x = Math.min(1, Math.max(0, Number.isNaN(t) ? 0 : t)) * (CIVIDIS.length - 1);
  const i = Math.min(CIVIDIS.length - 2, Math.floor(x));
  const f = x - i;
  const a = CIVIDIS[i]!, b = CIVIDIS[i + 1]!;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export const SUN_RGB = cividis(1);
export const SHADE_RGB = cividis(0);
export const CLASS_RGB: Record<0 | 1 | 2, Rgb> = { 0: cividis(0.08), 1: cividis(0.55), 2: cividis(1) };
export const WATER_RGB: Rgb = [176, 206, 222];

export const css = ([r, g, b]: Rgb) => `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`;

/** CSS linear-gradient for a legend bar, sampled from the ramp. */
export function cividisGradient(steps = 9): string {
  return `linear-gradient(to right, ${Array.from({ length: steps }, (_, i) => css(cividis(i / (steps - 1)))).join(', ')})`;
}
