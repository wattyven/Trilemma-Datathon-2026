// Planar polygon helpers. Coordinates are [x, y]: lon/lat for tests on raw GeoJSON,
// or local metres (geo/local.ts) for areas and distances.

export type Position = [number, number];
export type Ring = Position[];
export interface PolygonGeometry { type: 'Polygon'; coordinates: Ring[] }
export interface MultiPolygonGeometry { type: 'MultiPolygon'; coordinates: Ring[][] }
export type AreaGeometry = PolygonGeometry | MultiPolygonGeometry;

/** Each polygon as [outer, ...holes]. */
export function polygonsOf(g: AreaGeometry): Ring[][] {
  return g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
}

export function pointInRing([x, y]: Position, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInGeometry(pt: Position, g: AreaGeometry): boolean {
  return polygonsOf(g).some(([outer, ...holes]) => !!outer && pointInRing(pt, outer) && !holes.some((h) => pointInRing(pt, h)));
}

/** Signed shoelace area (positive when counter-clockwise). */
export function ringSignedArea(ring: Ring): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    a += xj * yi - xi * yj;
  }
  return a / 2;
}

export function geometryArea(g: AreaGeometry): number {
  return polygonsOf(g).reduce(
    (sum, [outer, ...holes]) => sum + Math.abs(ringSignedArea(outer ?? [])) - holes.reduce((h, r) => h + Math.abs(ringSignedArea(r)), 0),
    0,
  );
}

/** Area-weighted centroid of all outer rings (holes ignored; good enough to centre a frame). */
export function geometryCentroid(g: AreaGeometry): Position {
  let cx = 0, cy = 0, total = 0;
  for (const [outer] of polygonsOf(g)) {
    if (!outer) continue;
    const a = ringSignedArea(outer);
    if (a === 0) continue;
    let sx = 0, sy = 0;
    for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
      const [xi, yi] = outer[i]!;
      const [xj, yj] = outer[j]!;
      const f = xj * yi - xi * yj;
      sx += (xi + xj) * f;
      sy += (yi + yj) * f;
    }
    cx += sx / 6;
    cy += sy / 6;
    total += a;
  }
  if (total === 0) {
    const b = bounds(g);
    return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
  }
  return [cx / total, cy / total];
}

export function distanceToSegment([px, py]: Position, [ax, ay]: Position, [bx, by]: Position): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Distance from a point to the polygon boundary, or 0 when the point is inside. */
export function distanceToGeometry(pt: Position, g: AreaGeometry): number {
  if (pointInGeometry(pt, g)) return 0;
  let best = Infinity;
  for (const rings of polygonsOf(g)) {
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        best = Math.min(best, distanceToSegment(pt, ring[j]!, ring[i]!));
      }
    }
  }
  return best;
}

export function mapGeometry(g: AreaGeometry, fn: (p: Position) => Position): AreaGeometry {
  return g.type === 'Polygon'
    ? { type: 'Polygon', coordinates: g.coordinates.map((r) => r.map(fn)) }
    : { type: 'MultiPolygon', coordinates: g.coordinates.map((p) => p.map((r) => r.map(fn))) };
}

export function bounds(g: AreaGeometry): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const rings of polygonsOf(g)) {
    for (const ring of rings) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

/** Identity key for deduplicating identical geometries (ParcelMap stacks one polygon per strata lot). */
export function geometryKey(g: AreaGeometry, decimals = 7): string {
  const f = 10 ** decimals;
  return JSON.stringify(polygonsOf(g).map((rings) => rings.map((r) => r.map(([x, y]) => [Math.round(x * f), Math.round(y * f)]))));
}
