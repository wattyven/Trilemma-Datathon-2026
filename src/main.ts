import './styles.css';
import { copy } from './copy';
import { resolve, suggest, type GeocodeMatch } from './data/geocoder';
import { isAbortError } from './data/http';
import { findParcels, parcelNotices, ParcelAxisError, type ParcelLookup } from './data/parcels';
import { displayJurisdiction, isInScope, isMetroParcel } from './data/scope';
import { initSearch } from './ui/search';
import { showSteps, type StepId } from './ui/status';
import { hideLot, renderLot, type LotViewElements } from './ui/lotView';

const byId = <T extends HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

const form = byId<HTMLFormElement>('search-form');
const input = byId<HTMLInputElement>('address-input');
const listbox = byId<HTMLUListElement>('address-options');
const statusList = byId<HTMLOListElement>('status');
const message = byId<HTMLDivElement>('message');
const lotEls: LotViewElements = {
  section: byId('lot'),
  canvas: byId<HTMLCanvasElement>('lot-canvas'),
  heading: byId('lot-heading'),
  facts: byId<HTMLDListElement>('lot-facts'),
  notices: byId<HTMLUListElement>('lot-notices'),
  switcher: byId<HTMLFieldSetElement>('lot-switcher'),
  options: byId('lot-options'),
};

type LookupInput = { kind: 'match'; match: GeocodeMatch } | { kind: 'text'; text: string };

let current: AbortController | null = null;

const search = initSearch(form, input, listbox, {
  fetchSuggestions: suggest,
  onPick: (match) => void lookup({ kind: 'match', match }),
  onSubmitText: (text) => void lookup({ kind: 'text', text }),
});

function showMessage(text: string, action?: { label: string; run: () => void }) {
  message.replaceChildren(document.createTextNode(text));
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = action.label;
    btn.addEventListener('click', action.run);
    message.append(' ', btn);
  }
  message.hidden = false;
}

function clearMessage() {
  message.hidden = true;
  message.replaceChildren();
}

async function lookup(req: LookupInput) {
  current?.abort();
  const run = new AbortController();
  current = run;
  const { signal } = run;
  clearMessage();
  hideLot(lotEls);

  if (req.kind === 'text' && !req.text) {
    showMessage(copy.emptyQuery);
    return;
  }

  const steps = showSteps(statusList, ['address', 'lot']);
  let stage: StepId = 'address';
  try {
    steps.set('address', 'active');
    let match: GeocodeMatch;
    if (req.kind === 'match') {
      match = req.match;
    } else {
      const outcome = await resolve(req.text, signal);
      if (outcome.kind !== 'ok') {
        steps.hide();
        switch (outcome.kind) {
          case 'not-found':
            return showMessage(copy.notFound);
          case 'low-confidence': {
            const suggested = outcome.match.fullAddress;
            return showMessage(copy.didYouMean(suggested), {
              label: copy.didYouMeanButton,
              run: () => {
                search.setValue(suggested);
                void lookup({ kind: 'text', text: suggested });
              },
            });
          }
          case 'coarse':
            return showMessage(copy.coarse(outcome.match.fullAddress, outcome.match.matchPrecision));
          case 'out-of-area':
            return showMessage(copy.outOfArea(outcome.match.fullAddress));
        }
      }
      match = outcome.match;
    }
    if (!isInScope(match)) {
      steps.hide();
      return showMessage(copy.outOfArea(match.fullAddress));
    }
    steps.set('address', 'done');

    stage = 'lot';
    steps.set('lot', 'active');
    const found = await findParcels(match.lonLat, { signal });
    if (signal.aborted) return;
    const best = found.candidates[0];
    if (!best) {
      steps.set('lot', 'error');
      return showMessage(copy.noLot);
    }
    if (!isMetroParcel(best)) {
      steps.hide();
      return showMessage(copy.outOfArea(match.fullAddress));
    }
    steps.set('lot', 'done');
    steps.hide();
    showLot(match, found, 0);
  } catch (e) {
    if (isAbortError(e)) return;
    console.error(e);
    steps.set(stage, 'error');
    showMessage(e instanceof ParcelAxisError ? copy.lotGlitch : stage === 'address' ? copy.geocoderDown : copy.parcelDown);
  }
}

function showLot(match: GeocodeMatch, found: ParcelLookup, selected: number) {
  const parcel = found.candidates[selected];
  if (!parcel) return;
  renderLot(lotEls, {
    address: match.fullAddress,
    jurisdiction: displayJurisdiction(parcel, match),
    candidates: found.candidates,
    selected,
    point: match.lonLat,
    notices: parcelNotices(parcel, found, { approximateGeocode: match.approximate }),
    onSelect: (i) => showLot(match, found, i),
  });
}
