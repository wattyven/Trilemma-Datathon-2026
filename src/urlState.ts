// Shareable URLs: the address (and chosen lot), mode, dates and time live in the hash.
// Decoding validates every value; anything unexpected is dropped rather than trusted.
import type { ObserverId } from './config';
import { parseIsoDate, isoDate, type PresetId } from './engine/sun';
import type { Mode } from './ui/controls';

export type View = '3d' | 'map';

export interface UrlState {
  address?: string;
  lot?: number;
  mode?: Mode;
  preset?: PresetId | 'custom';
  year?: number;
  start?: string;
  end?: string;
  date?: string;
  time?: string;
  observer?: ObserverId;
  view?: View;
  classes?: boolean;
  /** Pins on the sunniest and shadiest spots. */
  spots?: boolean;
  fullSunH?: number;
  partSunH?: number;
  shadeStart?: string;
  shadeEnd?: string;
  fromTime?: string;
  toTime?: string;
  /** Aerial photo on, and the results' opacity over it (0.2–1). */
  photo?: boolean;
  opacity?: number;
  /** Which elevation surface to use (default "best of both"). */
  source?: Source;
  /** Show where the newer survey replaced the older one. */
  changes?: boolean;
  /** Show the debug details (`debug=1`). */
  debug?: boolean;
  /** The compact layout for an iframe on another site (`embed=1`). */
  embed?: boolean;
}

/** The "Elevation data" setting; `hrdem` is a debug value. */
export type Source = 'best' | 'newest' | 'detailed' | 'hrdem';

const KEYS: Record<keyof UrlState, string> = {
  address: 'a',
  lot: 'lot',
  mode: 'm',
  preset: 'p',
  year: 'y',
  start: 'cs',
  end: 'ce',
  date: 'd',
  time: 't',
  observer: 'o',
  view: 'v',
  classes: 'cls',
  spots: 'spots',
  fullSunH: 'full',
  partSunH: 'part',
  shadeStart: 'ss',
  shadeEnd: 'se',
  fromTime: 'wf',
  toTime: 'wt',
  photo: 'img',
  opacity: 'op',
  source: 'elev',
  changes: 'chg',
  debug: 'debug',
  embed: 'embed',
};

const MODES = new Set<Mode>(['season', 'day', 'moment', 'shade']);
const PRESETS = new Set(['growing', 'summer', 'winter', 'year', 'custom']);
const OBSERVERS = new Set<ObserverId>(['bed', 'seated', 'surface']);
const VIEWS = new Set<View>(['3d', 'map']);
const SOURCES = new Set<Source>(['best', 'newest', 'detailed', 'hrdem']);
/** Links from before the setting existed used the debug names. */
const LEGACY_SOURCES: Record<string, Source> = { copc: 'detailed', lidarbc: 'newest' };

/** A real calendar date, normalised to YYYY-MM-DD. */
function validDate(s: string | null): string | undefined {
  const d = s ? parseIsoDate(s) : null;
  if (!d || d.year < 1900 || d.year > 2200 || d.month < 1 || d.month > 12) return undefined;
  const days = new Date(Date.UTC(d.year, d.month, 0)).getUTCDate(); // pure calendar maths, no zone
  return d.day >= 1 && d.day <= days ? isoDate(d) : undefined;
}

function validTime(s: string | null): string | undefined {
  const m = s ? /^(\d{1,2}):(\d{2})$/.exec(s) : null;
  if (!m) return undefined;
  const h = Number(m[1]), min = Number(m[2]);
  return h < 24 && min < 60 ? `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` : undefined;
}

function validHours(s: string | null): number | undefined {
  const v = s === null || s === '' ? NaN : Number(s);
  return Number.isFinite(v) && v >= 0 && v <= 16 ? v : undefined;
}

export function decodeHash(hash: string): UrlState {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const get = (k: keyof UrlState) => p.get(KEYS[k]);
  const out: UrlState = {};
  const address = get('address')?.trim();
  if (address && address.length <= 200) out.address = address;
  const lot = Number(get('lot'));
  if (Number.isInteger(lot) && lot > 0) out.lot = lot;
  const mode = get('mode') as Mode | null;
  if (mode && MODES.has(mode)) out.mode = mode;
  const preset = get('preset');
  if (preset && PRESETS.has(preset)) out.preset = preset as UrlState['preset'];
  const year = Number(get('year'));
  if (Number.isInteger(year) && year >= 2000 && year <= 2100) out.year = year;
  const observer = get('observer') as ObserverId | null;
  if (observer && OBSERVERS.has(observer)) out.observer = observer;
  const view = get('view') as View | null;
  if (view && VIEWS.has(view)) out.view = view;
  const rawSource = get('source');
  const source = rawSource ? (LEGACY_SOURCES[rawSource] ?? rawSource) : null;
  if (source && SOURCES.has(source as Source)) out.source = source as Source;
  const chg = get('changes');
  if (chg === '1' || chg === '0') out.changes = chg === '1';
  if (get('debug') === '1') out.debug = true;
  if (get('embed') === '1') out.embed = true;
  const img = get('photo');
  if (img === '1' || img === '0') out.photo = img === '1';
  const op = get('opacity');
  const opacity = op === null || op === '' ? NaN : Number(op);
  if (Number.isFinite(opacity) && opacity >= 0.2 && opacity <= 1) out.opacity = Math.round(opacity * 100) / 100;
  const cls = get('classes');
  if (cls === '1' || cls === '0') out.classes = cls === '1';
  const spots = get('spots');
  if (spots === '1' || spots === '0') out.spots = spots === '1';
  for (const k of ['start', 'end', 'date', 'shadeStart', 'shadeEnd'] as const) {
    const v = validDate(get(k));
    if (v) out[k] = v;
  }
  for (const k of ['time', 'fromTime', 'toTime'] as const) {
    const v = validTime(get(k));
    if (v) out[k] = v;
  }
  for (const k of ['fullSunH', 'partSunH'] as const) {
    const v = validHours(get(k));
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Hash for a state, leaving out anything equal to `defaults` (and empty values). */
export function encodeHash(s: UrlState, defaults: UrlState = {}): string {
  const p = new URLSearchParams();
  for (const k of Object.keys(KEYS) as (keyof UrlState)[]) {
    const v = s[k];
    if (v === undefined || v === '' || v === defaults[k]) continue;
    p.set(KEYS[k], typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  }
  const q = p.toString();
  return q ? `#${q}` : '';
}
