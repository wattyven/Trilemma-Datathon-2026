import { describe, expect, it } from 'vitest';
import html from '../index.html?raw';
import viteConfig from '../vite.config';

describe('index.html', () => {
  it('never sets a no-referrer policy (the DataBC WFS needs a Referer for CORS)', () => {
    expect(html).not.toMatch(/<meta[^>]+name=["']referrer["'][^>]*no-referrer/i);
    expect(html).not.toMatch(/referrerpolicy=["']no-referrer/i);
  });

  it('loads the app entry and exposes the build id', () => {
    expect(html).toContain('<script type="module" src="/src/main.ts"></script>');
    expect(html).toContain('<meta name="vanshade-build" content="%VITE_BUILD_SHA%" />');
  });
});

describe('vite config', () => {
  it('serves under the GitHub Pages repo path', () => {
    expect(viteConfig.base).toBe('/VanShade/');
  });
});
