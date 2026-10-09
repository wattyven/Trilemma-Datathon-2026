import './styles.css';
import { Analysis, errorMessage, type AnalysisElements } from './analysis';
import { GEMINI_PROXY, IMAGERY, LOCATE } from './config';
import { copy } from './copy';
import { nearestAddress, resolve, suggest, type GeocodeMatch } from './data/geocoder';
import { isAbortError } from './data/http';
import { embedSnippet, fullSiteUrl } from './embed';
import { findParcels, parcelNotices, ParcelAxisError, type ParcelLookup } from './data/parcels';
import { displayJurisdiction, isInScope, isMetroParcel } from './data/scope';
import { PRESETS, isoDate, nowMinuteInVancouver, parseIsoDate, todayInVancouver } from './engine/sun';
import { IMAGERY_SOURCES } from './imagery/sources';
import { initAbout, initDialog } from './ui/about';
import { initAnalysisChat } from './ui/analysisChat';
import { defaultState, initControls, seasonRange, type ControlState } from './ui/controls';
import { LotCanvas } from './ui/lotCanvas';
import { hideLot, renderLot, type LotViewElements } from './ui/lotView';
import { initSearch } from './ui/search';
import { initSheet } from './ui/sheet';
import { initTips } from './ui/tips';
import { showSteps, type StepId, type Steps } from './ui/status';
import { Timeline, initialTimeline, minuteLabel } from './ui/timeline';
import { decodeHash, encodeHash, wantsAdvanced, type UrlState } from './urlState';

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
  opacityInput: byId<HTMLInputElement>('results-opacity'),
  opacityWrap: byId('opacity-wrap'),
  photoCredit: byId('photo-credit'),
  elevationWrap: byId('elevation-wrap'),
  elevationSelect: byId<HTMLSelectElement>('elevation-choice'),
  changesWrap: byId('changes-wrap'),
  changesToggle: byId<HTMLInputElement>('changes-toggle'),
  changesLabel: byId('changes-label'),
  spotLayer: byId('spot-layer'),
  basicSummary: byId('basic-summary'),
  basicPeriod: byId('basic-period'),
  numbersOpen: byId<HTMLButtonElement>('numbers-open'),
  numbersBody: byId('numbers-body'),
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
const analysisOpen = byId<HTMLButtonElement>('analysis-open');
const analysisChat = GEMINI_PROXY
  ? initAnalysisChat(
      GEMINI_PROXY,
      {
        open: analysisOpen,
        panel: byId('analysis-dialog'),
        close: byId('analysis-close'),
        log: byId('analysis-log'),
        status: byId('analysis-status'),
        form: byId('analysis-form'),
        input: byId('analysis-input'),
        chips: byId('analysis-chips'),
      },
      () => analysis.insight(),
    )
  : null;
analysis.onResult = () => {
  analysisOpen.hidden = !analysisChat;
};
/** A new search, another lot or the start page: close the chat and forget its conversation. */
function resetAnalysisChat() {
  analysisOpen.hidden = true;
  analysisChat?.reset();
}
analysis.onViewChange = () => writeUrl(false);
analysis.onPhotoChange = () => writeUrl(false);
analysis.onSourceChange = () => writeUrl(false);
byId('about-imagery').textContent = copy.imagery.about(IMAGERY_SOURCES.map((s) => `${s.owner} ${s.year} (${s.licence})`));
initAbout(byId<HTMLDialogElement>('about'));
initDialog(byId<HTMLDialogElement>('numbers-info'), [byId('numbers-open')]);

// Basic lists the aerial photo's credit as a bullet under the lot notices; Advanced keeps it under the view.
const photoCredit = byId('photo-credit'), photoCreditItem = byId('photo-credit-item');
new MutationObserver(() => {
  photoCreditItem.textContent = photoCredit.textContent;
  photoCreditItem.hidden = photoCredit.hidden || !photoCredit.textContent;
}).observe(photoCredit, { attributes: true, attributeFilter: ['hidden'], childList: true, characterData: true, subtree: true });
const tips = initTips(byId('tips'), byId<HTMLButtonElement>('tips-close'), byId('lot-heading'));
document.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('[data-show-tips]')) tips.show();
});
const lotInfo = byId('lot-info');
const sheet = embedOn ? null : initSheet(lotInfo, byId<HTMLButtonElement>('sheet-handle'));

// The full-width view in Basic needs the page's width without the scrollbar (100vw includes it).
const setPageWidth = () => document.documentElement.style.setProperty('--page-width', `${document.documentElement.clientWidth}px`);
new ResizeObserver(setPageWidth).observe(document.documentElement);
setPageWidth();

// ── Basic and Advanced ───────────────────────────────────────────────────────────

// Basic puts the 3D / Map toolbar and the legend inside the map, and sizes the map to fit the
// window (on screens wider than a phone); Advanced keeps them above and below it.
const stage = document.querySelector<HTMLElement>('.view-stage')!;
const toolbar = document.querySelector<HTMLElement>('.view-toolbar')!;
const legend = byId('legend');
const toolbarHome = document.createComment('toolbar'), legendHome = document.createComment('legend');
toolbar.before(toolbarHome);
legend.before(legendHome);
const wide = window.matchMedia('(min-width: 721px)');

function placeOverlays(basic: boolean) {
  if (basic) stage.append(toolbar, legend);
  else {
    toolbarHome.after(toolbar);
    legendHome.after(legend);
  }
}

/** Basic on a laptop or desktop: the whole map within the window, below the summary. */
function fitView() {
  if (advanced || !wide.matches || byId('lot').hidden) {
    stage.style.height = '';
    return;
  }
  const top = stage.getBoundingClientRect().top + window.scrollY;
  stage.style.height = `${Math.max(360, Math.round(window.innerHeight - top - 12))}px`;
}
window.addEventListener('resize', fitView);
const refit = new ResizeObserver(fitView);
for (const id of ['basic-summary', 'basic-head', 'basic-dates', 'lot-heading']) refit.observe(byId(id));
refit.observe(document.querySelector('.site-header')!);

const advancedToggle = byId<HTMLButtonElement>('advanced-toggle');
const basicFrom = byId<HTMLInputElement>('basic-from');
const basicTo = byId<HTMLInputElement>('basic-to');
let advanced = false;

/** Basic's dates show the season range the controls hold. */
function syncBasicDates() {
  const { start, end } = seasonRange(controls.get());
  basicFrom.value = isoDate(start);
  basicTo.value = isoDate(end);
}

/**
 * Basic (the default) or Advanced options. Basic always measures a date range at garden-bed height
 * on the best surface, so switching to it sets those; switching back shows them as chosen.
 */
function setAdvanced(on: boolean, recompute = true) {
  advanced = on;
  advancedToggle.setAttribute('aria-checked', String(on));
  document.documentElement.classList.toggle('basic', !on);
  placeOverlays(!on);
  queueMicrotask(fitView);
  if (on) sheet?.collapse();
  else lotInfo.dataset.sheet = 'expanded'; // no bottom sheet in Basic
  if (on) return analysis.setBasic(false);
  const before = controls.get();
  controls.set({ mode: 'season', observer: 'bed', spots: true });
  analysis.chooseSource('best');
  analysis.setChangesEnabled(false);
  syncBasicDates();
  analysis.setBasic(true);
  if (!recompute) return;
  if (before.observer !== 'bed') void analysis.onControls('observer');
  else if (before.mode !== 'season') void analysis.onControls('request');
}

advancedToggle.addEventListener('click', () => {
  setAdvanced(!advanced);
  writeUrl(false);
});

byId<HTMLFormElement>('basic-dates').addEventListener('change', () => {
  const a = parseIsoDate(basicFrom.value), b = parseIsoDate(basicTo.value);
  if (!a || !b) return;
  const [start, end] = isoDate(a) <= isoDate(b) ? [a, b] : [b, a];
  const growing = PRESETS.growing(start.year);
  const isGrowing = isoDate(growing.start) === isoDate(start) && isoDate(growing.end) === isoDate(end);
  controls.set(isGrowing ? { preset: 'growing', year: start.year } : { preset: 'custom', start: isoDate(start), end: isoDate(end) });
  syncBasicDates();
  void analysis.onControls('request');
  writeUrl(false);
});

setAdvanced(wantsAdvanced(linkState), false);

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
  resetAnalysisChat();
  lotCanvas.clear();
  intro.hidden = true;
  document.documentElement.classList.add('has-lot'); // the address bar tucks into the header
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
  resetAnalysisChat();
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
    advanced: false,
    mode: LINK_DEFAULT_MODE,
    preset: defaults.preset,
    year: defaults.year,
    observer: defaults.observer,
    view: '3d',
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
  // Basic links carry the lot, the dates and the view; everything else is Basic's fixed choice.
  if (!advanced)
    return {
      address: shown.match.fullAddress,
      lot: shown.selected > 0 ? lot?.id : undefined,
      preset: c.preset,
      year: c.year,
      start: c.preset === 'custom' ? c.start : undefined,
      end: c.preset === 'custom' ? c.end : undefined,
      view: analysis.currentView,
      opacity: analysis.resultsOpacity,
      debug: debugOn,
      embed: embedOn,
    };
  return {
    advanced: true,
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
    setAdvanced(wantsAdvanced(s), false);
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

/** Back to the start page: no lot, the intro, an empty address bar (the VanShade title, or Back to it). */
function goHome(push: boolean) {
  current?.abort();
  current = null;
  shown = null;
  lastLookup = null;
  clearMessage();
  statusList.hidden = true;
  hideLot(lotEls);
  resetAnalysisChat();
  lotCanvas.clear();
  intro.hidden = false;
  document.documentElement.classList.remove('has-lot');
  search.setValue('');
  if (push && location.hash) history.pushState(null, '', location.pathname + location.search);
  window.scrollTo(0, 0);
  input.focus();
}

byId<HTMLAnchorElement>('home-link').addEventListener('click', (e) => {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // a new tab or window: let the link work
  e.preventDefault();
  goHome(true);
});

window.addEventListener('popstate', async () => {
  if (!(await applyUrl(location.hash))) goHome(false);
});

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
