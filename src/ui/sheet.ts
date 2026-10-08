// On narrow screens the info column becomes a bottom sheet: collapsed it shows the
// address and summary; the handle expands it to the controls and details.
import { copy } from '../copy';

export function initSheet(panel: HTMLElement, handle: HTMLButtonElement) {
  const label = handle.querySelector<HTMLElement>('.sheet-label');
  const set = (open: boolean) => {
    panel.dataset.sheet = open ? 'expanded' : 'collapsed';
    handle.setAttribute('aria-expanded', String(open));
    if (label) label.textContent = open ? copy.sheet.hide : copy.sheet.show;
  };
  handle.addEventListener('click', () => set(panel.dataset.sheet !== 'expanded'));
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.dataset.sheet === 'expanded') {
      set(false);
      handle.focus();
    }
  });
  set(false);
  return { collapse: () => set(false) };
}
