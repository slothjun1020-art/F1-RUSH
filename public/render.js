// Canvas drawing shared by the minimap, the lobby's track-choice cards and /preview.html — the game
// itself is 3D-only (public/view3d.js); this file just draws a flat outline of a track, not a race.

import { BARRIER, KERB_W, SPACING } from '/shared/track-geom.js';
import { SCALE } from '/shared/scale.js';

const K = SCALE.width; // road furniture (line widths, dash lengths, start-line squares) follows the road width

const pathCache = new WeakMap();

export function trackPath(track) {
  let p = pathCache.get(track);
  if (!p) {
    p = new Path2D();
    p.moveTo(track.xs[0], track.ys[0]);
    for (let i = 1; i < track.n; i++) p.lineTo(track.xs[i], track.ys[i]);
    p.closePath();
    pathCache.set(track, p);
  }
  return p;
}

// Wall, runoff, kerbs, asphalt, center line, start line. Coordinates are world units.
export function drawTrackLayers(ctx, track, { detail = true } = {}) {
  const path = trackPath(track);
  const W = track.width;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'butt';
  ctx.setLineDash([]);

  ctx.strokeStyle = '#dfe3ea';
  ctx.lineWidth = W + 2 * (BARRIER + 12 * K);
  ctx.stroke(path);

  ctx.strokeStyle = '#3a8a47';
  ctx.lineWidth = W + 2 * BARRIER;
  ctx.stroke(path);

  ctx.strokeStyle = '#d63a2f';
  ctx.lineWidth = W + 2 * KERB_W;
  ctx.stroke(path);
  ctx.strokeStyle = '#f4f4f4';
  ctx.setLineDash([SPACING, SPACING]); // same stripe length as the 3D kerbs
  ctx.stroke(path);
  ctx.setLineDash([]);

  ctx.strokeStyle = '#484d56';
  ctx.lineWidth = W;
  ctx.stroke(path);

  if (detail) {
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 3 * K;
    ctx.setLineDash([26 * K, 40 * K]);
    ctx.stroke(path);
    ctx.setLineDash([]);
  }

  // Checkered start/finish line at sample 0.
  const { x, y, a } = track.start;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);
  const cell = 15 * K;
  const rows = Math.ceil(W / cell);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < 2; c++) {
      ctx.fillStyle = (r + c) % 2 === 0 ? '#f4f4f4' : '#15171a';
      ctx.fillRect(-cell + c * cell, -W / 2 + r * cell, cell, Math.min(cell, W / 2 - (-W / 2 + r * cell)));
    }
  }
  ctx.restore();
}

// Fit the whole circuit into a w x h box. Returns the mapping so callers can plot cars on top.
export function drawTrackFit(ctx, track, w, h, { full = false, color = '#ffffff', margin = 8 } = {}) {
  const sc = Math.min((w - margin * 2) / track.bbox.w, (h - margin * 2) / track.bbox.h);
  const tx = (w - track.bbox.w * sc) / 2;
  const ty = (h - track.bbox.h * sc) / 2;
  ctx.save();
  ctx.translate(tx, ty);
  ctx.scale(sc, sc);
  if (full) {
    ctx.fillStyle = '#2c6a3b';
    ctx.fillRect(0, 0, track.bbox.w, track.bbox.h);
    drawTrackLayers(ctx, track, { detail: false });
  } else {
    const path = trackPath(track);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = track.width * 1.9;
    ctx.stroke(path);
    ctx.strokeStyle = color;
    ctx.lineWidth = track.width * 1.25;
    ctx.stroke(path);
    const { x, y, a } = track.start;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.fillStyle = '#fff';
    ctx.fillRect(-track.width * 0.25, -track.width * 1.1, track.width * 0.5, track.width * 2.2);
    ctx.restore();
  }
  ctx.restore();
  return { sc, tx, ty };
}
