import { describe, expect, it } from 'vitest';
import env from '../.env?raw';
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

describe('link previews', () => {
  const meta = (attr: string, key: string) => new RegExp(`<meta ${attr}="${key}" content="([^"]+)"`).exec(html)?.[1];

  it('has an Open Graph card with an absolute image URL and size', () => {
    expect(meta('property', 'og:title')).toContain('VanShade');
    expect(meta('property', 'og:description')).toBeTruthy();
    expect(meta('property', 'og:url')).toBe('%VITE_SITE_URL%');
    expect(meta('property', 'og:image')).toBe('%VITE_SITE_URL%og-image.jpg');
    expect(meta('property', 'og:image:width')).toBe('1200');
    expect(meta('property', 'og:image:height')).toBe('630');
    expect(meta('name', 'twitter:card')).toBe('summary_large_image');
    expect(html).toContain('<link rel="canonical" href="%VITE_SITE_URL%" />');
  });

  it('gets the site address from .env, as an absolute URL ending in a slash', () => {
    const url = /^VITE_SITE_URL=(.+)$/m.exec(env)?.[1];
    expect(url).toMatch(/^https:\/\/[^/]+\/(.+\/)?$/);
    expect(env).toMatch(/^VITE_BUILD_SHA=dev$/m); // the local build id, which CI replaces
  });
});

describe('vite config', () => {
  it('serves from the root of vanshade.ca', () => {
    expect(viteConfig.base).toBe('/');
    expect(new URL(/^VITE_SITE_URL=(.+)$/m.exec(env)![1]!).pathname).toBe(viteConfig.base); // links and assets agree
  });
});
