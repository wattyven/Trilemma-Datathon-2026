// The shared "now": a date and a time-of-day slider (sunrise → sunset, Vancouver wall clock) with
// play/pause. Drives the 3D sun in every mode and the overlay in Moment mode.
import { DateTime } from 'luxon';
import { SUN } from '../config';
import { copy } from '../copy';
import { isoDate, parseIsoDate, sunTimes, type LocalDate } from '../engine/sun';

export const SLIDER_STEP_MIN = 5;

export interface TimelineState {
  date: string; // YYYY-MM-DD
  minute: number; // wall-clock minutes after local midnight
}

const wallMinute = (d: Date) => {
  const dt = DateTime.fromJSDate(d).setZone(SUN.zone);
  return dt.hour * 60 + dt.minute;
};

/** Slider range for a day: sunrise to sunset, snapped outward to the slider step. */
export function dayMinuteRange(date: LocalDate, lat: number, lon: number): { min: number; max: number } {
  const t = sunTimes(date, lat, lon);
  if (!t.sunrise || !t.sunset) return { min: 0, max: 24 * 60 - SLIDER_STEP_MIN };
  return {
    min: Math.floor(wallMinute(t.sunrise) / SLIDER_STEP_MIN) * SLIDER_STEP_MIN,
    max: Math.ceil(wallMinute(t.sunset) / SLIDER_STEP_MIN) * SLIDER_STEP_MIN,
  };
}

/** Halfway between sunrise and sunset, on the slider step. */
export function middayMinute(r: { min: number; max: number }): number {
  return Math.round((r.min + r.max) / 2 / SLIDER_STEP_MIN) * SLIDER_STEP_MIN;
}

export function clampMinute(m: number, r: { min: number; max: number }): number {
  return Math.min(r.max, Math.max(r.min, Math.round(m / SLIDER_STEP_MIN) * SLIDER_STEP_MIN));
}

export function minuteLabel(m: number): string {
  const h = Math.floor(m / 60) % 24, mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export interface TimelineElements {
  root: HTMLElement;
  date: HTMLInputElement;
  slider: HTMLInputElement;
  label: HTMLOutputElement;
  play: HTMLButtonElement;
}

export class Timeline {
  private state: TimelineState;
  private location: [number, number] | null = null; // lon, lat
  private timer: ReturnType<typeof setInterval> | null = null;
  private reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  /** True once the time came from the user or a shared link (then we never move it for them). */
  private explicitTime = false;
  /** True while the time shown is midday because it was dark when the lot opened. */
  private movedFromNight = false;

  constructor(private els: TimelineElements, initial: TimelineState, private onChange: (s: TimelineState, dateChanged: boolean) => void) {
    this.state = { ...initial };
    els.date.addEventListener('change', () => {
      if (!parseIsoDate(els.date.value)) return;
      this.state.date = els.date.value;
      this.movedFromNight = false;
      this.syncRange();
      this.emit(true);
    });
    els.slider.addEventListener('input', () => {
      this.explicitTime = true;
      this.movedFromNight = false;
      this.state.minute = Number(els.slider.value);
      this.writeLabel();
      this.emit(false);
    });
    els.play.addEventListener('click', () => (this.timer ? this.pause() : this.play()));
    this.write();
  }

  get(): TimelineState {
    return { ...this.state };
  }

  /** Whether the time shown is midday only because it was dark when the lot opened. */
  get showingMiddayForNight(): boolean {
    return this.movedFromNight;
  }

  /** Restore a saved date and/or time (from a shared link) without emitting a change. */
  set(date?: string, minute?: number) {
    if (date && parseIsoDate(date)) this.state.date = date;
    if (minute !== undefined && Number.isFinite(minute)) {
      this.state.minute = minute;
      this.explicitTime = true;
      this.movedFromNight = false;
    }
    this.syncRange();
  }

  localDate(): LocalDate {
    return parseIsoDate(this.state.date)!;
  }

  /** Call when a lot loads: the slider range depends on where the sun rises and sets. */
  setLocation(lonLat: [number, number]) {
    this.location = lonLat;
    // Opening the app at night would show a dark lot: start at midday unless a time was chosen.
    const r = this.range();
    if (!this.explicitTime && (this.state.minute < r.min || this.state.minute > r.max)) {
      this.state.minute = middayMinute(r);
      this.movedFromNight = true;
    }
    this.syncRange();
    this.els.root.hidden = false;
    this.emit(true);
  }

  play() {
    this.movedFromNight = false;
    const range = this.range();
    if (this.state.minute >= range.max) this.state.minute = range.min;
    const stepMin = this.reduceMotion ? 30 : 10;
    const everyMs = this.reduceMotion ? 1000 : 150;
    this.timer = setInterval(() => {
      const r = this.range();
      const next = this.state.minute + stepMin;
      if (next > r.max) {
        this.pause();
        return;
      }
      this.state.minute = next;
      this.write();
      this.emit(false);
    }, everyMs);
    this.els.play.setAttribute('aria-pressed', 'true');
    this.els.play.textContent = copy.timeline.pause;
  }

  pause() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.els.play.setAttribute('aria-pressed', 'false');
    this.els.play.textContent = copy.timeline.play;
  }

  private range() {
    if (!this.location) return { min: 0, max: 24 * 60 - SLIDER_STEP_MIN };
    return dayMinuteRange(this.localDate(), this.location[1], this.location[0]);
  }

  private syncRange() {
    const r = this.range();
    this.els.slider.min = String(r.min);
    this.els.slider.max = String(r.max);
    this.state.minute = clampMinute(this.state.minute, r);
    this.write();
  }

  private write() {
    this.els.date.value = this.state.date;
    this.els.slider.step = String(SLIDER_STEP_MIN);
    this.els.slider.value = String(this.state.minute);
    this.writeLabel();
  }

  private writeLabel() {
    const label = minuteLabel(this.state.minute);
    this.els.label.value = label;
    this.els.slider.setAttribute('aria-valuetext', copy.timeline.valueText(label));
  }

  private emit(dateChanged: boolean) {
    this.onChange(this.get(), dateChanged);
  }
}

export function initialTimeline(today: LocalDate, nowMinute: number): TimelineState {
  return { date: isoDate(today), minute: clampMinute(nowMinute, { min: 0, max: 24 * 60 - SLIDER_STEP_MIN }) };
}
