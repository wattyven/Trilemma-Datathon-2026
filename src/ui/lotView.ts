// The lot's information panel: address, facts, notices and the lot switcher.
// The drawing itself lives in ui/lotCanvas.ts.
import { copy } from '../copy';
import type { Parcel, ParcelNotice } from '../data/parcels';

export interface LotViewModel {
  address: string;
  jurisdiction: string;
  candidates: Parcel[];
  selected: number;
  notices: ParcelNotice[];
  onSelect(index: number): void;
}

export interface LotViewElements {
  section: HTMLElement;
  heading: HTMLElement;
  facts: HTMLDListElement;
  notices: HTMLUListElement;
  switcher: HTMLFieldSetElement;
  options: HTMLElement;
}

export function renderLot(els: LotViewElements, model: LotViewModel) {
  const parcel = model.candidates[model.selected];
  if (!parcel) return;
  els.section.hidden = false;
  els.heading.textContent = model.address;
  els.facts.replaceChildren();
  setFact(els, 'jurisdiction', copy.facts.jurisdiction, model.jurisdiction);
  setFact(els, 'area', copy.facts.area, copy.areaM2(parcel.areaM2));
  setFact(els, 'type', copy.facts.type, parcel.parcelClass);
  if (parcel.planNumber) setFact(els, 'plan', copy.facts.plan, parcel.planNumber);

  els.notices.replaceChildren(
    ...model.notices.map((n) => {
      const li = document.createElement('li');
      li.textContent = copy.notices[n];
      li.dataset.notice = n;
      return li;
    }),
  );
  renderSwitcher(els, model);
}

/** Adds or replaces one fact row, keyed so later phases can update it in place. */
export function setFact(els: LotViewElements, key: string, label: string, value: string) {
  let dd = els.facts.querySelector<HTMLElement>(`dd[data-key="${key}"]`);
  if (!dd) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    dd = document.createElement('dd');
    dd.dataset.key = key;
    els.facts.append(dt, dd);
  }
  dd.textContent = value;
}

/** Text with `**emphasis**` markers, rendered as <strong> (never as HTML). */
export function setRichText(el: HTMLElement, text: string) {
  el.replaceChildren(...text.split('**').map((part, i) => (i % 2 ? Object.assign(document.createElement('strong'), { textContent: part }) : document.createTextNode(part))));
}

/** Notices that come from the elevation analysis rather than the parcel. */
export function setAnalysisNotices(els: LotViewElements, texts: string[]) {
  els.notices.querySelectorAll('li[data-notice="analysis"]').forEach((li) => li.remove());
  const caveat = els.notices.querySelector('li[data-notice="approximate-lines"]');
  for (const t of texts) {
    const li = document.createElement('li');
    li.textContent = t;
    li.dataset.notice = 'analysis';
    els.notices.insertBefore(li, caveat);
  }
}

export function hideLot(els: LotViewElements) {
  els.section.hidden = true;
}

function renderSwitcher(els: LotViewElements, model: LotViewModel) {
  if (model.candidates.length < 2) {
    els.switcher.hidden = true;
    els.options.replaceChildren();
    return;
  }
  els.switcher.hidden = false;
  els.options.replaceChildren(
    ...model.candidates.map((p, i) => {
      const label = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'lot-choice';
      radio.value = String(i);
      radio.checked = i === model.selected;
      radio.addEventListener('change', () => model.onSelect(i));
      const parts = [i === 0 ? copy.switcherBest : `${copy.switcherOther} ${i + 1}`, p.parcelClass, copy.areaM2(p.areaM2)];
      if (!p.containsPoint) parts.push(copy.metresAway(p.distanceM));
      label.append(radio, ` ${parts.join(' · ')}`);
      return label;
    }),
  );
}
