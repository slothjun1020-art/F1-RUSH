// Pure geometry for the 3D view: road, kerbs, runoff, guardrails, start line, hills and trees.
// No Three.js in here, only typed arrays, so it can be unit-tested in Node.
//
// Scene coordinates map the 2D game world onto the ground plane: world (x, y) -> scene (x, height, y).
// Looking straight down from +Y this matches the 2D top-down picture, so physics and lap logic
// (which only know 2D) need no changes. A car heading `a` in 2D is rotation.y = -a in the scene.

import { BARRIER, KERB_W } from '../shared/track-geom.js';
import { SCALE } from '../shared/scale.js';

export { KERB_W };

// Everything below that is measured in track units follows shared/scale.js: kerb and runoff widths come from
// track-geom.js, the rest uses these two factors. Heights that are about the cars (guardrail height) stay put.
const W = SCALE.width;
const L = SCALE.length;

export const WALL_H = 18;
export const WALL_HALF_T = 3 * W;
export const DASH_HALF = 1.5 * W;        // half width of the dashed center line
export const START_HALF = 9 * W;         // half depth of the orange start band
export const START_EDGE = [11 * W, 15 * W]; // the thin white lines either side of it

// Heights of each layer. Separated by more than depth-buffer noise at long range.
export const Y = {
  ground: -3,
  runoff: 0.6,
  asphalt: 1.2,
  dash: 1.8,
  kerb: 2.0,
  start: 2.6,
};

export const COLORS = {
  asphalt: '#4a4f58',
  dash: '#d5d8de',
  kerbRed: '#d63a2f',
  kerbWhite: '#f4f4f4',
  runoff: '#5fae55',
  wallSide: '#262a33',
  wallBand: '#30353f',
  wallTop: '#454b58',
  start: '#ff8a1f',
  startEdge: '#f4f4f4',
  groundLow: '#3f9142',
  groundMid: '#58a84a',
  groundHigh: '#8cc267',
};

const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

// Vertex colors are read as linear values by Three.js, so convert from sRGB hex here.
export function hexLinear(hex, k = 1) {
  const n = parseInt(hex.slice(1), 16);
  return [
    lin(((n >> 16) & 255) / 255) * k,
    lin(((n >> 8) & 255) / 255) * k,
    lin((n & 255) / 255) * k,
  ];
}

const hash = (a, b = 0) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

class MeshData {
  constructor() {
    this.pos = [];
    this.col = [];
    this.idx = [];
  }

  vertex(p, c) {
    this.pos.push(p[0], p[1], p[2]);
    this.col.push(c[0], c[1], c[2]);
    return this.pos.length / 3 - 1;
  }

  quad(a, b, c, d, color) {
    const i = this.vertex(a, color);
    this.vertex(b, color);
    this.vertex(c, color);
    this.vertex(d, color);
    this.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }

  tri(a, b, c, color) {
    const i = this.vertex(a, color);
    this.vertex(b, color);
    this.vertex(c, color);
    this.idx.push(i, i + 1, i + 2);
  }

  arrays() {
    return {
      positions: new Float32Array(this.pos),
      colors: new Float32Array(this.col),
      indices: new Uint32Array(this.idx),
    };
  }
}

// Unit tangent and left/right normal at every centerline sample (central difference).
export function trackFrames(track) {
  const { n, xs, ys } = track;
  const tx = new Float64Array(n);
  const ty = new Float64Array(n);
  const nx = new Float64Array(n);
  const ny = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = (i - 1 + n) % n;
    const q = (i + 1) % n;
    const dx = xs[q] - xs[p];
    const dy = ys[q] - ys[p];
    const len = Math.hypot(dx, dy) || 1;
    tx[i] = dx / len;
    ty[i] = dy / len;
    nx[i] = -ty[i];
    ny[i] = tx[i];
  }
  return { tx, ty, nx, ny };
}

// Scene position of the point `o` units to the side of centerline sample i, at height y.
export function edgePoint(track, fr, i, o, y) {
  return [track.xs[i] + fr.nx[i] * o, y, track.ys[i] + fr.ny[i] * o];
}

// Answers "is a decoration at offset o from sample i really on the edge of *its own* road?".
// Kerbs, runoff and walls are dropped where they would land on another stretch of road
// (where the circuit crosses or runs close to itself, e.g. Suzuka's crossover) or where the offset
// curve folds over itself on the inside of a tight corner.
function makeValidator(track) {
  const { n, xs, ys, halfW, spacing } = track;
  const nearSpan = Math.ceil((track.width * 4) / spacing);
  const cache = new Map();
  return (fr, i, o) => {
    const key = i * 4096 + Math.round(o * 4);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const px = xs[i] + fr.nx[i] * o;
    const py = ys[i] + fr.ny[i] * o;
    let dNear = Infinity;
    let dFar = Infinity;
    for (let j = 0; j < n; j++) {
      const gap = Math.abs(j - i);
      const arc = Math.min(gap, n - gap);
      const d = Math.hypot(xs[j] - px, ys[j] - py);
      if (arc <= nearSpan) { if (d < dNear) dNear = d; } else if (d < dFar) dFar = d;
    }
    const a = Math.abs(o);
    const ok = a < halfW ? dFar >= halfW : dNear >= a - 4 && dFar >= a - 4;
    cache.set(key, ok);
    return ok;
  };
}

export function buildTrackScene(track) {
  const { n, halfW } = track;
  const fr = trackFrames(track);
  const valid = makeValidator(track);
  const flat = new MeshData();
  const walls = new MeshData();
  const P = (i, o, y) => edgePoint(track, fr, i, o, y);
  const wallReach = halfW + BARRIER;

  const strip = (i, o0, o1, y, color, checkAt = null) => {
    const j = (i + 1) % n;
    if (checkAt !== null && !(valid(fr, i, checkAt) && valid(fr, j, checkAt))) return false;
    flat.quad(P(i, o0, y), P(i, o1, y), P(j, o1, y), P(j, o0, y), color);
    return true;
  };

  const kerbRed = hexLinear(COLORS.kerbRed);
  const kerbWhite = hexLinear(COLORS.kerbWhite);
  const runoffColor = hexLinear(COLORS.runoff);
  const dashColor = hexLinear(COLORS.dash);
  const wallTop = hexLinear(COLORS.wallTop);
  const stats = { asphalt: 0, kerb: 0, runoff: 0, dash: 0, wall: 0 };

  for (let i = 0; i < n; i++) {
    // Asphalt is always drawn. Where two roads overlap they are the same color, so it is seamless.
    const shade = 0.965 + 0.05 * hash(i, 3);
    strip(i, -halfW, halfW, Y.asphalt, hexLinear(COLORS.asphalt, shade));
    stats.asphalt++;

    if (i % 4 < 2 && valid(fr, i, 0) && valid(fr, (i + 1) % n, 0)) {
      strip(i, -DASH_HALF, DASH_HALF, Y.dash, dashColor);
      stats.dash++;
    }

    for (const s of [-1, 1]) {
      const kerbColor = i % 2 === 0 ? kerbRed : kerbWhite;
      if (strip(i, s * halfW, s * (halfW + KERB_W), Y.kerb, kerbColor, s * (halfW + KERB_W))) stats.kerb++;
      if (strip(i, s * (halfW + KERB_W), s * wallReach, Y.runoff, runoffColor, s * wallReach)) stats.runoff++;

      const j = (i + 1) % n;
      if (valid(fr, i, s * wallReach) && valid(fr, j, s * wallReach)) {
        const side = hexLinear(i % 3 === 0 ? COLORS.wallBand : COLORS.wallSide);
        const inner = s * (wallReach - WALL_HALF_T);
        const outer = s * (wallReach + WALL_HALF_T);
        const top = Y.ground + WALL_H;
        walls.quad(P(i, inner, Y.ground), P(i, inner, top), P(j, inner, top), P(j, inner, Y.ground), side);
        walls.quad(P(i, inner, top), P(i, outer, top), P(j, outer, top), P(j, inner, top), wallTop);
        walls.quad(P(i, outer, top), P(i, outer, Y.ground), P(j, outer, Y.ground), P(j, outer, top), side);
        stats.wall++;
      }
    }
  }

  // Orange start line across the road at sample 0, with thin white lines on either side.
  const startColor = hexLinear(COLORS.start);
  const edgeColor = hexLinear(COLORS.startEdge);
  const band = (t0, t1, color) => {
    const c = (o, t) => [
      track.xs[0] + fr.nx[0] * o + fr.tx[0] * t,
      Y.start,
      track.ys[0] + fr.ny[0] * o + fr.ty[0] * t,
    ];
    flat.quad(c(-halfW, t0), c(halfW, t0), c(halfW, t1), c(-halfW, t1), color);
  };
  band(-START_HALF, START_HALF, startColor);
  band(-START_EDGE[1], -START_EDGE[0], edgeColor);
  band(START_EDGE[0], START_EDGE[1], edgeColor);

  return { flat: flat.arrays(), walls: walls.arrays(), stats };
}

// ---- terrain -------------------------------------------------------------

// The ground grid grows with the world (bigger cells keep the triangle count about the same), hills stay clear of
// the road and rise more gently over a longer distance. margin must exceed the camera's fog distance.
export const TERRAIN = {
  cell: 170 * L,
  margin: 3600 * W,
  flatReach: BARRIER + 260 * W,
  rise: 1400 * L,
  amp: 520 * W,
};

function nearestCenterDistance(track, x, z) {
  let best = Infinity;
  for (let j = 0; j < track.n; j++) {
    const d = (track.xs[j] - x) ** 2 + (track.ys[j] - z) ** 2;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

// Ground height at a scene point. Flat around every stretch of road, rolling hills further out.
export function terrainHeight(track, x, z, dist = nearestCenterDistance(track, x, z)) {
  const flat = track.halfW + TERRAIN.flatReach;
  if (dist <= flat) return Y.ground;
  const t = Math.min(1, (dist - flat) / TERRAIN.rise);
  const s = t * t * (3 - 2 * t);
  const noise = Math.min(1, Math.max(0.05,
    0.5 + 0.3 * Math.sin(x * 0.0021 + 0.8) * Math.cos(z * 0.0017 + 2.1) + 0.2 * Math.sin((x + z) * 0.0043)));
  return Y.ground + s * (80 + TERRAIN.amp * noise);
}

export function buildTerrain(track) {
  const { cell, margin } = TERRAIN;
  const x0 = -margin;
  const z0 = -margin;
  const nx = Math.ceil((track.bbox.w + margin * 2) / cell);
  const nz = Math.ceil((track.bbox.h + margin * 2) / cell);
  const h = new Float32Array((nx + 1) * (nz + 1));
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) h[j * (nx + 1) + i] = terrainHeight(track, x0 + i * cell, z0 + j * cell);
  }

  const low = hexLinear(COLORS.groundLow);
  const mid = hexLinear(COLORS.groundMid);
  const high = hexLinear(COLORS.groundHigh);
  const mesh = new MeshData();
  const V = (i, j) => [x0 + i * cell, h[j * (nx + 1) + i], z0 + j * cell];
  const paint = (a, b, c, salt) => {
    const t = Math.min(1, Math.max(0, ((a[1] + b[1] + c[1]) / 3 - Y.ground) / (650 * W)));
    const base = t < 0.5 ? low.map((v, k) => v + (mid[k] - v) * (t * 2)) : mid.map((v, k) => v + (high[k] - v) * ((t - 0.5) * 2));
    const shade = 0.86 + 0.26 * hash(a[0] + salt, a[2]);
    return base.map((v) => v * shade);
  };
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = V(i, j);
      const b = V(i + 1, j);
      const c = V(i + 1, j + 1);
      const d = V(i, j + 1);
      if ((i + j) % 2 === 0) {
        mesh.tri(a, d, b, paint(a, d, b, 1));
        mesh.tri(b, d, c, paint(b, d, c, 2));
      } else {
        mesh.tri(a, d, c, paint(a, d, c, 3));
        mesh.tri(a, c, b, paint(a, c, b, 4));
      }
    }
  }
  return mesh.arrays();
}

// Deterministic tree spots beside the track. They give the eye something to fly past.
// The default count grows with the area of the tree belt (lap length x belt width) so the density stays the same.
export function buildTrees(track, count = Math.round(420 * L * W)) {
  const out = [];
  const inner = track.halfW + BARRIER + 45 * W;
  const outer = inner + 650 * W;
  const { bbox } = track;
  const pad = 300 * W;
  for (let k = 0; out.length < count && k < count * 30; k++) {
    const x = -pad + hash(k, 1) * (bbox.w + pad * 2);
    const z = -pad + hash(k, 2) * (bbox.h + pad * 2);
    const d = nearestCenterDistance(track, x, z);
    if (d < inner || d > outer) continue;
    out.push({
      x,
      z,
      y: terrainHeight(track, x, z, d),
      scale: 0.8 + 0.7 * hash(k, 3),
      tone: hash(k, 4),
    });
  }
  return out;
}

// 2D pose -> scene pose. Used by the renderer and covered by a test.
export function toScene(x, y, a) {
  return { x, z: y, rotY: -a };
}
