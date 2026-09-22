// Canvas drawing: track, cars, minimap. Flat, slightly cartoonish, easy to read.

import { BARRIER, KERB_W, SPACING } from '/shared/track-geom.js';
import { CAR } from '/shared/physics.js';
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

let grassPattern = null;
export function grassFor(ctx) {
  if (grassPattern) return grassPattern;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#2c6a3b';
  g.fillRect(0, 0, 128, 128);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 90; i++) {
    g.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.07)';
    g.beginPath();
    g.arc(rnd() * 128, rnd() * 128, 2 + rnd() * 5, 0, Math.PI * 2);
    g.fill();
  }
  grassPattern = ctx.createPattern(c, 'repeat');
  return grassPattern;
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

export function drawWorld(ctx, track, view) {
  ctx.fillStyle = grassFor(ctx);
  ctx.fillRect(view.x0, view.y0, view.x1 - view.x0, view.y1 - view.y0);
  drawTrackLayers(ctx, track);
}

const shade = (hex, f) => {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
};

// Top-down open-wheel car facing +x, roughly CAR.length long.
export function drawCar(ctx, x, y, a, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);
  const dark = '#16181c';

  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.ellipse(2, 3, CAR.length * 0.5, CAR.width * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();

  // Tyres
  ctx.fillStyle = dark;
  for (const s of [-1, 1]) {
    ctx.fillRect(-23, s * 12 - 4.5, 17, 9);   // rear
    ctx.fillRect(9, s * 11.5 - 4, 15, 8);     // front
  }
  // Rear wing and front wing
  ctx.fillStyle = shade(color, 0.55);
  ctx.fillRect(-29, -12, 7, 24);
  ctx.fillStyle = '#f2f2f2';
  ctx.fillRect(-27, -12, 2, 24);
  ctx.fillStyle = shade(color, 0.55);
  ctx.fillRect(22, -13, 7, 26);

  // Body: nose, sidepods, engine cover
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(30, 0);
  ctx.lineTo(22, -2.5);
  ctx.lineTo(8, -5);
  ctx.lineTo(2, -9);
  ctx.lineTo(-10, -9);
  ctx.lineTo(-20, -5);
  ctx.lineTo(-25, -3);
  ctx.lineTo(-25, 3);
  ctx.lineTo(-20, 5);
  ctx.lineTo(-10, 9);
  ctx.lineTo(2, 9);
  ctx.lineTo(8, 5);
  ctx.lineTo(22, 2.5);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillRect(-22, -1.2, 26, 2.4);

  // Driver helmet
  ctx.fillStyle = '#f7f7f7';
  ctx.beginPath();
  ctx.arc(-2, 0, 4.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = dark;
  ctx.fillRect(-1, -3.2, 2.6, 6.4);
  ctx.restore();
}

export function drawLabel(ctx, text, x, y, color, strong = false, size = 15) {
  ctx.font = `${strong ? 'bold ' : ''}${size}px system-ui, "Malgun Gothic", sans-serif`;
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';
  ctx.lineWidth = size * 0.28;
  ctx.strokeStyle = 'rgba(0,0,0,0.65)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = strong ? '#ffffff' : color;
  ctx.fillText(text, x, y);
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
