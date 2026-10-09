// Kept apart from view3d.ts so checking for WebGL doesn't pull in three.js.

/** True when WebGL is usable at all (otherwise the 2D map is the only view). */
export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    return false;
  }
}

/** Phones and small screens get a smaller shadow map and pixel ratio. */
export function isLowPower(): boolean {
  return (window.matchMedia?.('(pointer: coarse)').matches ?? false) || window.innerWidth < 720;
}
