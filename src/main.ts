import './styles.css';
import { Analysis, errorMessage, type AnalysisElements } from './analysis';
import { IMAGERY, LOCATE } from './config';
import { copy } from './copy';
import { nearestAddress, resolve, suggest, type GeocodeMatch } from './data/geocoder';
import { isAbortError } from './data/http';
import { embedSnippet, fullSiteUrl } from './embed';
import { findParcels, parcelNotices, ParcelAxisError, type ParcelLookup } from './data/parcels';
import { displayJurisdiction, isInScope, isMetroParcel } from './data/scope';
import { nowMinuteInVancouver, todayInVancouver } from './engine/sun';
import { IMAGERY_SOURCES } from './imagery/sources';
import { initAbout } from './ui/about';
import { defaultState, initControls, type ControlState } from './ui/controls';
import { LotCanvas } from './ui/lotCanvas';
import { hideLot, renderLot, type LotViewElements } from './ui/lotView';
import { initSearch } from './ui/search';
import { initSheet } from './ui/sheet';
import { initTips } from './ui/tips';
import { showSteps, type StepId, type Steps } from './ui/status';
import { Timeline, initialTimeline, minuteLabel } from './ui/timeline';
import { decodeHash, encodeHash, type UrlState } from './urlState';

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
const intro = byId('intro');
const lotEls: LotViewElements = {
  section: byId('lot'),
  heading: byId('lot-heading'),
  facts: byId<HTMLDListElement>('lot-facts'),
  notices: byId<HTMLUListElement>('lot-notices'),
  switcher: byId<HTMLDetailsElement>('lot-switcher'),
  switcherSummary: byId('lot-switcher-summary'),
  factsMore: byId<HTMLDListElement>('lot-facts-more'),
  options: byId('lot-options'),
};
const analysisEls: AnalysisElements = {
  headline: byId('result-headline'),
  timelineNote: byId('timeline-note'),
  legend: byId('legend'),
  readout: byId('readout'),
  summary: byId('result-summary'),
  inspector: byId('inspector'),
  debug: byId<HTMLDListElement>('debug-facts'),
  sceneHost: byId('scene-host'),
  mapCanvas: byId<HTMLCanvasElement>('lot-canvas'),
  hud: byId('hud'),
  compass: byId('compass'),
  sunNote: byId('sun-note'),
  viewNote: byId('view-note'),
  viewRadios: Array.from(document.querySelectorAll<HTMLInputElement>('input[name="view"]')),
  shadowsToggle: byId<HTMLInputElement>('shadows-toggle'),
  compareToggle: byId<HTMLInputElement>('compare-toggle'),
  resetView: byId<HTMLButtonElement>('reset-view'),
  caveatLidar: byId('caveat-lidar'),
  aboutLidar: byId('about-lidar'),
  photoToggle: byId<HTMLInputElement>('photo-toggle'),
  opacityInput: byId<HTMLInputElement>('results-opacity'),
  opacityWrap: byId('opacity-wrap'),
  photoCredit: byId('photo-credit'),
  elevationWrap: byId('elevation-wrap'),
  elevationSelect: byId<HTMLSelectElement>('elevation-choice'),
  changesWrap: byId('changes-wrap'),
  changesToggle: byId<HTMLInputElement>('changes-toggle'),
  changesLabel: byId('changes-label'),
  spotLayer: byId('spot-layer'),
};

const today = todayInVancouver();
const defaults = defaultState(today, nowMinuteInVancouver());
const linkState = decodeHash(location.hash);
/** `debug=1` in the link shows the debug details (and keeps it in the link). */
const debugOn = linkState.debug === true;
byId('debug').hidden = !debugOn;
/** `embed=1`: the compact layout for an iframe on another site, with a link to the full site. */
const embedOn = linkState.embed === true;
const pageUrl = () => location.origin + location.pathname;
const embedOpen = byId<HTMLAnchorElement>('embed-open');
if (embedOn) {
  document.documentElement.classList.add('embed');
  if (linkState.address) document.documentElement.classList.add('embed-lot');
  byId('embed-bar').hidden = false;
  embedOpen.href = fullSiteUrl(pageUrl(), linkState, {});
}

const lotCanvas = new LotCanvas(byId<HTMLCanvasElement>('lot-canvas'), {
  onHover: (cell) => analysis.hover(cell),
  onPick: (cell) => void analysis.pick(cell),
});
const controls = initControls(byId<HTMLFormElement>('sun-controls'), defaults, (_s, kind) => {
  void analysis.onControls(kind);
  writeUrl(false);
});
const timeline = new Timeline(
  {
    root: byId('timeline'),
    date: byId<HTMLInputElement>('tl-date'),
    slider: byId<HTMLInputElement>('tl-time'),
    label: byId<HTMLOutputElement>('tl-time-label'),
    play: byId<HTMLButtonElement>('tl-play'),
    now: byId<HTMLButtonElement>('tl-now'),
    sun: byId('tl-sun'),
  },
  initialTimeline(today, nowMinuteInVancouver()),
  (t, dateChanged) => {
    void analysis.onTimeline(t, dateChanged);
    writeUrl(false);
  },
  () => initialTimeline(todayInVancouver(), nowMinuteInVancouver()),
);
const analysis = new Analysis(lotCanvas, controls, timeline, lotEls, analysisEls);
analysis.onViewChange = () => writeUrl(false);
analysis.onPhotoChange = () => writeUrl(false);
analysis.onSourceChange = () => writeUrl(false);
byId('about-imagery').textContent = copy.imagery.about(IMAGERY_SOURCES.map((s) => `${s.owner} ${s.year} (${s.licence})`));
initAbout(byId<HTMLDialogElement>('about'));
const tips = initTips(byId('tips'), byId<HTMLButtonElement>('tips-close'), byId('lot-heading'));
document.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('[data-show-tips]')) tips.show();
});
if (embedOn) byId('lot-info').dataset.sheet = 'expanded'; // no bottom sheet inside an embed
else initSheet(byId('lot-info'), byId<HTMLButtonElement>('sheet-handle'));

type LookupInput = { kind: 'match'; match: GeocodeMatch } | { kind: 'text'; text: string };
interface LookupOptions {
  /** Prefer this ParcelMap lot among the candidates (from a shared link or a retry). */
  preferLot?: number | undefined;
  /** Opened from a link or Back/Forward: don't push a new history entry. */
  fromUrl?: boolean;
}

let current: AbortController | null = null;
let shown: { match: GeocodeMatch; found: ParcelLookup; selected: number } | null = null;
let lastLookup: { req: LookupInput; opts: LookupOptions } | null = null;

const search = initSearch(form, input, listbox, {
  fetchSuggestions: suggest,
  onPick: (match) => void lookup({ kind: 'match', match }),
  onSubmitText: (text) => void lookup({ kind: 'text', text }),
});

// "Use my location": the nearest address to the device, then the normal search. Only offered
// where the browser can locate (a secure page with the Geolocation API).
const locate = byId<HTMLButtonElement>('locate');
if ('geolocation' in navigator && window.isSecureContext) byId('locate-row').hidden = false;
const currentPosition = () =>
  new Promise<GeolocationPosition>((ok, fail) => navigator.geolocation.getCurrentPosition(ok, fail, { enableHighAccuracy: true, timeout: LOCATE.timeoutMs, maximumAge: 60_000 }));
locate.addEventListener('click', async () => {
  clearMessage();
  locate.disabled = true;
  locate.textContent = copy.locate.finding;
  try {
    const pos = await currentPosition();
    const address = await nearestAddress([pos.coords.longitude, pos.coords.latitude]);
    if (!address) return showMessage(copy.locate.noAddress);
    search.setValue(address);
    void lookup({ kind: 'text', text: address });
  } catch (e) {
    const code = (e as GeolocationPositionError).code;
    showMessage(code === 1 ? copy.locate.denied : code === 2 || code === 3 ? copy.locate.unavailable : isOffline() ? copy.offline : copy.geocoderDown);
  } finally {
    locate.disabled = false;
    locate.textContent = copy.locate.button;
  }
});

for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-example]')) {
  btn.addEventListener('click', () => {
    const text = btn.dataset.example!;
    search.setValue(text);
    void lookup({ kind: 'text', text });
  });
}

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

/** A message with a "Try again" button that reruns the last lookup. */
function showRetry(text: string) {
  const last = lastLookup;
  showMessage(text, last ? { label: copy.tryAgain, run: () => void lookup(last.req, { ...last.opts, preferLot: shown?.found.candidates[shown.selected]?.id ?? last.opts.preferLot }) } : undefined);
}

/** A function, not an inline check, so TypeScript doesn't narrow `onLine` for the rest of a function. */
function isOffline(): boolean {
  return navigator.onLine === false;
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

async function lookup(req: LookupInput, opts: LookupOptions = {}) {
  const signal = newRun();
  lastLookup = { req, opts };
  clearMessage();
  hideLot(lotEls);
  lotCanvas.clear();
  intro.hidden = true;
  shown = null;

  if (req.kind === 'text' && !req.text) {
    showMessage(copy.emptyQuery);
    return;
  }
  if (isOffline()) {
    showRetry(copy.offline);
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
    analysis.prefetch(match.lonLat, signal);
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
    const preferred = opts.preferLot !== undefined ? found.candidates.findIndex((c) => c.id === opts.preferLot) : -1;
    const selected = Math.max(0, preferred);
    shown = { match, found, selected };
    if (!opts.fromUrl) writeUrl(true);
    await showLot(match, found, selected, steps, signal);
  } catch (e) {
    if (isAbortError(e)) return;
    console.error(e);
    steps.set(stage, 'error');
    if (e instanceof ParcelAxisError) showRetry(copy.lotGlitch);
    else showRetry(isOffline() ? copy.offline : stage === 'address' ? copy.geocoderDown : copy.parcelDown);
  }
}

/** Draw the chosen lot, then run elevation and sun for it. */
async function showLot(match: GeocodeMatch, found: ParcelLookup, selected: number, steps: Steps, signal: AbortSignal) {
  const parcel = found.candidates[selected];
  if (!parcel) return;
  shown = { match, found, selected };
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
      writeUrl(false);
    },
  });
  lotCanvas.setOutline({ candidates: found.candidates.map((c) => c.geometry), selected, point: match.lonLat });
  try {
    await analysis.start(parcel, match, steps, signal);
    steps.hide();
    if (!signal.aborted && !embedOn) tips.showFirstTime();
  } catch (e) {
    if (isAbortError(e)) return;
    console.error(e);
    steps.failActive();
    showRetry(isOffline() ? copy.offline : errorMessage(e));
  }
}

// ── Shareable URL ────────────────────────────────────────────────────────────────

/** Links from before "One moment" became the default left out `m` for Season, so links always carry the mode. */
const LINK_DEFAULT_MODE = 'season';

function urlDefaults(): UrlState {
  return {
    mode: LINK_DEFAULT_MODE,
    preset: defaults.preset,
    year: defaults.year,
    observer: defaults.observer,
    view: '3d',
    photo: true,
    opacity: IMAGERY.defaultOpacity,
    source: 'best',
    changes: false,
    debug: false,
    embed: false,
    classes: defaults.classes,
    spots: defaults.spots,
    fullSunH: defaults.fullSunH,
    partSunH: defaults.partSunH,
    shadeStart: defaults.shadeStart,
    shadeEnd: defaults.shadeEnd,
    fromTime: defaults.fromTime,
    toTime: defaults.toTime,
  };
}

function urlStateNow(): UrlState | null {
  if (!shown) return null;
  const c = controls.get();
  const t = timeline.get();
  const lot = shown.found.candidates[shown.selected];
  return {
    address: shown.match.fullAddress,
    lot: shown.selected > 0 ? lot?.id : undefined,
    mode: c.mode,
    preset: c.preset,
    year: c.year,
    start: c.preset === 'custom' ? c.start : undefined,
    end: c.preset === 'custom' ? c.end : undefined,
    date: t.date,
    time: minuteLabel(t.minute),
    observer: c.observer,
    view: analysis.currentView,
    photo: analysis.photoEnabled,
    opacity: analysis.resultsOpacity,
    classes: c.classes,
    spots: c.spots,
    fullSunH: c.fullSunH,
    partSunH: c.partSunH,
    shadeStart: c.shadeStart,
    shadeEnd: c.shadeEnd,
    fromTime: c.fromTime,
    toTime: c.toTime,
    source: analysis.sourcePreference,
    changes: analysis.changesEnabled,
    debug: debugOn,
    embed: embedOn,
  };
}

let restoring = false;
let pendingReplace: ReturnType<typeof setTimeout> | undefined;

/** Push for a new lot (Back returns to the previous one); replace, throttled, for everything else. */
function writeUrl(push: boolean) {
  if (restoring) return;
  const apply = () => {
    const s = urlStateNow();
    if (!s) return;
    if (embedOn) embedOpen.href = fullSiteUrl(pageUrl(), s, urlDefaults());
    const hash = encodeHash(s, urlDefaults());
    if (hash === location.hash) return;
    if (push) history.pushState(null, '', hash);
    else history.replaceState(null, '', hash);
  };
  clearTimeout(pendingReplace);
  if (push) apply();
  else pendingReplace = setTimeout(apply, 300); // browsers rate-limit replaceState; the slider fires often
}

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};

/** Restore a shared link (or a Back/Forward step). Returns false when the hash names no address. */
async function applyUrl(hash: string): Promise<boolean> {
  const s = decodeHash(hash);
  if (!s.address) return false;
  restoring = true;
  try {
    const patch: Partial<ControlState> = {};
    for (const k of ['mode', 'preset', 'year', 'start', 'end', 'observer', 'classes', 'spots', 'fullSunH', 'partSunH', 'shadeStart', 'shadeEnd', 'fromTime', 'toTime'] as const) {
      if (s[k] !== undefined) (patch as Record<string, unknown>)[k] = s[k];
    }
    patch.mode ??= LINK_DEFAULT_MODE;
    controls.set(patch);
    timeline.set(s.date, s.time ? minutesOf(s.time) : undefined);
    if (s.view) analysis.setView(s.view);
    analysis.chooseSource(s.source ?? 'best');
    analysis.setChangesEnabled(s.changes ?? false);
    analysis.setResultsOpacity(s.opacity ?? IMAGERY.defaultOpacity);
    analysis.setPhotoEnabled(s.photo ?? true, s.photo !== undefined);
    const sameLot = shown && shown.match.fullAddress === s.address;
    if (sameLot && shown) {
      const idx = s.lot !== undefined ? shown.found.candidates.findIndex((c) => c.id === s.lot) : 0;
      if (idx >= 0 && idx !== shown.selected) await showLot(shown.match, shown.found, idx, showSteps(statusList, ['elevation', 'sunlight']), newRun());
      else {
        await analysis.onControls('observer'); // reapply observer, mode, dates
        await analysis.onTimeline(timeline.get(), true);
      }
    } else {
      search.setValue(s.address);
      await lookup({ kind: 'text', text: s.address }, { preferLot: s.lot, fromUrl: true });
    }
  } finally {
    restoring = false;
  }
  return true;
}

window.addEventListener('popstate', () => void applyUrl(location.hash));

// ── Copy link ────────────────────────────────────────────────────────────────────

const shareStatus = byId('share-status');
byId<HTMLButtonElement>('share').addEventListener('click', async () => {
  clearTimeout(pendingReplace);
  const s = urlStateNow();
  if (s) history.replaceState(null, '', encodeHash(s, urlDefaults()));
  try {
    await navigator.clipboard.writeText(location.href);
    shareStatus.textContent = copy.share.copied;
  } catch {
    shareStatus.textContent = copy.share.manual(location.href);
  }
});

byId<HTMLButtonElement>('share-embed').addEventListener('click', async () => {
  const s = urlStateNow();
  if (!s) return;
  const code = embedSnippet(pageUrl(), s, urlDefaults(), copy.share.embedTitle(s.address ?? ''));
  try {
    await navigator.clipboard.writeText(code);
    shareStatus.textContent = copy.share.embedCopied;
  } catch {
    shareStatus.textContent = copy.share.embedManual(code);
  }
});

void applyUrl(location.hash);
