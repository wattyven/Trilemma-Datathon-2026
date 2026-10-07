import './styles.css';
import { Analysis, errorMessage, type AnalysisElements } from './analysis';
import { copy } from './copy';
import { resolve, suggest, type GeocodeMatch } from './data/geocoder';
import { isAbortError } from './data/http';
import { findParcels, parcelNotices, ParcelAxisError, type ParcelLookup } from './data/parcels';
import { displayJurisdiction, isInScope, isMetroParcel } from './data/scope';
import { nowMinuteInVancouver, todayInVancouver } from './engine/sun';
import { defaultState, initControls } from './ui/controls';
import { LotCanvas } from './ui/lotCanvas';
import { hideLot, renderLot, type LotViewElements } from './ui/lotView';
import { initSearch } from './ui/search';
import { showSteps, type StepId, type Steps } from './ui/status';

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
  heading: byId('lot-heading'),
  facts: byId<HTMLDListElement>('lot-facts'),
  notices: byId<HTMLUListElement>('lot-notices'),
  switcher: byId<HTMLFieldSetElement>('lot-switcher'),
  options: byId('lot-options'),
};
const analysisEls: AnalysisElements = {
  legend: byId('legend'),
  readout: byId('readout'),
  summary: byId('result-summary'),
  inspector: byId('inspector'),
  debug: byId<HTMLDListElement>('debug-facts'),
};

const lotCanvas = new LotCanvas(byId<HTMLCanvasElement>('lot-canvas'), {
  onHover: (cell) => analysis.hover(cell),
  onPick: (cell) => void analysis.pick(cell),
});
const controls = initControls(byId<HTMLFormElement>('sun-controls'), defaultState(todayInVancouver(), nowMinuteInVancouver()), (_s, kind) =>
  void analysis.onControls(kind),
);
const analysis = new Analysis(lotCanvas, controls, lotEls, analysisEls);

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

function newRun(): AbortSignal {
  current?.abort();
  current = new AbortController();
  return current.signal;
}

async function lookup(req: LookupInput) {
  const signal = newRun();
  clearMessage();
  hideLot(lotEls);
  lotCanvas.clear();

  if (req.kind === 'text' && !req.text) {
    showMessage(copy.emptyQuery);
    return;
  }

  const steps = showSteps(statusList, ['address', 'lot', 'elevation', 'sunlight']);
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
    await showLot(match, found, 0, steps, signal);
  } catch (e) {
    if (isAbortError(e)) return;
    console.error(e);
    steps.set(stage, 'error');
    showMessage(e instanceof ParcelAxisError ? copy.lotGlitch : stage === 'address' ? copy.geocoderDown : copy.parcelDown);
  }
}

/** Draw the chosen lot, then run elevation and sun for it. */
async function showLot(match: GeocodeMatch, found: ParcelLookup, selected: number, steps: Steps, signal: AbortSignal) {
  const parcel = found.candidates[selected];
  if (!parcel) return;
  renderLot(lotEls, {
    address: match.fullAddress,
    jurisdiction: displayJurisdiction(parcel, match),
    candidates: found.candidates,
    selected,
    notices: parcelNotices(parcel, found, { approximateGeocode: match.approximate }),
    onSelect: (i) => {
      const s = newRun();
      clearMessage();
      void showLot(match, found, i, showSteps(statusList, ['elevation', 'sunlight']), s);
    },
  });
  lotCanvas.setOutline({ candidates: found.candidates.map((c) => c.geometry), selected, point: match.lonLat });
  try {
    await analysis.start(parcel, match, steps, signal);
    steps.hide();
  } catch (e) {
    if (isAbortError(e)) return;
    console.error(e);
    steps.failActive();
    showMessage(errorMessage(e));
  }
}
