// Zoom and pan for the 2D map, on top of the view that fits the lot to the canvas. Pure: local
// metres (x east, y true north) and CSS pixels, no DOM.
import type { Position } from '../geo/polygon';

/** From the fitted view (1) to 8× closer: past that it's single laser-scan cells and a soft photo. */
export const MAP_ZOOM = { min: 1, max: 8, step: 1.5 } as const;

/** The view that fits the lot: its centre in local metres and its scale in pixels per metre. */
export interface FitView {
  cx: number;
  cy: number;
  s: number;
}

export interface ZoomState {
  zoom: number;
  /** The view's centre, in metres from the fitted centre. */
  pan: Position;
}

export const FITTED: ZoomState = { zoom: 1, pan: [0, 0] };

/** Keep the view inside the fitted one: at 1× no pan; closer in, as far as its edges. */
export function clampPan(pan: Position, zoom: number, fit: FitView, w: number, h: number): Position {
  const keep = 1 - 1 / zoom;
  const clamp = (v: number, m: number) => (m > 0 ? Math.max(-m, Math.min(m, v)) : 0);
  return [clamp(pan[0], (w / (2 * fit.s)) * keep), clamp(pan[1], (h / (2 * fit.s)) * keep)];
}

/** Zoom by `factor`, keeping the ground under the pixel (X, Y) where it is. */
export function zoomAbout(state: ZoomState, factor: number, X: number, Y: number, fit: FitView, w: number, h: number): ZoomState {
  const zoom = Math.max(MAP_ZOOM.min, Math.min(MAP_ZOOM.max, state.zoom * factor));
  const s = fit.s * state.zoom, s2 = fit.s * zoom;
  const cx = fit.cx + state.pan[0], cy = fit.cy + state.pan[1];
  const x = cx + (X - w / 2) / s, y = cy - (Y - h / 2) / s; // the ground under the pointer
  const pan: Position = [x - (X - w / 2) / s2 - fit.cx, y + (Y - h / 2) / s2 - fit.cy];
  return { zoom, pan: clampPan(pan, zoom, fit, w, h) };
}

/** Drag the map by (dX, dY) pixels: the ground follows the pointer. */
export function panBy(state: ZoomState, dX: number, dY: number, fit: FitView, w: number, h: number): ZoomState {
  const s = fit.s * state.zoom;
  return { zoom: state.zoom, pan: clampPan([state.pan[0] - dX / s, state.pan[1] + dY / s], state.zoom, fit, w, h) };
}
