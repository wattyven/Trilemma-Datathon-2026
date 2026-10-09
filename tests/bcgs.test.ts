import { describe, expect, it } from 'vitest';
import { bcgsTileBounds, bcgsTileId, bcgsTilesInBox } from '../src/elevation/bcgs';

describe('BCGS 1:2 500 tiles', () => {
  it('names the tiles verified against real files', () => {
    expect(bcgsTileId([-123.1139388, 49.261317])).toBe('092g025_3_2_2'); // Vancouver City Hall
    expect(bcgsTileId([-122.849, 49.191])).toBe('092g016_4_4_3'); // Surrey
  });

  it('round-trips ids and bounds (~1.4 km × 1.8 km tiles)', () => {
    const b = bcgsTileBounds('092g025_3_2_2');
    expect(b.south).toBeCloseTo(49.25, 9);
    expect(b.north).toBeCloseTo(49.2625, 9);
    expect(b.west).toBeCloseTo(-123.125, 9);
    expect(b.east).toBeCloseTo(-123.1, 9);
    expect(bcgsTileId([(b.west + b.east) / 2, (b.south + b.north) / 2])).toBe('092g025_3_2_2');
  });

  it('lists every tile a box touches', () => {
    const b = bcgsTileBounds('092g025_3_2_2');
    // A box straddling the tile's NE corner touches four tiles.
    const ids = bcgsTilesInBox({ south: b.north - 0.001, north: b.north + 0.001, west: b.east - 0.001, east: b.east + 0.001 });
    // North of 3_2_2 is 3_2_4; east (across the sheet's middle meridian) is 4_1_1; north-east is 4_1_3.
    expect(ids).toEqual(['092g025_3_2_2', '092g025_3_2_4', '092g025_4_1_1', '092g025_4_1_3']);
  });

  it('returns null outside NTS block 092G', () => {
    expect(bcgsTileId([-121.5, 49.2])).toBeNull();
    expect(bcgsTileId([-123.1, 48.9])).toBeNull();
  });
});
