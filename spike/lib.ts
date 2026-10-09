// Shared helpers for the Phase 0 spike: polite serial fetch with an in-memory
// cache, request accounting, and small file writers.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SPIKE_DIR = dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = join(SPIKE_DIR, 'out');
export const SAMPLES_DIR = join(SPIKE_DIR, '..', 'docs', 'samples');

export const ORIGIN = 'https://vanshade.ca';
export const UA = 'VanShade-spike/0.1 (+https://github.com/wattyven/Trilemma-Datathon-2026)';

export interface FetchResult {
  url: string;
  status: number;
  ms: number;
  headers: Record<string, string>;
  text: string;
}

const cache = new Map<string, FetchResult>();
let lastRequestAt = 0;
export const stats = { requests: 0, cacheHits: 0, bytes: 0 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serial, rate-limited, cached GET. Sends an Origin header so CORS headers are visible. */
export async function politeGet(url: string, opts: { gapMs?: number; headers?: Record<string, string> } = {}): Promise<FetchResult> {
  const key = url + JSON.stringify(opts.headers ?? {});
  const hit = cache.get(key);
  if (hit) {
    stats.cacheHits++;
    return hit;
  }
  const gap = opts.gapMs ?? 350;
  const wait = lastRequestAt + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
  const t0 = performance.now();
  const res = await fetch(url, { headers: { Origin: ORIGIN, 'User-Agent': UA, ...opts.headers } });
  const text = await res.text();
  const ms = Math.round(performance.now() - t0);
  stats.requests++;
  stats.bytes += text.length;
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  const out = { url, status: res.status, ms, headers, text };
  cache.set(key, out);
  return out;
}

export async function getJson<T = any>(url: string, opts?: Parameters<typeof politeGet>[1]): Promise<{ r: FetchResult; json: T }> {
  const r = await politeGet(url, opts);
  let json: T;
  try {
    json = JSON.parse(r.text);
  } catch {
    throw new Error(`Non-JSON (${r.status}) from ${url}: ${r.text.slice(0, 300)}`);
  }
  return { r, json };
}

export function corsSummary(h: Record<string, string>) {
  return {
    acao: h['access-control-allow-origin'] ?? null,
    acac: h['access-control-allow-credentials'] ?? null,
    rateLimit: h['x-ratelimit-limit-minute'] ?? h['ratelimit-limit'] ?? null,
  };
}

export function writeOut(name: string, data: unknown) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, name), JSON.stringify(data, null, 2));
}

export function readOut<T = any>(name: string): T {
  const p = join(OUT_DIR, name);
  if (!existsSync(p)) throw new Error(`Missing out/${name}; run the earlier spike script first.`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function writeSample(name: string, data: unknown) {
  mkdirSync(SAMPLES_DIR, { recursive: true });
  writeFileSync(join(SAMPLES_DIR, name), JSON.stringify(data, null, 2) + '\n');
}

/** Ray-casting point-in-polygon on a single ring, [x, y] order. */
export function pointInRing(pt: [number, number], ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Point in a GeoJSON Polygon or MultiPolygon (holes respected). */
export function pointInGeometry(pt: [number, number], geom: { type: string; coordinates: any }): boolean {
  const polys: number[][][][] = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  return polys.some((rings) => pointInRing(pt, rings[0]) && !rings.slice(1).some((h) => pointInRing(pt, h)));
}

export function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  return ok;
}
