import { describe, expect, it } from 'vitest';
import index from '../src/elevation/hires-index.json';
import { lotAreaM2, projectLabel, refinementFor, refinementOptions, refinementOrder, selectCopc, selectLidarbc, type HiresIndex } from '../src/elevation/hires';
import type { Ring } from '../src/geo/polygon';

const idx = index as unknown as HiresIndex;

/** A square "lot" of `sizeM` metres around a point. */
function lot([lon, lat]: [number, number], sizeM = 30): Ring[][] {
  const dLat = sizeM / 2 / 111_320, dLon = sizeM / 2 / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [[[[lon - dLon, lat - dLat], [lon + dLon, lat - dLat], [lon + dLon, lat + dLat], [lon - dLon, lat + dLat], [lon - dLon, lat - dLat]]]];
}

describe('point-cloud file selection', () => {
  it('finds the 2016 Lower Mainland cloud at Vancouver City Hall', () => {
    const c = selectCopc(idx, lot([-123.1139388, 49.261317]), 2016);
    expect(c?.project).toBe('Lower Mainland 2016');
    expect(c?.year).toBe(2016);
    expect(c?.copc.urls.some((u) => u.includes('bc_092g025_3_2_2_'))).toBe(true);
    expect(c?.copc.urls.every((u) => u.startsWith('https://canelevation-lidar-point-clouds.s3.ca-central-1.amazonaws.com/pointclouds_nuagespoints/'))).toBe(true);
  });

  it('skips a cloud older than the HRDEM survey at the lot', () => {
    expect(selectCopc(idx, lot([-123.1139388, 49.261317]), 2020)).toBeNull();
  });

  it('uses the 1 km UTM files in Maple Ridge (FHIMP 2023)', () => {
    const c = selectCopc(idx, lot([-122.5999606, 49.2193815]), 2023);
    expect(c?.year).toBe(2023);
    expect(c?.project).toMatch(/FHIMP/);
    expect(c?.copc.urls[0]).toMatch(/_1km_E\d{4}_N\d{5}_CLASS\.copc\.laz$/);
  });

  it('adds margin files from the same survey when a lot sits near a tile edge', () => {
    // Just inside the north-east corner of 092g025_3_2_2.
    const c = selectCopc(idx, lot([-123.101, 49.2622], 10), 2016);
    expect(c!.copc.urls.length).toBeGreaterThan(1);
    expect(new Set(c!.copc.urls.map((u) => u.split('/').at(-2))).size).toBe(1); // one survey
  });

  it('labels projects and measures lots', () => {
    expect(projectLabel('pointclouds_nuagespoints/NRCAN/FHIMP_PICAI_BC_South_West_UTM10_2023/')).toBe('Fraser Valley (FHIMP) 2023');
    expect(lotAreaM2(lot([-123.1139388, 49.261317], 30))).toBeCloseTo(900, -1);
  });
});

const CITY_HALL: [number, number] = [-123.1139388, 49.261317];
const SURREY: [number, number] = [-122.849, 49.191];
const PROXY = 'https://proxy.example';

describe('LidarBC tile selection', () => {
  it('picks the 2025 survey at City Hall, through the proxy', () => {
    const c = selectLidarbc(idx, lot(CITY_HALL), 2016, PROXY)!;
    expect(c.year).toBe(2025);
    expect(c.lidarbc.dsm).toContain(`${PROXY}/gdwuts/092/092g/2025/dsm/bc_092g025_3_2_2_xli1m_utm10_20250425_20250826_dsm.tif`);
    expect(c.lidarbc.dem).toContain(`${PROXY}/gdwuts/092/092g/2025/dem/bc_092g025_3_2_2_xli1m_utm10_20250425_20250826.tif`);
    // The 200 m buffer reaches neighbouring tiles; the DEM (lot + 44 m) needs fewer.
    expect(c.lidarbc.dsm.length).toBeGreaterThanOrEqual(c.lidarbc.dem.length);
    expect(c.lidarbc.dsm.every((u) => u.includes('/2025/dsm/'))).toBe(true);
  });

  it('picks 2024 in Surrey and nothing when no survey is newer than asked', () => {
    expect(selectLidarbc(idx, lot(SURREY), 2016, PROXY)?.year).toBe(2024);
    expect(selectLidarbc(idx, lot(CITY_HALL), 2025, PROXY)).toBeNull();
  });
});

describe('which sharper surfaces a lot can use', () => {
  const hrdem = { dsmUrl: 'dsm.tif', dtmUrl: 'dtm.tif' };
  const MAPLE_RIDGE: [number, number] = [-122.5999606, 49.2193815];

  it('offers all three where a point cloud and a newer LidarBC survey both exist', async () => {
    for (const [where, newYear, oldYear] of [[CITY_HALL, '2025', '2016'], [SURREY, '2024', '2016'], [MAPLE_RIDGE, '2025', '2023']] as const) {
      const o = await refinementOptions(hrdem, lot(where), where, PROXY);
      expect(o.best?.kind).toBe('merged');
      expect(o.newest?.kind).toBe('lidarbc');
      expect(o.detailed?.kind).toBe('copc');
      expect(o.best?.year).toBe(newYear);
      expect(o.best?.kind === 'merged' && o.best.oldYear).toBe(oldYear);
    }
  });

  it('offers only the point cloud without the proxy, and nothing for very big lots', async () => {
    const o = await refinementOptions(hrdem, lot(CITY_HALL), CITY_HALL, '');
    expect(Object.keys(o).sort()).toEqual(['best', 'detailed']);
    expect(o.best).toBe(o.detailed);
    expect(await refinementOptions(hrdem, lot(CITY_HALL, 250), CITY_HALL, PROXY)).toEqual({});
  });

  it('follows the preference, falling back in order', async () => {
    expect((await refinementFor(hrdem, lot(CITY_HALL), CITY_HALL, 'best', PROXY))?.kind).toBe('merged');
    expect((await refinementFor(hrdem, lot(CITY_HALL), CITY_HALL, 'newest', PROXY))?.kind).toBe('lidarbc');
    expect((await refinementFor(hrdem, lot(CITY_HALL), CITY_HALL, 'detailed', PROXY))?.kind).toBe('copc');
    expect((await refinementFor(hrdem, lot(CITY_HALL), CITY_HALL, 'newest', ''))?.kind).toBe('copc'); // no proxy: the point cloud
    expect(await refinementFor(hrdem, lot(CITY_HALL), CITY_HALL, 'hrdem', PROXY)).toBeNull();
    const o = await refinementOptions(hrdem, lot(CITY_HALL), CITY_HALL, PROXY);
    expect(refinementOrder(o, 'newest').map((s) => s.kind)).toEqual(['lidarbc', 'merged', 'copc']);
  });
});
