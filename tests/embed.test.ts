import { describe, expect, it } from 'vitest';
import readme from '../README.md?raw';
import { embedSnippet, escapeAttr, fullSiteUrl } from '../src/embed';
import { decodeHash } from '../src/urlState';

const PAGE = 'https://vanshade.ca/';
const state = { address: '453 W 12th Ave, Vancouver, BC', mode: 'moment' as const, date: '2026-06-21', time: '15:30', debug: true };

describe('embedding', () => {
  it('copies an iframe for this lot and time, in the compact layout, without the debug flag', () => {
    const code = embedSnippet(PAGE, state, { mode: 'season' }, 'VanShade: sun and shade at 453 W 12th Ave, Vancouver, BC');
    expect(code).toMatch(/^<iframe src="https:\/\/vanshade\.ca\/#[^"]+" width="100%" height="600" style="border:0" loading="lazy" title="[^"]+"><\/iframe>$/);
    const src = /src="([^"]+)"/.exec(code)![1]!.replace(/&amp;/g, '&');
    expect(decodeHash(new URL(src).hash)).toEqual({ address: state.address, mode: 'moment', date: '2026-06-21', time: '15:30', embed: true });
  });

  it('links an embed back to the full site, without embed or debug', () => {
    const url = fullSiteUrl(PAGE, { ...state, embed: true }, {});
    expect(url.startsWith(PAGE + '#')).toBe(true);
    const back = decodeHash(new URL(url).hash);
    expect(back.embed).toBeUndefined();
    expect(back.debug).toBeUndefined();
    expect(back.address).toBe(state.address);
    expect(url).not.toMatch(/embed=|debug=/);
  });

  it('matches the example in the README', () => {
    const code = embedSnippet(PAGE, { address: state.address }, { mode: 'season' }, 'VanShade: sun and shade at 453 W 12th Ave, Vancouver, BC');
    expect(readme).toContain(code);
  });

  it('escapes addresses and URLs inside attributes', () => {
    expect(escapeAttr('a "b" & <c>')).toBe('a &quot;b&quot; &amp; &lt;c&gt;');
  });

  it('only turns on embed mode for embed=1', async () => {
    expect(decodeHash('#embed=1').embed).toBe(true);
    expect(decodeHash('#embed=true').embed).toBeUndefined();
  });
});
