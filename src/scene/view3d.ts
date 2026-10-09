// The 3D lot: DSM terrain with a real-time sun shadow, the engine's results draped on
// the lot, the lot outline, the day's sun path and the sun. Rendered on demand only.
// Scene axes: X = east, Y = up, Z = south (true north is −Z); see scene/frame.ts.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { PixelWindow } from '../elevation/window';
import { bilinear } from '../engine/grid';
import type { SunSample } from '../engine/sun';
import { applyAffine, invertAffine, type GridAffine } from '../geo/gridAffine';
import { polygonsOf, type AreaGeometry, type Position } from '../geo/polygon';
import { buildCellIndex, cellAtPixel, layerRgba, paintCellsRgba, type CellGrid, type Layer } from '../ui/cellPaint';
import { SHADE_RGB } from '../ui/colors';
import { SCENE, TOKENS } from '../ui/tokens';
import { compassRotationDeg, localToScene, sceneToLocal, sunDirection, sunPathPoints } from './frame';
import { MESH } from '../config';
import { baseLevel, buildGrid, buildTerraced, innerRect, type MeshArrays, type PixelRect, type TerrainColors, type TerrainInput } from './terrain';

export interface SceneModel {
  window: PixelWindow;
  dsm: Float32Array;
  dtm: Float32Array;
  affine: GridAffine;
  cells: CellGrid;
  /** The lot polygon(s) in local metres (x east, y true north). */
  lotLocal: AreaGeometry;
}

export interface ScenePhoto {
  image: HTMLCanvasElement;
  /** Grid pixel → photo texture coordinates (see imagery/georef.ts). */
  uv: GridAffine;
}

export interface SceneSun {
  azTrueDeg: number;
  altDeg: number;
  /** The selected day's samples, for the sun-path arc. */
  path: SunSample[];
}

export interface SceneHandlers {
  onPick(cell: number): void;
  onHover(cell: number | null): void;
  onCamera(compassDeg: number): void;
}

const rgb = (hex: string): [number, number, number] => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

function toGeometry(m: MeshArrays): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  g.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  g.computeVertexNormals();
  // The skirt only hides cracks between meshes: light it like flat ground so it never reads as a seam.
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let v = m.skirtStart; v < n.count; v++) n.setXYZ(v, 0, 1, 0);
  return g;
}

export class LotScene {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 1, 6000);
  private controls: OrbitControls;
  private sunLight = new THREE.DirectionalLight('#fff4e0', 2.4);
  private hemi = new THREE.HemisphereLight(SCENE.sky, SCENE.horizon, 1.2);
  private world = new THREE.Group(); // per-lot objects
  private terrain: THREE.Mesh[] = [];
  private clayMaterial: THREE.Material | null = null;
  private photo: ScenePhoto | null = null;
  private photoTexture: THREE.CanvasTexture | null = null;
  private resultsOpacity = 1;
  private terrainInput: TerrainInput | null = null;
  private changeMesh: THREE.Mesh | null = null;
  private overlay: THREE.Mesh | null = null;
  private layerTexture: THREE.CanvasTexture | null = null;
  private compareTexture: THREE.CanvasTexture | null = null;
  private lineMaterials: LineMaterial[] = [];
  private sunPath: Line2 | null = null;
  private sunMarker: THREE.Mesh;
  private cursor: THREE.Mesh;
  private model: SceneModel | null = null;
  private cellIndex: Int32Array | null = null;
  private base = 0;
  private home = { target: new THREE.Vector3(), position: new THREE.Vector3(), radius: 100 };
  private cursorCell: number | null = null;
  private pending = false;
  private hasLayer = false;
  private ro: ResizeObserver;
  private raycaster = new THREE.Raycaster();
  private downAt: { x: number; y: number } | null = null;
  private hoverQueued = false;

  constructor(private host: HTMLElement, private handlers: SceneHandlers, private opts: { lowPower: boolean }) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'scene-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'application');
    this.canvas.setAttribute('aria-roledescription', '3D lot view');
    host.prepend(this.canvas);

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.lowPower ? 1.5 : 2));
    this.renderer.setClearColor(TOKENS.fog);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.sunLight.castShadow = true;
    const size = opts.lowPower ? 1024 : 2048;
    this.sunLight.shadow.mapSize.set(size, size);
    this.sunLight.shadow.bias = -0.0004;
    this.sunLight.shadow.normalBias = 0.4;
    this.scene.add(this.hemi, this.sunLight, this.sunLight.target, this.world);

    this.sunMarker = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: TOKENS.sun, toneMapped: false }));
    this.cursor = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.58, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: TOKENS.cedar, toneMapped: false, depthTest: false }));
    this.cursor.renderOrder = 10;
    this.cursor.visible = false;
    this.scene.add(this.sunMarker, this.cursor);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 1500;
    this.controls.screenSpacePanning = true;
    // Touch: one finger turns the view (on phones a vertical drag scrolls the page instead; see
    // the coarse-pointer touch-action in styles.css), two fingers tilt, turn and pinch-zoom.
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };
    // OrbitControls sets an inline touch-action: none; on touch screens allow vertical page scrolling.
    if (matchMedia('(pointer: coarse)').matches) this.canvas.style.touchAction = 'pan-y';
    this.controls.addEventListener('change', () => {
      this.handlers.onCamera(compassRotationDeg(this.controls.getAzimuthalAngle()));
      this.invalidate();
    });

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.canvas.addEventListener('pointerdown', (e) => (this.downAt = { x: e.clientX, y: e.clientY }));
    this.canvas.addEventListener('click', (e) => this.onClick(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerleave', () => this.handlers.onHover(null));
    this.canvas.addEventListener('keydown', (e) => this.onKey(e));
    this.resize();
  }

  /** Build terrain, overlay geometry and outline for a newly loaded lot. */
  setModel(m: SceneModel, opts: { keepCamera?: boolean } = {}) {
    this.clearWorld();
    this.model = m;
    this.cellIndex = buildCellIndex(m.cells);
    this.base = baseLevel(m.dsm);
    const { width, height } = m.window;
    const input = { width, height, dsm: m.dsm, dtm: m.dtm, affine: m.affine, base: this.base };
    this.terrainInput = input;
    this.changeMesh = null; // cleared with the world
    const colors: TerrainColors = { ground: rgb(SCENE.ground), water: rgb(SCENE.water) };

    // Lot bounds in pixels, from the lot polygon.
    let c0 = Infinity, r0 = Infinity, c1 = -Infinity, r1 = -Infinity;
    for (const rings of polygonsOf(m.lotLocal)) {
      for (const p of rings[0] ?? []) {
        const [px, py] = invertAffine(m.affine, p);
        c0 = Math.min(c0, px); r0 = Math.min(r0, py); c1 = Math.max(c1, px); r1 = Math.max(r1, py);
      }
    }
    const lotRect: PixelRect = { c0: Math.floor(c0), r0: Math.floor(r0), c1: Math.ceil(c1), r1: Math.ceil(r1) };
    const res = m.window.res;
    const { innerStep, outerStep, marginPx } = meshSteps(lotRect, res);
    const inner = innerRect(lotRect, marginPx, outerStep, width, height);
    const outer: PixelRect = { c0: 0, r0: 0, c1: Math.floor((width - 1) / outerStep) * outerStep, r1: Math.floor((height - 1) / outerStep) * outerStep };
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.clayMaterial = material;
    this.photo = null; // its texture coordinates belong to the previous grid; the caller re-applies it
    // Near the lot: true cell footprints with vertical walls. Farther out: a smooth 4 m mesh.
    for (const arrays of [buildTerraced(input, inner, innerStep, colors, { wallM: MESH.wallM, skirtM: 3 }), buildGrid(input, outer, outerStep, colors, { hole: inner })]) {
      const mesh = new THREE.Mesh(toGeometry(arrays), material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.terrain.push(mesh);
      this.world.add(mesh);
    }

    // Results overlay: same surface over the lot, nudged up, unlit so colours match the legend.
    const lotGrid = buildTerraced(input, { c0: Math.max(0, lotRect.c0 - 1), r0: Math.max(0, lotRect.r0 - 1), c1: Math.min(width - 1, lotRect.c1 + 1), r1: Math.min(height - 1, lotRect.r1 + 1) }, 1, colors, { wallM: MESH.wallM, walls: false });
    for (let i = 1; i < lotGrid.positions.length; i += 3) lotGrid.positions[i]! += 0.06;
    this.overlay = new THREE.Mesh(
      toGeometry(lotGrid),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: this.resultsOpacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false }),
    );
    this.overlay.visible = false;
    this.overlay.renderOrder = 2;
    this.world.add(this.overlay);

    // Lot outline, draped on the surface.
    const raster = { width, height, data: m.dsm };
    for (const rings of polygonsOf(m.lotLocal)) {
      for (const ring of rings) {
        const pts: number[] = [];
        for (let k = 0; k < ring.length - 1; k++) {
          const a = ring[k]!, b = ring[k + 1]!;
          const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.5));
          for (let s = 0; s <= n; s++) {
            const p: Position = [a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n];
            const [px, py] = invertAffine(m.affine, p);
            const z = bilinear(raster, px, py);
            pts.push(...localToScene(p, (Number.isNaN(z) ? this.base : z) - this.base + 0.3));
          }
        }
        this.world.add(this.line(pts, TOKENS.sun, 3));
      }
    }

    // Home view: from the south-south-east, looking at the lot.
    const lotH = medianHeight(m) - this.base;
    const size = Math.max(Math.hypot(c1 - c0, r1 - r0) * res, 30);
    this.home.radius = Math.max(50, size * 1.1);
    this.home.target.set(0, lotH, 0);
    // From the south-south-east and fairly high (~55°), so shadows show beyond what casts them.
    this.home.position.copy(this.home.target).add(new THREE.Vector3(0.3, 1.5, 1).normalize().multiplyScalar(size * 2.2 + 40));
    if (!opts.keepCamera) this.resetView(); // a sharper surface for the same lot keeps the user's view

    // Shadow camera covers the whole window, so far casters still throw shadows onto the lot.
    const half = (Math.hypot(width, height) * res) / 2;
    const cam = this.sunLight.shadow.camera;
    cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
    cam.near = 1; cam.far = 4000;
    cam.updateProjectionMatrix();
    const centre = applyAffine(m.affine, [width / 2, height / 2]);
    this.sunLight.target.position.set(...localToScene(centre, lotH));
    this.canvas.dataset.state = 'elevation';
    this.invalidate();
  }

  setLayer(layer: Layer | null) {
    const m = this.model;
    if (!m || !this.overlay) return;
    this.layerTexture?.dispose();
    this.layerTexture = layer ? this.texture(layerRgba(m.cells, layer)) : null;
    this.hasLayer = !!layer;
    this.applyOverlay();
  }

  /** Engine sun/shade at the current time, drawn over the 3D shadows (shade tinted, sun clear). */
  setCompare(mask: Uint8Array | null) {
    const m = this.model;
    if (!m) return;
    this.compareTexture?.dispose();
    this.compareTexture = mask ? this.texture(paintCellsRgba(m.cells, (i) => (mask[i] ? null : { rgb: SHADE_RGB, alpha: 150 }), false)) : null;
    this.applyOverlay();
  }

  private applyOverlay() {
    if (!this.overlay) return;
    const mat = this.overlay.material as THREE.MeshBasicMaterial;
    mat.map = this.compareTexture ?? this.layerTexture;
    mat.needsUpdate = true;
    this.overlay.visible = !!mat.map;
    this.canvas.dataset.state = this.hasLayer ? 'result' : this.model ? 'elevation' : 'empty';
    this.invalidate();
  }

  /**
   * Drape an aerial photo over the terrain near the lot (null: back to the clay model). `uv` maps
   * grid pixels to the photo's texture coordinates; the far terrain stays clay.
   */
  setPhoto(photo: ScenePhoto | null) {
    this.photo = photo;
    const inner = this.terrain[0], m = this.model;
    if (!inner || !m || !this.clayMaterial) return;
    if (inner.material !== this.clayMaterial) (inner.material as THREE.Material).dispose();
    this.photoTexture?.dispose();
    this.photoTexture = null;
    inner.material = this.clayMaterial;
    if (photo) {
      // A second set of texture coordinates (uv1): grid pixel → photo, per vertex.
      const g = inner.geometry;
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      const uv1 = new Float32Array(uv.count * 2);
      for (let i = 0; i < uv.count; i++) {
        const [u, v] = applyAffine(photo.uv, [uv.getX(i) * m.window.width, uv.getY(i) * m.window.height]);
        uv1[2 * i] = u;
        uv1[2 * i + 1] = v;
      }
      g.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
      const tex = new THREE.CanvasTexture(photo.image);
      tex.flipY = false; // v runs down the photo, row 0 at the top
      tex.channel = 1;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      this.photoTexture = tex;
      // Slightly dimmed: the scene's lights are tuned for the pale clay, and would wash the photo out.
      inner.material = new THREE.MeshLambertMaterial({ map: tex, color: new THREE.Color(0.82, 0.82, 0.82) });
    }
    this.invalidate();
  }

  /**
   * A translucent hatch over parts of the terrain (where the newer survey replaced the older one),
   * under the results. `image` is window-sized; `rect` bounds the marked pixels.
   */
  setChangeMask(mask: { image: HTMLCanvasElement; rect: PixelRect } | null) {
    if (this.changeMesh) {
      this.world.remove(this.changeMesh);
      this.changeMesh.geometry.dispose();
      const mat = this.changeMesh.material as THREE.MeshBasicMaterial;
      mat.map?.dispose();
      mat.dispose();
      this.changeMesh = null;
    }
    const input = this.terrainInput;
    if (mask && input) {
      const r = mask.rect;
      const arrays = buildTerraced(input, { c0: Math.max(0, r.c0 - 1), r0: Math.max(0, r.r0 - 1), c1: Math.min(input.width - 1, r.c1), r1: Math.min(input.height - 1, r.r1) }, 1, { ground: [1, 1, 1], water: [1, 1, 1] }, { wallM: MESH.wallM, walls: false });
      for (let i = 1; i < arrays.positions.length; i += 3) arrays.positions[i]! += 0.04;
      const tex = new THREE.CanvasTexture(mask.image);
      tex.flipY = false;
      tex.magFilter = THREE.NearestFilter;
      tex.colorSpace = THREE.SRGBColorSpace;
      this.changeMesh = new THREE.Mesh(
        toGeometry(arrays),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, toneMapped: false }),
      );
      this.changeMesh.renderOrder = 1; // the results overlay (2) draws on top
      this.world.add(this.changeMesh);
    }
    this.invalidate();
  }

  /** How opaque the results are over the terrain (lowered to see the photo underneath). */
  setResultsOpacity(opacity: number) {
    this.resultsOpacity = opacity;
    if (this.overlay) (this.overlay.material as THREE.MeshBasicMaterial).opacity = opacity;
    this.invalidate();
  }

  setSun(sun: SceneSun) {
    const dir = new THREE.Vector3(...sunDirection(sun.azTrueDeg, sun.altDeg));
    const up = sun.altDeg > 0;
    const fade = Math.min(1, Math.max(0, sun.altDeg / 8));
    // A strong sun over a softer sky so cast shadows read clearly (they're there for intuition).
    this.sunLight.intensity = 3.2 * fade;
    this.hemi.intensity = up ? 0.75 : 0.55;
    this.sunLight.position.copy(this.sunLight.target.position).addScaledVector(dir, 1500);

    const r = this.home.radius;
    const t = this.home.target;
    this.sunMarker.visible = up;
    this.sunMarker.scale.setScalar(r * 0.018);
    this.sunMarker.position.copy(t).addScaledVector(dir, r);
    if (this.sunPath) {
      this.scene.remove(this.sunPath);
      this.sunPath.geometry.dispose();
      this.sunPath.material.dispose();
      this.lineMaterials = this.lineMaterials.filter((x) => x !== this.sunPath!.material);
    }
    const pts = sunPathPoints(sun.path, r).flatMap(([x, y, z]) => [x + t.x, y + t.y, z + t.z]);
    this.sunPath = pts.length >= 6 ? this.line(pts, TOKENS.sun, 2, 0.75) : null;
    if (this.sunPath) this.scene.add(this.sunPath);
    this.invalidate();
  }

  setShadows(on: boolean) {
    this.sunLight.castShadow = on;
    this.renderer.shadowMap.enabled = on;
    this.terrain.forEach((m) => ((m.material as THREE.Material).needsUpdate = true));
    this.invalidate();
  }

  resetView() {
    this.camera.position.copy(this.home.position);
    this.controls.target.copy(this.home.target);
    this.controls.update();
    this.handlers.onCamera(compassRotationDeg(this.controls.getAzimuthalAngle()));
    this.invalidate();
  }

  /** Move the keyboard cell cursor (or start it on the lot's middle cell). */
  setCursor(cell: number | null) {
    const m = this.model;
    this.cursorCell = cell;
    if (!m || cell === null) {
      this.cursor.visible = false;
      this.invalidate();
      return;
    }
    const p = applyAffine(m.affine, [m.cells.px[cell]!, m.cells.py[cell]!]);
    const z = bilinear({ width: m.window.width, height: m.window.height, data: m.dsm }, m.cells.px[cell]!, m.cells.py[cell]!);
    this.cursor.position.set(...localToScene(p, (Number.isNaN(z) ? this.base : z) - this.base + 0.35));
    this.cursor.scale.setScalar(m.cells.step * m.window.res);
    this.cursor.visible = true;
    this.invalidate();
  }

  invalidate() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.renderer.render(this.scene, this.camera);
    });
  }

  dispose() {
    this.ro.disconnect();
    this.controls.dispose();
    this.clearWorld();
    this.renderer.dispose();
    this.canvas.remove();
  }

  private clearWorld() {
    this.photoTexture?.dispose();
    this.photoTexture = null;
    this.world.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => x.dispose());
    });
    this.world.clear();
    this.terrain = [];
    this.overlay = null;
    this.layerTexture?.dispose();
    this.compareTexture?.dispose();
    this.layerTexture = this.compareTexture = null;
    // World lines were disposed above; keep only the sun path's material (it lives outside the world group).
    this.lineMaterials = this.sunPath ? [this.sunPath.material] : [];
    this.model = null;
    this.hasLayer = false;
    this.cursor.visible = false;
    this.cursorCell = null;
  }

  private texture(rgba: Uint8ClampedArray<ArrayBuffer>): THREE.CanvasTexture {
    const m = this.model!;
    const c = document.createElement('canvas');
    c.width = m.window.width;
    c.height = m.window.height;
    c.getContext('2d')!.putImageData(new ImageData(rgba, c.width, c.height), 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.flipY = false; // uv.v = py / height, row 0 at the top
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  private line(points: number[], color: string, widthPx: number, opacity = 1): Line2 {
    const geo = new LineGeometry();
    geo.setPositions(points);
    const mat = new LineMaterial({ color, linewidth: widthPx, transparent: opacity < 1, opacity, toneMapped: false });
    mat.resolution.set(this.host.clientWidth || 1, this.host.clientHeight || 1);
    this.lineMaterials.push(mat);
    const l = new Line2(geo, mat);
    l.renderOrder = 3;
    return l;
  }

  private resize() {
    const w = this.host.clientWidth || 640, h = this.host.clientHeight || 480;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.lineMaterials.forEach((m) => m.resolution.set(w, h));
    this.invalidate();
  }

  private cellFromEvent(e: MouseEvent): number | null {
    const m = this.model;
    if (!m || !this.cellIndex || !this.terrain.length) return null;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.terrain[0]!, false)[0];
    if (!hit) return null;
    const [px, py] = invertAffine(m.affine, sceneToLocal([hit.point.x, hit.point.y, hit.point.z]));
    return cellAtPixel(m.cells, this.cellIndex, px, py);
  }

  private onClick(e: MouseEvent) {
    if (this.downAt && Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) > 4) return; // a drag, not a click
    const cell = this.cellFromEvent(e);
    if (cell === null) return;
    this.setCursor(cell);
    this.handlers.onPick(cell);
  }

  private onMove(e: PointerEvent) {
    if (this.hoverQueued || e.buttons) return;
    this.hoverQueued = true;
    requestAnimationFrame(() => {
      this.hoverQueued = false;
      this.handlers.onHover(this.cellFromEvent(e));
    });
  }

  private onKey(e: KeyboardEvent) {
    const m = this.model;
    if (!m || !this.cellIndex) return;
    const moves: Record<string, Position> = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowRight: [1, 0], ArrowLeft: [-1, 0] };
    if (e.key in moves) {
      e.preventDefault();
      const next = this.cursorCell === null ? nearestCellToOrigin(m) : stepCell(m, this.cellIndex, this.cursorCell, moves[e.key]!);
      if (next !== null) {
        this.setCursor(next);
        this.handlers.onHover(next);
      }
    } else if ((e.key === 'Enter' || e.key === ' ') && this.cursorCell === null) {
      e.preventDefault();
      const c = nearestCellToOrigin(m);
      if (c !== null) {
        this.setCursor(c);
        this.handlers.onPick(c);
      }
    } else if ((e.key === 'Enter' || e.key === ' ') && this.cursorCell !== null) {
      e.preventDefault();
      this.handlers.onPick(this.cursorCell);
    } else if (e.key === 'Escape') {
      this.setCursor(null);
    }
  }
}

/**
 * Terrain mesh spacing in grid pixels: native resolution within 40 m of the lot (unless that
 * would pass MESH.innerMaxCells cells, then 1 m), and 4 m farther out. The outer step aligns the hole.
 */
export function meshSteps(lot: PixelRect, res: number): { innerStep: number; outerStep: number; marginPx: number } {
  const outerStep = Math.max(1, Math.round(4 / res));
  const marginPx = Math.round(40 / res);
  const verts = (lot.c1 - lot.c0 + 2 * marginPx) * (lot.r1 - lot.r0 + 2 * marginPx);
  const innerStep = verts > MESH.innerMaxCells ? Math.max(1, Math.round(1 / res)) : 1;
  return { innerStep, outerStep, marginPx };
}

function medianHeight(m: SceneModel): number {
  const v: number[] = [];
  for (let i = 0; i < m.cells.px.length; i += Math.max(1, Math.floor(m.cells.px.length / 500))) {
    const z = bilinear({ width: m.window.width, height: m.window.height, data: m.dtm }, m.cells.px[i]!, m.cells.py[i]!);
    if (!Number.isNaN(z)) v.push(z);
  }
  v.sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)]! : 0;
}

/** The cell nearest the lot's local origin (its centroid). */
export function nearestCellToOrigin(m: Pick<SceneModel, 'affine' | 'cells'>): number | null {
  let best: number | null = null, bestD = Infinity;
  for (let i = 0; i < m.cells.px.length; i++) {
    const [x, y] = applyAffine(m.affine, [m.cells.px[i]!, m.cells.py[i]!]);
    const d = x * x + y * y;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** One cell step in a TRUE direction (east, north), or null if that leaves the lot. */
export function stepCell(m: Pick<SceneModel, 'affine' | 'cells'>, index: Int32Array, cell: number, [dx, dy]: Position): number | null {
  const here = applyAffine(m.affine, [m.cells.px[cell]!, m.cells.py[cell]!]);
  const step = m.cells.step * Math.hypot(m.affine.col[0], m.affine.col[1]); // metres
  for (const k of [1, 1.5]) {
    const target: Position = [here[0] + dx * step * k, here[1] + dy * step * k];
    const [px, py] = invertAffine(m.affine, target);
    const next = cellAtPixel(m.cells, index, px, py);
    if (next !== null && next !== cell) return next;
  }
  return null;
}
