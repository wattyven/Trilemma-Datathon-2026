import { describe, expect, it } from 'vitest';
import { LruCache, memo } from '../src/elevation/cache';
import { alignedWindow } from '../src/elevation/window';

describe('download cache', () => {
  it('evicts the least recently used entry', () => {
    const c = new LruCache<number>(2);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBe(1); // a is now the most recent
    c.set('c', 3);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(1);
    expect(c.size).toBe(2);
  });

  it('hands out copies, so builders can write into what they get', async () => {
    const c = new LruCache<Float32Array>(2);
    let builds = 0;
    const get = () => memo(c, 'k', async () => (builds++, new Float32Array([1, 2])), (v) => v.slice());
    const a = await get();
    a[0] = 99;
    const b = await get();
    expect(b[0]).toBe(1);
    expect(builds).toBe(1);
  });

  it("doesn't keep a cancelled build", async () => {
    const c = new LruCache<number>(2);
    await memo(c, 'k', async () => 1, (v) => v, () => false);
    expect(c.get('k')).toBeUndefined();
  });
});

describe('UTM windows on whole metres', () => {
  it('lines 0.5 m and 1 m windows up cell for 2 × 2 cells', () => {
    const lot = { minX: 491_234.3, minY: 5_456_101.9, maxX: 491_290.1, maxY: 5_456_150.2 };
    const half = alignedWindow(lot, 200, 0.5, 'EPSG:3157', 1), one = alignedWindow(lot, 200, 1, 'EPSG:3157', 1);
    expect([half.x0, half.y0]).toEqual([one.x0, one.y0]);
    expect([half.width, half.height]).toEqual([2 * one.width, 2 * one.height]);
    expect(Number.isInteger(half.y0)).toBe(true);
  });
});
