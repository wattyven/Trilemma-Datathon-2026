import { describe, expect, it } from 'vitest';
import { applyAffine, invertAffine, type GridAffine } from '../src/geo/gridAffine';
import { localToScene, sceneToLocal } from '../src/scene/frame';
import { nearestCellToOrigin, stepCell } from '../src/scene/view3d';
import { buildCellIndex, cellAtPixel, type CellGrid } from '../src/ui/cellPaint';

const g = (25 * Math.PI) / 180;
const col: [number, number] = [Math.cos(g), -Math.sin(g)], row: [number, number] = [-Math.sin(g), -Math.cos(g)];
// Local origin (the lot centre) at pixel (10, 10), the middle of the 4…16 cell block.
const AFFINE: GridAffine = { origin: [-(col[0] + row[0]) * 10, -(col[1] + row[1]) * 10], col, row };

function grid(step: number): CellGrid {
  const px: number[] = [], py: number[] = [];
  for (let r = 4; r < 16; r += step) for (let c = 4; c < 16; c += step) {
    px.push(c + step / 2);
    py.push(r + step / 2);
  }
  return { width: 20, height: 20, px: Float32Array.from(px), py: Float32Array.from(py), covered: new Uint8Array(px.length), step };
}

describe('picking: scene point → cell', () => {
  it.each([1, 2])('round-trips every cell (step %i m)', (step) => {
    const cells = grid(step);
    const index = buildCellIndex(cells);
    for (let i = 0; i < cells.px.length; i++) {
      const local = applyAffine(AFFINE, [cells.px[i]!, cells.py[i]!]);
      const scene = localToScene(local, 12.3);
      const [px, py] = invertAffine(AFFINE, sceneToLocal(scene));
      expect(cellAtPixel(cells, index, px, py)).toBe(i);
    }
  });

  it('returns null off the lot', () => {
    const cells = grid(1);
    expect(cellAtPixel(cells, buildCellIndex(cells), 1, 1)).toBeNull();
    expect(cellAtPixel(cells, buildCellIndex(cells), -3, 50)).toBeNull();
  });
});

describe('keyboard cursor', () => {
  const cells = grid(1);
  const index = buildCellIndex(cells);
  const m = { affine: AFFINE, cells };
  const localOf = (i: number) => applyAffine(AFFINE, [cells.px[i]!, cells.py[i]!]);

  it('starts on the cell nearest the lot centre', () => {
    const start = nearestCellToOrigin(m)!;
    const [x, y] = localOf(start);
    expect(Math.hypot(x, y)).toBeLessThan(1);
  });

  it('steps one cell in TRUE north and east, not along the rotated grid', () => {
    const start = nearestCellToOrigin(m)!;
    const [x0, y0] = localOf(start);
    const north = stepCell(m, index, start, [0, 1])!;
    const [xn, yn] = localOf(north);
    expect(yn - y0).toBeGreaterThan(0.5);
    expect(Math.abs(xn - x0)).toBeLessThan(0.9);
    const east = stepCell(m, index, start, [1, 0])!;
    const [xe, ye] = localOf(east);
    expect(xe - x0).toBeGreaterThan(0.5);
    expect(Math.abs(ye - y0)).toBeLessThan(0.9);
  });

  it('stops at the lot edge', () => {
    let c = nearestCellToOrigin(m)!;
    for (let k = 0; k < 40; k++) c = stepCell(m, index, c, [0, 1]) ?? c;
    expect(stepCell(m, index, c, [0, 1])).toBeNull();
  });
});
