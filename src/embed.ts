// Embedding VanShade in another site: the iframe snippet "Copy embed code" gives, and the link
// back to the full site from inside an embed. Pure, so the HTML is easy to test.
import { encodeHash, type UrlState } from './urlState';

/** Escape text for a double-quoted HTML attribute. */
export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The full site for a state: what "Open in VanShade" opens (no embed or debug flags). */
export function fullSiteUrl(pageUrl: string, s: UrlState, defaults: UrlState): string {
  return pageUrl + encodeHash({ ...s, embed: undefined, debug: undefined }, defaults);
}

/** An iframe showing this lot, mode, date and time in the compact layout. */
export function embedSnippet(pageUrl: string, s: UrlState, defaults: UrlState, title: string): string {
  const src = pageUrl + encodeHash({ ...s, embed: true, debug: undefined }, defaults);
  return `<iframe src="${escapeAttr(src)}" width="100%" height="600" style="border:0" loading="lazy" title="${escapeAttr(title)}"></iframe>`;
}
