// Live: points per m² in each octree level of the COPC files under a few lots (to tune HIRES.copcTargetDensity).
import { Copc } from 'copc';
import { it } from 'vitest';
import { loadHiresIndex, selectCopc } from '../src/elevation/hires';
import type { Ring } from '../src/geo/polygon';

function lot([lon, lat]: [number, number], sizeM = 30): Ring[][] {
  const dLat = sizeM / 2 / 111_320, dLon = sizeM / 2 / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [[[[lon - dLon, lat - dLat], [lon + dLon, lat - dLat], [lon + dLon, lat + dLat], [lon - dLon, lat + dLat], [lon - dLon, lat - dLat]]]];
}

it('level densities', async () => {
  for (const lonLat of [[-123.1686926, 49.2647221], [-122.5999606, 49.2193815]] as [number, number][]) {
    const url = selectCopc(await loadHiresIndex(), lot(lonLat), null)!.copc.urls[0]!;
    const copc = await Copc.create(url);
    const cube = copc.info.cube;
    const levels = new Map<number, { points: number; area: number; nodes: number }>();
    const walk = async (page: { pageOffset: number; pageLength: number }): Promise<void> => {
      const sub = await Copc.loadHierarchyPage(url, page);
      for (const [key, node] of Object.entries(sub.nodes)) {
        if (!node) continue;
        const d = Number(key.split('-')[0]), size = (cube[3] - cube[0]) / 2 ** d;
        const l = levels.get(d) ?? { points: 0, area: 0, nodes: 0 };
        l.points += node.pointCount; l.area += size * size; l.nodes++;
        levels.set(d, l);
      }
      for (const p of Object.values(sub.pages)) if (p) await walk(p);
    };
    await walk(copc.info.rootHierarchyPage);
    console.log(url.split('/').at(-1), `cube ${(cube[3] - cube[0]).toFixed(0)} m`);
    let cum = 0;
    for (const [d, l] of [...levels].sort((a, b) => a[0] - b[0])) {
      cum += l.points / l.area;
      console.log(`  depth ${d}: ${l.nodes} nodes of ${((cube[3] - cube[0]) / 2 ** d).toFixed(0)} m, ${(l.points / l.area).toFixed(2)} pts/m² (cumulative ${cum.toFixed(1)}), ${(l.points / l.nodes / 1000).toFixed(0)}k pts/node`);
    }
  }
});
