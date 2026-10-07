// Worker-side COG access with geotiff.js (path A in docs/DATA_SOURCES.md). Tile offsets load
// lazily, so opening a 133 GB mosaic costs ~5 KiB; a lot window costs a few 1 MiB tiles.
import { fromUrl, type GeoTIFFImage } from 'geotiff';
import type { PixelWindow, TileGrid } from './window';

const images = new Map<string, Promise<GeoTIFFImage>>();

export function openImage(url: string): Promise<GeoTIFFImage> {
  let p = images.get(url);
  if (!p) {
    p = fromUrl(url).then((tiff) => tiff.getImage());
    p.catch(() => images.delete(url));
    images.set(url, p);
  }
  return p;
}

export function tileGrid(image: GeoTIFFImage): TileGrid {
  const [originX, originY] = image.getOrigin();
  const [resX] = image.getResolution();
  return { originX: originX!, originY: originY!, res: Math.abs(resX!), width: image.getWidth(), height: image.getHeight() };
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
