// NRCan CanElevation point clouds (COPC) read in the browser: walk the octree, fetch only the nodes
// overlapping the area near the lot, decode with laz-perf (WASM) and grid the highest return per
// cell. S3 serves these with CORS * and HTTP Range, so no server is involved.
import { Copc, type Getter } from 'copc';
import { createLazPerf, type LazPerf } from 'laz-perf/lib/worker/index.js';
import lazPerfWasmUrl from 'laz-perf/lib/worker/laz-perf.wasm?url';
import { GROUND_CLASS, NOISE_CLASSES, Reservoir, addPoint, createPointGrid, type PointGrid } from './pointRaster';
import { toPixel, type PixelWindow, type Bbox } from './window';
import type { Region } from './resample';

let lazPerf: Promise<LazPerf> | null = null;
const getLazPerf = () => (lazPerf ??= createLazPerf({ locateFile: () => lazPerfWasmUrl }));
/** Tests and Node scripts supply their own decoder (the bundled one is a web-worker build). */
export function useLazPerf(lp: LazPerf) {
  lazPerf = Promise.resolve(lp);
}

export interface CopcStats {
  bytes: number;
  nodes: number;
  points: number;
  failed: number;
}

/** Range getter over fetch (end exclusive, as copc.js expects), counting bytes. One retry, 30 s timeout. */
function rangeGetter(url: string, stats: CopcStats): Getter {
  const once = async (begin: number, end: number) => {
    const res = await fetch(url, { headers: { Range: `bytes=${begin}-${end - 1}` }, signal: AbortSignal.timeout(30_000) });
    if (res.status !== 206 && res.status !== 200) throw new Error(`COPC read failed (${res.status})`);
    const buf = new Uint8Array(await res.arrayBuffer());
    stats.bytes += buf.byteLength;
    return res.status === 200 ? buf.subarray(begin, end) : buf;
  };
  return (begin, end) => once(begin, end).catch(() => once(begin, end));
}

type Cube = [number, number, number, number, number, number];

function nodeBox(key: string, cube: Cube): Bbox {
  const [d, x, y] = key.split('-').map(Number) as [number, number, number];
  const size = (cube[3] - cube[0]) / 2 ** d;
  const minX = cube[0] + x * size, minY = cube[1] + y * size;
  return { minX, minY, maxX: minX + size, maxY: minY + size };
}

const overlaps = (a: Bbox, b: Bbox) => a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;

export interface CopcRaster {
  grid: PointGrid;
  /** A sample of ground-classified points (x, y, z in the window's CRS) for the datum check. */
  ground: [number, number, number][];
  stats: CopcStats;
}

/**
 * Which octree levels to read. Every level is a uniform thinning of the cloud, so any subset of
 * levels is still uniform; we take levels in order of density gained per point read (shallow
 * levels have huge nodes that mostly lie outside the box) until reaching `target` points per m².
 * A level's density is its points over its nodes' area (nodes only exist where there are points).
 */
export function levelsForDensity(nodes: { depth: number; points: number; size: number }[], target: number): Set<number> {
  const levels = new Map<number, { points: number; area: number }>();
  for (const n of nodes) {
    const l = levels.get(n.depth) ?? { points: 0, area: 0 };
    l.points += n.points;
    l.area += n.size * n.size;
    levels.set(n.depth, l);
  }
  const ranked = [...levels]
    .filter(([, l]) => l.points > 0)
    .map(([depth, l]) => ({ depth, density: l.points / l.area, cost: l.points }))
    .sort((a, b) => b.density / b.cost - a.density / a.cost);
  const chosen = new Set<number>();
  let density = 0;
  for (const l of ranked) {
    if (density >= target) break;
    chosen.add(l.depth);
    density += l.density;
  }
  return chosen;
}

/**
 * Grid the highest non-noise return per cell for `box` (in the window's CRS, UTM 10N) into
 * `window`. Reads only the octree levels needed for `targetDensity`, and at most about
 * `maxPoints` points.
 */
export async function rasterizeCopc(
  urls: string[],
  window: PixelWindow,
  box: Bbox,
  region: Region,
  { maxPoints, targetDensity }: { maxPoints: number; targetDensity: number },
  isCurrent: () => boolean,
): Promise<CopcRaster> {
  const stats: CopcStats = { bytes: 0, nodes: 0, points: 0, failed: 0 };
  const grid = createPointGrid(window.width, window.height);
  const ground = new Reservoir<[number, number, number]>(20_000);
  const lp = await getLazPerf();

  // Open every file and collect the octree nodes overlapping the box.
  type Node = { pointCount: number; pointDataOffset: number; pointDataLength: number };
  const nodes: { depth: number; node: Node; get: Getter; copc: Copc }[] = [];
  await Promise.all(
    urls.map(async (url) => {
      const get = rangeGetter(url, stats);
      const copc = await Copc.create(get);
      const cube = copc.info.cube as Cube;
      const walk = async (page: { pageOffset: number; pageLength: number }): Promise<void> => {
        const sub = await Copc.loadHierarchyPage(get, page);
        for (const [key, node] of Object.entries(sub.nodes))
          if (node && node.pointCount > 0 && overlaps(nodeBox(key, cube), box)) nodes.push({ depth: Number(key.split('-')[0]), node, get, copc });
        await Promise.all(Object.entries(sub.pages).map(([key, p]) => (p && overlaps(nodeBox(key, cube), box) ? walk(p) : undefined)));
      };
      await walk(copc.info.rootHierarchyPage);
    }),
  );
  // Coarse levels first, so a read cut short by the point cap still covers the whole box.
  const levels = levelsForDensity(nodes.map((n) => ({ depth: n.depth, points: n.node.pointCount, size: (n.copc.info.cube[3] - n.copc.info.cube[0]) / 2 ** n.depth })), targetDensity);
  const wanted = nodes.filter((n) => levels.has(n.depth)).sort((a, b) => a.depth - b.depth);

  for (let i = 0; i < wanted.length && stats.points < maxPoints; i += 6) {
    if (!isCurrent()) break;
    const batch = wanted.slice(i, i + 6);
    const views = await Promise.all(
      batch.map(({ node, get, copc }) => {
        const read = () => Copc.loadPointDataView(get, copc, node, { lazPerf: lp, include: ['X', 'Y', 'Z', 'Classification'] });
        return read()
          .catch(read)
          .catch((e: unknown) => {
            console.warn('VanShade: skipped a point-cloud node', e);
            stats.failed++;
            return null;
          });
      }),
    );
    views.forEach((view, j) => {
      if (!view) return;
      const n = batch[j]!.node.pointCount;
      const gx = view.getter('X'), gy = view.getter('Y'), gz = view.getter('Z'), gc = view.getter('Classification');
      for (let p = 0; p < n; p++) {
        const cls = gc(p);
        if (NOISE_CLASSES.has(cls)) continue;
        const x = gx(p), y = gy(p);
        if (x < box.minX || x > box.maxX || y < box.minY || y > box.maxY) continue;
        const z = gz(p);
        const [px, py] = toPixel(window, [x, y]);
        addPoint(grid, region, px, py, z);
        if (cls === GROUND_CLASS) ground.add([x, y, z]);
      }
      stats.points += n;
      stats.nodes++;
    });
  }
  // A node or two missing leaves small holes that the fill covers; more means something is wrong.
  if (stats.failed > Math.max(2, 0.1 * wanted.length)) throw new Error(`${stats.failed} of ${wanted.length} point-cloud nodes failed to load`);
  return { grid, ground: ground.items, stats };
}
