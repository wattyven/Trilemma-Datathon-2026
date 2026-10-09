// The "How to read this" card: shown once after a visitor's first result, and again from the link
// by the legend. Whether it's been seen lives in localStorage; if storage is blocked (private
// windows, some embeds) it simply shows again next time.
const KEY = 'vanshade:tips-seen-v1';

function seen(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function remember() {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    // Not remembered; harmless.
  }
}

/** `after` takes focus when the card closes, so keyboard and screen-reader users aren't dropped at the top. */
export function initTips(card: HTMLElement, close: HTMLButtonElement, after: HTMLElement) {
  close.addEventListener('click', () => {
    card.hidden = true;
    remember();
    after.focus({ preventScroll: true });
  });
  return {
    /** After a result: show the card unless this visitor has dismissed it before. */
    showFirstTime() {
      if (!seen()) card.hidden = false;
    },
    show() {
      card.hidden = false;
      close.focus({ preventScroll: true });
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      card.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
    },
  };
}
