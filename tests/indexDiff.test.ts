import { describe, expect, it } from 'vitest';
import { diffIndex, type IndexLike } from '../spike/index-diff';

const base = (): IndexLike => ({
  copc: { projects: ['pc/BC/Lower_Mainland_2016/'], tiles: { a: [[0, '_x.copc.laz', 2016, 10]] }, utm: {} },
  lidarbc: { tiles: { a: [[2025, '20250425_20250826', 1]] } },
});

describe('index refresh summary', () => {
  it('is empty when nothing changed', () => {
    expect(diffIndex(base(), base())).toEqual([]);
  });

  it('names new point-cloud projects and new survey years', () => {
    const next = base();
    next.copc.projects.push('pc/NRCAN/Lower_Mainland_2025/');
    next.copc.utm['E4900_N54500'] = [[1, 0, 2025, 30]];
    next.lidarbc.tiles.b = [[2026, '20260401_20260501', 1]];
    expect(diffIndex(base(), next)).toEqual([
      '- New NRCan point-cloud projects: `Lower_Mainland_2025`',
      '- Point clouds 2025: 0 → 1 tiles',
      '- LidarBC 2026: 0 → 1 tiles',
    ]);
  });

  it('notices renamed files with the same counts', () => {
    const next = base();
    next.copc.tiles.a = [[0, '_y.copc.laz', 2016, 10]];
    expect(diffIndex(base(), next)).toEqual(['- File names changed for existing tiles (same surveys and tile counts).']);
  });
});
