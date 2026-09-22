// Turns a hand-authored track outline into a uniformly sampled closed centerline,
// and answers "where is this point relative to the track?" queries.

import { SCALE } from './scale.js';

// Sample spacing grows with the lap length so every track keeps the same number of samples (and the
// same +-14 sample search windows cover the same fraction of the lap). Barrier and kerb follow the road width.
export const SPACING = 24 * SCALE.length;   // target distance between centerline samples (world units)
export const BARRIER = 80 * SCALE.width;    // distance from the track edge to the outer wall
export const KERB_W = 13 * SCALE.width;     // width of the red/white kerb on each side of the asphalt

const mod = (a, n) => ((a % n) + n) % n;

// Centripetal Catmull-Rom (Barry-Goldman). Stays well-behaved on unevenly spaced points.
function crPoint(p0, p1, p2, p3, u) {
  const d = (a, b) => Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]) ** 0.5, 1e-4);
  const t0 = 0;
  const t1 = t0 + d(p0, p1);
  const t2 = t1 + d(p1, p2);
  const t3 = t2 + d(p2, p3);
  const t = t1 + (t2 - t1) * u;
  const lerp = (a, b, ta, tb) => {
    const w = (t - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
  };
  const a1 = lerp(p0, p1, t0, t1);
  const a2 = lerp(p1, p2, t1, t2);
  const a3 = lerp(p2, p3, t2, t3);
  const b1 = lerp(a1, a2, t0, t2);
  const b2 = lerp(a2, a3, t1, t3);
  return lerp(b1, b2, t1, t2);
}

function splineLoop(points, steps = 24) {
  const n = points.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    for (let k = 0; k < steps; k++) out.push(crPoint(p0, p1, p2, p3, k / steps));
  }
  return out;
}

// Straight segments joined by rounded corners (used for angular street/park circuits).
function roundedLoop(corners, radius) {
  const n = corners.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = corners[(i - 1 + n) % n];
    const cur = corners[i];
    const next = corners[(i + 1) % n];
    const lin = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    const lout = Math.hypot(next[0] - cur[0], next[1] - cur[1]);
    const cut = Math.min(radius, lin / 2, lout / 2);
    const a = [cur[0] + ((prev[0] - cur[0]) / lin) * cut, cur[1] + ((prev[1] - cur[1]) / lin) * cut];
    const b = [cur[0] + ((next[0] - cur[0]) / lout) * cut, cur[1] + ((next[1] - cur[1]) / lout) * cut];
    const steps = 10;
    for (let k = 0; k <= steps; k++) {
      const u = k / steps;
      const w0 = (1 - u) * (1 - u);
      const w1 = 2 * (1 - u) * u;
      const w2 = u * u;
      out.push([w0 * a[0] + w1 * cur[0] + w2 * b[0], w0 * a[1] + w1 * cur[1] + w2 * b[1]]);
    }
  }
  return out;
}

function polylineLength(pts) {
  let len = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    len += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return len;
}

// Resample a closed polyline into n points that are evenly spaced along its length.
function resample(pts, n) {
  const m = pts.length;
  const cum = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % m];
    cum[i + 1] = cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const total = cum[m];
  const out = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const target = (i / n) * total;
    while (j < m - 1 && cum[j + 1] < target) j++;
    const seg = cum[j + 1] - cum[j] || 1;
    const u = (target - cum[j]) / seg;
    const a = pts[j];
    const b = pts[(j + 1) % m];
    out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
  }
  return out;
}

export function buildTrack(def) {
  const raw = def.mode === 'poly' ? roundedLoop(def.points, def.radius ?? 40) : splineLoop(def.points);
  const k = def.lapLength / polylineLength(raw);
  const n = Math.max(64, Math.round(def.lapLength / SPACING));
  const sampled = resample(raw, n).map(([x, y]) => [x * k, y * k]);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of sampled) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  // Shift so the centerline bounding box starts at a fixed margin from the origin.
  const pad = def.width / 2 + BARRIER + 60 * SCALE.width;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = sampled[i][0] - minX + pad;
    ys[i] = sampled[i][1] - minY + pad;
  }
  const L = polylineLength(sampled);
  const spacing = L / n;
  const angs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    angs[i] = Math.atan2(ys[j] - ys[i], xs[j] - xs[i]);
  }

  return {
    id: def.id,
    name: def.name,
    en: def.en,
    country: def.country,
    width: def.width,
    halfW: def.width / 2,
    n,
    L,
    spacing,
    xs,
    ys,
    angs,
    bbox: { w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 },
    // Start/finish line sits at sample 0.
    start: { x: xs[0], y: ys[0], a: angs[0] },
  };
}

// Position and heading at arc-length s (wraps around the lap).
export function pointAt(track, s) {
  const ss = mod(s, track.L);
  const f = ss / track.spacing;
  const i = Math.floor(f) % track.n;
  const u = f - Math.floor(f);
  const j = (i + 1) % track.n;
  return {
    x: track.xs[i] + (track.xs[j] - track.xs[i]) * u,
    y: track.ys[i] + (track.ys[j] - track.ys[i]) * u,
    a: track.angs[i],
  };
}

// Nearest point on the centerline. With a hint it only searches +-win samples around it, which keeps
// the answer on the correct stretch where the track crosses itself (Suzuka) or folds back (hairpins).
export function locate(track, x, y, hint = null, win = 14) {
  const { n, xs, ys } = track;
  let best = Infinity;
  let bi = 0;
  let bt = 0;
  let bx = 0;
  let by = 0;
  const count = hint == null ? n : Math.min(n, win * 2 + 1);
  for (let c = 0; c < count; c++) {
    const i = hint == null ? c : mod(hint - win + c, n);
    const j = i + 1 === n ? 0 : i + 1;
    const ax = xs[i];
    const ay = ys[i];
    const dx = xs[j] - ax;
    const dy = ys[j] - ay;
    let t = ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + dx * t;
    const py = ay + dy * t;
    const d2 = (x - px) * (x - px) + (y - py) * (y - py);
    if (d2 < best) {
      best = d2;
      bi = i;
      bt = t;
      bx = px;
      by = py;
    }
  }
  return { seg: bi, t: bt, dist: Math.sqrt(best), s: (bi + bt) * track.spacing, px: bx, py: by };
}
