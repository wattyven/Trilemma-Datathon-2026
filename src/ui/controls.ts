// Sun controls: mode, dates and times (always Vancouver local), observer height, display.
// Dates stay as YYYY-MM-DD strings and minutes-of-day; nothing here builds a JS Date.
import type { ObserverId } from '../config';
import type { ComputeRequest } from '../engine/protocol';
import { PRESETS, isoDate, parseIsoDate, type LocalDate, type PresetId } from '../engine/sun';

export type Mode = 'season' | 'day' | 'moment' | 'shade';

export interface ControlState {
  mode: Mode;
  preset: PresetId | 'custom';
  year: number;
  start: string;
  end: string;
  date: string;
  time: string; // HH:mm
  shadeStart: string;
  shadeEnd: string;
  fromTime: string;
  toTime: string;
  observer: ObserverId;
  classes: boolean;
}

export type ChangeKind = 'observer' | 'request' | 'display';

export function defaultState(today: LocalDate, nowMinute: number): ControlState {
  const summer = PRESETS.summer(today.year);
  const growing = PRESETS.growing(today.year);
  const rounded = Math.round(nowMinute / 10) * 10;
  return {
    mode: 'season',
    preset: 'growing',
    year: today.year,
    start: isoDate(growing.start),
    end: isoDate(growing.end),
    date: isoDate(today),
    time: `${String(Math.floor(rounded / 60) % 24).padStart(2, '0')}:${String(rounded % 60).padStart(2, '0')}`,
    shadeStart: isoDate(summer.start),
    shadeEnd: isoDate(summer.end),
    fromTime: '13:00',
    toTime: '18:00',
    observer: 'bed',
    classes: false,
  };
}

const minutes = (hhmm: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 12 * 60;
};

/** The season range for the state: a preset for its year, or the custom dates. */
export function seasonRange(s: ControlState): { start: LocalDate; end: LocalDate } {
  if (s.preset !== 'custom') return PRESETS[s.preset](s.year);
  const a = parseIsoDate(s.start), b = parseIsoDate(s.end);
  if (!a || !b) return PRESETS.growing(s.year);
  return isoDate(a) <= isoDate(b) ? { start: a, end: b } : { start: b, end: a };
}

export function requestFor(s: ControlState): ComputeRequest {
  const date = parseIsoDate(s.date) ?? PRESETS.growing(s.year).start;
  switch (s.mode) {
    case 'season':
      return { kind: 'season', ...seasonRange(s) };
    case 'day':
      return { kind: 'day', date };
    case 'moment':
      return { kind: 'moment', date, minuteOfDay: minutes(s.time) };
    case 'shade': {
      const a = parseIsoDate(s.shadeStart) ?? PRESETS.summer(s.year).start;
      const b = parseIsoDate(s.shadeEnd) ?? PRESETS.summer(s.year).end;
      const [start, end] = isoDate(a) <= isoDate(b) ? [a, b] : [b, a];
      const from = minutes(s.fromTime), to = minutes(s.toTime);
      return { kind: 'shade', start, end, window: { fromMin: Math.min(from, to), toMin: Math.max(from, to) } };
    }
  }
}

export interface Controls {
  get(): ControlState;
  show(): void;
}

export function initControls(form: HTMLFormElement, initial: ControlState, onChange: (s: ControlState, kind: ChangeKind) => void): Controls {
  let state = { ...initial };
  const field = <T extends HTMLInputElement | HTMLSelectElement>(name: string) => form.elements.namedItem(name) as T | null;

  function write() {
    for (const r of form.querySelectorAll<HTMLInputElement>('input[name="mode"]')) r.checked = r.value === state.mode;
    const set = (name: keyof ControlState) => {
      const el = field<HTMLInputElement>(name);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = Boolean(state[name]);
      else el.value = String(state[name]);
    };
    (['preset', 'year', 'start', 'end', 'date', 'time', 'shadeStart', 'shadeEnd', 'fromTime', 'toTime', 'observer', 'classes'] as const).forEach(set);
    syncVisibility();
  }

  function syncVisibility() {
    for (const el of form.querySelectorAll<HTMLElement>('[data-for]')) {
      const modes = el.dataset.for!.split(' ');
      const visible = modes.includes(state.mode) || (modes.includes('custom') && state.mode === 'season' && state.preset === 'custom');
      el.hidden = !visible;
    }
  }

  function read(): ControlState {
    const v = (name: string) => field<HTMLInputElement>(name)?.value ?? '';
    const mode = (form.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value ?? 'season') as Mode;
    return {
      mode,
      preset: v('preset') as ControlState['preset'],
      year: Number(v('year')) || state.year,
      start: v('start'),
      end: v('end'),
      date: v('date'),
      time: v('time'),
      shadeStart: v('shadeStart'),
      shadeEnd: v('shadeEnd'),
      fromTime: v('fromTime'),
      toTime: v('toTime'),
      observer: v('observer') as ObserverId,
      classes: field<HTMLInputElement>('classes')?.checked ?? false,
    };
  }

  form.addEventListener('submit', (ev) => ev.preventDefault());
  form.addEventListener('change', (ev) => {
    const prev = state;
    state = read();
    syncVisibility();
    const name = (ev.target as HTMLInputElement).name;
    const kind: ChangeKind = name === 'observer' ? 'observer' : name === 'classes' ? 'display' : 'request';
    if (JSON.stringify(prev) !== JSON.stringify(state)) onChange(state, kind);
  });

  write();
  return {
    get: () => state,
    show: () => {
      form.hidden = false;
    },
  };
}
