import { describe, expect, it } from 'vitest';
import { CHART_BAR, TOKENS, contrastRatio } from '../src/ui/tokens';

// Vitest stubs CSS imports (even ?raw), so read the stylesheet from disk. The module name is a
// variable so TypeScript doesn't need Node's type definitions for this one test-only call.
const fsModule = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: URL, encoding: 'utf8'): string };
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

describe('design tokens', () => {
  it('match the CSS variables', () => {
    for (const [name, hex] of Object.entries(TOKENS)) {
      const m = new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(css);
      expect(m?.[1]?.toUpperCase(), name).toBe(hex.toUpperCase());
    }
  });

  it('are a small set (4–6 colours)', () => {
    expect(Object.keys(TOKENS).length).toBeGreaterThanOrEqual(4);
    expect(Object.keys(TOKENS).length).toBeLessThanOrEqual(6);
  });

  it('meet WCAG AA for text', () => {
    expect(contrastRatio(TOKENS.cedar, TOKENS.fog)).toBeGreaterThanOrEqual(4.5); // body text
    expect(contrastRatio(TOKENS.cedar, '#ffffff')).toBeGreaterThanOrEqual(4.5); // text on panels
    expect(contrastRatio(TOKENS.fog, TOKENS.cedar)).toBeGreaterThanOrEqual(4.5); // button text
    expect(contrastRatio(TOKENS.shade, TOKENS.fog)).toBeGreaterThanOrEqual(4.5); // links
  });

  it('keep non-text marks visible (≥ 3:1)', () => {
    expect(contrastRatio(TOKENS.shade, TOKENS.fog)).toBeGreaterThanOrEqual(3); // focus ring
    expect(contrastRatio(CHART_BAR, '#ffffff')).toBeGreaterThanOrEqual(3); // inspector bars
  });

  it('computes contrast like WCAG', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 6);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 6);
  });
});
