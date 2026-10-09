// What changed between two hires-index.json files (ignoring the build date), as markdown lines.
// Pure, so tests can import it; spike/22-index-diff.ts is the command-line wrapper.

export interface IndexLike {
  copc: { projects: string[]; tiles: Record<string, [number, string, number, number][]>; utm: Record<string, [number, number, number, number][]> };
  lidarbc: { tiles: Record<string, [number, string, number][]> };
}

/** Tile entries per survey year (the year sits at `yearAt` in each entry). */
const byYear = (lists: unknown[][][], yearAt: number) => {
  const out = new Map<number, number>();
  for (const list of lists)
    for (const e of list) {
      const y = e[yearAt] as number;
      out.set(y, (out.get(y) ?? 0) + 1);
    }
  return out;
};
const projectName = (p: string) => p.split('/').filter(Boolean).at(-1) ?? p;

/** Markdown lines describing what changed from `a` to `b`; empty when nothing did. */
export function diffIndex(a: IndexLike, b: IndexLike): string[] {
  const lines: string[] = [];
  const newProjects = b.copc.projects.filter((p) => !a.copc.projects.includes(p));
  if (newProjects.length) lines.push(`- New NRCan point-cloud projects: ${newProjects.map((p) => `\`${projectName(p)}\``).join(', ')}`);
  const yearLines = (label: string, ya: Map<number, number>, yb: Map<number, number>) => {
    for (const y of [...new Set([...ya.keys(), ...yb.keys()])].sort()) {
      const na = ya.get(y) ?? 0, nb = yb.get(y) ?? 0;
      if (na !== nb) lines.push(`- ${label} ${y}: ${na} → ${nb} tiles`);
    }
  };
  // Point-cloud entries carry the year at index 2 (both BCGS and 1 km UTM tiles); LidarBC at 0.
  yearLines('Point clouds', byYear([...Object.values(a.copc.tiles), ...Object.values(a.copc.utm)], 2), byYear([...Object.values(b.copc.tiles), ...Object.values(b.copc.utm)], 2));
  yearLines('LidarBC', byYear(Object.values(a.lidarbc.tiles), 0), byYear(Object.values(b.lidarbc.tiles), 0));
  // Same counts but different files (a re-processed survey, say).
  if (!lines.length && JSON.stringify([a.copc, a.lidarbc]) !== JSON.stringify([b.copc, b.lidarbc])) lines.push('- File names changed for existing tiles (same surveys and tile counts).');
  return lines;
}
