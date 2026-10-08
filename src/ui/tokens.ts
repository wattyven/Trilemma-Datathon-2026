// Design tokens: West Coast fog, cedar and moss; sun and shade as the two accents.
// The same values live as CSS variables in styles.css (tests/tokens.test.ts keeps them in sync);
// this copy is for three.js, which can't read CSS.
export const TOKENS = {
  fog: '#F6F4EE', // page background
  cedar: '#1E2B25', // text, primary buttons
  moss: '#5E7A5A', // quiet accents
  sun: '#E9A23B', // sun marker, sun path, lot outline
  shade: '#2F4A62', // links, focus ring
  mist: '#D8D5CB', // borders, hairlines
} as const;

/** Chart hue for single-series sun-hours bars: validated for band, chroma and ≥ 3:1 on white. */
export const CHART_BAR = '#B7791F';

/** Scene materials (not UI tokens): ground, raised surfaces (roofs, canopy) and water. */
export const SCENE = {
  ground: '#E6E0CF',
  raised: '#B8C1AE',
  water: '#B0CEDE',
  sky: '#EEF2F5',
  horizon: '#8A8270',
} as const;

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG 2.x contrast ratio. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
