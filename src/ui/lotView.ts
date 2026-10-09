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
  /** Facts most people don't need, in a closed "Lot and data details" disclosure. */
  factsMore: HTMLDListElement;
  notices: HTMLUListElement;
  switcher: HTMLDetailsElement;
  switcherSummary: HTMLElement;
  options: HTMLElement;
}

export function renderLot(els: LotViewElements, model: LotViewModel) {
  const parcel = model.candidates[model.selected];
  if (!parcel) return;
  els.section.hidden = false;
  els.heading.textContent = model.address;
  els.facts.replaceChildren();
  els.factsMore.replaceChildren();
  setFact(els, 'jurisdiction', copy.facts.jurisdiction, model.jurisdiction);
  setFact(els, 'area', copy.facts.area, copy.areaM2(parcel.areaM2));
  setFact(els, 'type', copy.facts.type, plainParcelClass(parcel.parcelClass), true);
  if (parcel.planNumber) setFact(els, 'plan', copy.facts.plan, parcel.planNumber, true);

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

/** Adds or replaces one fact row, keyed so later phases can update it in place. `more`: in the details disclosure. */
export function setFact(els: LotViewElements, key: string, label: string, value: string, more = false) {
  const list = more ? els.factsMore : els.facts;
  let dd = list.querySelector<HTMLElement>(`dd[data-key="${key}"]`);
  if (!dd) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    dd = document.createElement('dd');
    dd.dataset.key = key;
    list.append(dt, dd);
  }
  dd.textContent = value;
}

export function plainParcelClass(cls: string): string {
  return copy.parcelClass[cls] ?? cls;
}

/** "Best match: strata building, 369 m²" / "Lot 2: 389 m², 6 m away". */
export function lotOptionLabel(p: { parcelClass: string; areaM2: number; containsPoint: boolean; distanceM: number }, i: number): string {
  const kind = plainParcelClass(p.parcelClass);
  const parts = [kind !== 'Lot' ? kind.toLowerCase() : '', copy.areaM2(p.areaM2), p.containsPoint ? '' : copy.metresAway(p.distanceM)].filter(Boolean);
  return `${i === 0 ? copy.switcherBest : `${copy.switcherOther} ${i + 1}`}: ${parts.join(', ')}`;
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
  els.switcherSummary.textContent = copy.switcherSummary(model.candidates.length - 1);
  // Open when the match was a guess (or another lot is chosen); otherwise most people never need it.
  els.switcher.open = model.notices.includes('nearest-lot') || model.selected > 0;
  els.options.replaceChildren(
    ...model.candidates.map((p, i) => {
      const label = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'lot-choice';
      radio.value = String(i);
      radio.checked = i === model.selected;
      radio.addEventListener('change', () => model.onSelect(i));
      label.append(radio, ` ${lotOptionLabel(p, i)}`);
      return label;
    }),
  );
}
