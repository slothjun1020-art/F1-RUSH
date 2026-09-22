// Lap progress tracking. The same code runs in the browser (for the HUD) and on the server (for the
// official result), so both agree on when a lap is complete.
//
// Progress is a running total of distance along the centerline. It is only ever advanced by looking at
// the track near the previous position, so cutting across grass to a far-away part of the circuit
// (or driving backwards) can't create progress. The start/finish line is at total = 0; cars are gridded
// behind it at negative totals.

import { locate, pointAt } from './track-geom.js';

const mod = (a, n) => ((a % n) + n) % n;

export function createProgress(track, gridS) {
  const s = mod(gridS, track.L);
  return {
    sPrev: s,
    seg: Math.floor(s / track.spacing) % track.n,
    total: gridS < 0 ? gridS : s > track.L / 2 ? s - track.L : s,
  };
}

// Returns the distance the car actually advanced this update (signed).
// maxAdvance (optional) caps forward progress per update; the server uses it against bogus reports.
export function advanceProgress(track, prog, x, y, opts = {}) {
  const { win = 14, maxAdvance = Infinity } = opts;
  const loc = locate(track, x, y, prog.seg, win);
  let ds = loc.s - prog.sPrev;
  if (ds > track.L / 2) ds -= track.L;
  else if (ds < -track.L / 2) ds += track.L;
  if (ds > maxAdvance) ds = maxAdvance;
  prog.sPrev = mod(prog.sPrev + ds, track.L);
  prog.seg = Math.floor(prog.sPrev / track.spacing) % track.n;
  prog.total += ds;
  return { ds, dist: loc.dist };
}

export function lapsCompleted(track, prog) {
  return Math.max(0, Math.floor(prog.total / track.L));
}

// Starting grid slot i (0 = pole): two columns, staggered rows behind the line.
export function gridSlot(track, i) {
  const row = Math.floor(i / 2);
  const s = -(60 + row * 64) - (i % 2) * 28;
  const lateral = (i % 2 === 0 ? -1 : 1) * track.width * 0.2;
  const p = pointAt(track, s);
  const nx = -Math.sin(p.a);
  const ny = Math.cos(p.a);
  return { s, x: p.x + nx * lateral, y: p.y + ny * lateral, a: p.a };
}
