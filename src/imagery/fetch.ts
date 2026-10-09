// Fetch a lot-sized aerial photo into a canvas: one export request, or a few dozen cached tiles
// stitched together. Images load with crossOrigin = 'anonymous' (the servers echo our origin), so
// the canvas stays usable as a WebGL texture.
import { exportUrl, tileRange, tileUrl, type Bbox3857, type ImagerySource } from './sources';

export interface Photo {
  image: HTMLCanvasElement;
  /** Web Mercator box the canvas covers exactly. */
  box: Bbox3857;
  source: ImagerySource;
}

const TARGET_M_PER_PX = 0.15;
const MAX_PX = 2048;
const MAX_TILES = 64;

const cache = new Map<string, Promise<Photo | null>>();

/** A lot-sized photo, or null where the source turns out to have no imagery (a blank image). */
export function fetchPhoto(source: ImagerySource, box: Bbox3857): Promise<Photo | null> {
  const key = `${source.id}:${[box.minX, box.minY, box.maxX, box.maxY].map((v) => Math.round(v)).join(',')}`;
  let p = cache.get(key);
  if (!p) {
    p = load(source, box);
    p.catch(() => cache.delete(key));
    cache.set(key, p);
    if (cache.size > 6) cache.delete(cache.keys().next().value!);
  }
  return p;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Image failed: ${url}`));
    img.src = url;
  });
}

/** Web Mercator stretches distances by 1 / cos(latitude). */
const mercScale = (b: Bbox3857) => Math.cosh(((b.minY + b.maxY) / 2) / 6378137);

async function load(source: ImagerySource, box: Bbox3857): Promise<Photo | null> {
  const s = source.service;
  let canvas: HTMLCanvasElement, cover: Bbox3857;
  if (s.kind === 'tiles') {
    let zoom = s.zoom, r = tileRange(box, zoom);
    while ((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) > MAX_TILES && zoom > 15) r = tileRange(box, --zoom);
    const service = { ...s, zoom };
    canvas = document.createElement('canvas');
    canvas.width = (r.x1 - r.x0 + 1) * 256;
    canvas.height = (r.y1 - r.y0 + 1) * 256;
    const ctx = canvas.getContext('2d')!;
    const jobs: [number, number][] = [];
    for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) jobs.push([x, y]);
    let failed = 0;
    // Six at a time, like a browser's per-host connection limit.
    const worker = async () => {
      for (let job = jobs.shift(); job; job = jobs.shift()) {
        const [x, y] = job;
        try {
          ctx.drawImage(await loadImage(tileUrl(service, x, y)), (x - r.x0) * 256, (y - r.y0) * 256);
        } catch {
          failed++; // outside the service's coverage: leave it blank
        }
      }
    };
    const total = jobs.length;
    await Promise.all(Array.from({ length: 6 }, worker));
    if (failed === total) return null;
    cover = r.box;
  } else {
    const k = mercScale(box);
    const wM = (box.maxX - box.minX) / k, hM = (box.maxY - box.minY) / k;
    let w = Math.ceil(wM / TARGET_M_PER_PX), h = Math.ceil(hM / TARGET_M_PER_PX);
    const shrink = Math.min(1, MAX_PX / Math.max(w, h));
    w = Math.max(1, Math.round(w * shrink));
    h = Math.max(1, Math.round(h * shrink));
    const img = await loadImage(exportUrl(s, box, w, h));
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
    cover = box;
  }
  return isBlank(canvas) ? null : { image: canvas, box: cover, source };
}

/** Mostly one flat colour (white, black or transparent): the service has nothing here. */
export function isBlank(canvas: HTMLCanvasElement): boolean {
  const n = 48;
  const small = document.createElement('canvas');
  small.width = small.height = n;
  const ctx = small.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0, n, n);
  const d = ctx.getImageData(0, 0, n, n).data;
  let flat = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]!, g = d[i + 1]!, b = d[i + 2]!, a = d[i + 3]!;
    if (a < 10 || (r > 245 && g > 245 && b > 245) || (r < 8 && g < 8 && b < 8)) flat++;
  }
  return flat / (n * n) > 0.9;
}
