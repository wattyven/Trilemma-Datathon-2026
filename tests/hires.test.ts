import { describe, expect, it } from 'vitest';
import index from '../src/elevation/hires-index.json';
import { lotAreaM2, projectLabel, selectCopc, type HiresIndex } from '../src/elevation/hires';
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
