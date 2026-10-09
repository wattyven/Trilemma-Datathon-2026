// Worker-side COG access with geotiff.js (the recommended elevation path in docs/DATA_SOURCES.md). Tile offsets load
// lazily, so opening a 133 GB mosaic costs ~5 KiB; a lot window costs a few 1 MiB tiles.
import { BaseClient, BaseResponse, fromCustomClient, type GeoTIFFImage } from 'geotiff';
import { fetchRange } from './rangeFetch';
import type { PixelWindow, TileGrid } from './window';

const images = new Map<string, Promise<GeoTIFFImage>>();

class CheckedResponse extends BaseResponse {
  constructor(
    private response: Response,
    private data: ArrayBuffer,
  ) {
    super();
  }
  override get status() {
    return this.response.status;
  }
  override getHeader(name: string) {
    return this.response.headers.get(name) ?? undefined;
  }
  override async getData() {
    return this.data;
  }
}

/** geotiff's fetch client, with range reads checked for a browser cache bug (see rangeFetch.ts). */
class CheckedFetchClient extends BaseClient {
  override async request({ headers, signal }: { headers?: Record<string, string>; signal?: AbortSignal } = {}) {
    const range = /^bytes=(\d+)-(\d+)$/.exec(headers?.Range ?? '');
    if (!range) {
      const response = await fetch(this.url, { headers, signal });
      return new CheckedResponse(response, await response.arrayBuffer());
    }
    const { response, data } = await fetchRange(this.url, Number(range[1]), Number(range[2]), { headers, signal });
    return new CheckedResponse(response, data);
  }
}

/**
 * `blockSize` turns on geotiff's block cache: needed for strip TIFFs whose strip offsets would
 * otherwise be read four bytes per request (LidarBC: 1,358 requests for one window, 10 with it).
 */
export function openImage(url: string, opts: { blockSize?: number } = {}): Promise<GeoTIFFImage> {
  let p = images.get(url);
  if (!p) {
    // geotiff's types omit the block-cache options that fromUrl passes through to its source.
    const options = (opts.blockSize ? { blockSize: opts.blockSize, cacheSize: 128 } : {}) as Parameters<typeof fromCustomClient>[1];
    p = fromCustomClient(new CheckedFetchClient(url), options).then((tiff) => tiff.getImage());
    p.catch(() => images.delete(url));
    images.set(url, p);
  }
  return p;
}

export function tileGrid(image: GeoTIFFImage): TileGrid {
  const [originX, originY] = image.getOrigin();
  const [resX] = image.getResolution();
  // HRDEM mosaics are EPSG:3979; other GeoTIFF sources pass their own CRS through tileGridAs().
  return { crs: 'EPSG:3979', originX: originX!, originY: originY!, res: Math.abs(resX!), width: image.getWidth(), height: image.getHeight() };
}

/** Reads a window as Float32, with the GDAL nodata value (−32767 for HRDEM) turned into NaN. */
export async function readWindow(image: GeoTIFFImage, w: PixelWindow, signal?: AbortSignal): Promise<Float32Array> {
  const raw = (await image.readRasters({
    window: [w.col0, w.row0, w.col0 + w.width, w.row0 + w.height],
    samples: [0],
    interleave: true,
    signal,
  })) as unknown as ArrayLike<number>;
  const nodata = image.getGDALNoData();
  const out = raw instanceof Float32Array ? raw : Float32Array.from(raw);
  for (let i = 0; i < out.length; i++) {
    const v = out[i]!;
    if (v === nodata || v < -1000) out[i] = NaN;
  }
  return out;
}
