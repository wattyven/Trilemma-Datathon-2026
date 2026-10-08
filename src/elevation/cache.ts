// A small least-recently-used cache for downloaded elevation pieces in the worker, so switching a
// lot between surfaces ("best of both", newest, most detailed) re-composes instead of re-fetching.
// Values are stored once and copied on the way out: the builders write into the arrays they get.

export class LruCache<V> {
  private map = new Map<string, V>();
  constructor(private max: number) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key); // most recently used goes last
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: V) {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }

  get size() {
    return this.map.size;
  }
}

/**
 * Return a cached value (copied with `copy`), or build it. Only values for which `keep()` is true
 * when the build finishes are stored (a cancelled build may have returned partial data).
 */
export async function memo<V>(cache: LruCache<V>, key: string, build: () => Promise<V>, copy: (v: V) => V, keep: () => boolean = () => true): Promise<V> {
  const hit = cache.get(key);
  if (hit !== undefined) return copy(hit);
  const v = await build();
  if (keep()) cache.set(key, copy(v));
  return v;
}
