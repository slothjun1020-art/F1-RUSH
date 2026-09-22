// Pure logic for smoothing other players' cars over an unreliable link (a Cloudflare tunnel's delay
// is far less steady than a LAN's). No DOM or Three.js here, so it can be unit-tested directly.
//
// Three problems, three pieces:
//  1. Jitter tracker: how far behind the server clock should we render remote cars? Too little and a
//     late packet makes them stutter; too much and they feel laggy. This watches how irregularly
//     snapshots actually arrive and grows or shrinks the delay to match, smoothly.
//  2. remotePoseAt: given a small buffer of recent (time, x, y, a, v) samples, find the position at an
//     arbitrary render time by interpolating between two samples, or by extrapolating a short distance
//     past the last one (capped, so a long stall doesn't send the car flying off the track).
//  3. smoothRemote: remotePoseAt's output can still jump — a stall followed by a burst of packets moves
//     the "true" position a long way between two frames. This turns that jump into a brief, smooth
//     catch-up instead of a teleport, while leaving normal small, already-smooth motion untouched.

const norm = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---- 1. adaptive interpolation delay --------------------------------------------------------------

export const JITTER = {
  alpha: 0.15,       // EMA weight for each new arrival gap (RFC 3550-style jitter estimate)
  base: 70,          // ms floor: about two snapshots at 30 Hz, so there is always something to interpolate between
  min: 60,
  max: 350,           // ms ceiling: even wild jitter never delays remote cars by more than this
  kJitter: 5,         // how many ms of buffer one ms of measured jitter buys
  followPerMs: 0.002, // how fast the *rendered* delay chases its target (bigger = catches up faster)
};

export function createJitterTracker() {
  return {
    lastArrival: null, emaGap: null, emaDev: 0, target: JITTER.base, delay: JITTER.base,
  };
}

// Call once per snapshot received from the server, with a local monotonic timestamp (performance.now()).
export function recordArrival(tr, nowMs) {
  if (tr.lastArrival != null) {
    const gap = nowMs - tr.lastArrival;
    tr.emaGap = tr.emaGap == null ? gap : tr.emaGap + (gap - tr.emaGap) * JITTER.alpha;
    const dev = Math.abs(gap - tr.emaGap);
    tr.emaDev += (dev - tr.emaDev) * JITTER.alpha;
  }
  tr.lastArrival = nowMs;
  tr.target = clamp(JITTER.base + tr.emaDev * JITTER.kJitter, JITTER.min, JITTER.max);
}

// Call once per rendered frame to ease the delay actually used towards the current target, so the
// buffer visibly "grows" when the link degrades and "shrinks" again once it settles, never in a jump.
export function stepJitterTracker(tr, dtMs) {
  const rate = 1 - Math.exp(-Math.max(0, dtMs) * JITTER.followPerMs);
  tr.delay += (tr.target - tr.delay) * rate;
  return tr.delay;
}

// ---- 2. interpolation with capped extrapolation ---------------------------------------------------

export const EXTRAPOLATE_CAP_MS = 150; // how far past the last known sample we'll coast on its heading/speed

// buf: array of { st, x, y, a, v } ordered by st (server time, ms), oldest first.
export function remotePoseAt(buf, renderT) {
  if (!buf.length) return null;
  const first = buf[0];
  if (renderT <= first.st) return { x: first.x, y: first.y, a: first.a, v: first.v };
  const last = buf[buf.length - 1];
  if (renderT >= last.st) {
    const ahead = Math.min(renderT - last.st, EXTRAPOLATE_CAP_MS) / 1000;
    return {
      x: last.x + Math.cos(last.a) * last.v * ahead,
      y: last.y + Math.sin(last.a) * last.v * ahead,
      a: last.a,
      v: last.v,
    };
  }
  for (let i = buf.length - 2; i >= 0; i--) {
    if (buf[i].st <= renderT) {
      const p = buf[i];
      const q = buf[i + 1];
      const u = (renderT - p.st) / (q.st - p.st || 1);
      return {
        x: p.x + (q.x - p.x) * u,
        y: p.y + (q.y - p.y) * u,
        a: p.a + norm(q.a - p.a) * u,
        v: p.v + (q.v - p.v) * u,
      };
    }
  }
  return { x: first.x, y: first.y, a: first.a, v: first.v };
}

// ---- 3. jump smoothing ------------------------------------------------------------------------------

export const SMOOTH = {
  jumpFactor: 3,   // a step bigger than this many times the plausible per-frame travel counts as a jump
  minJump: 4,      // world units: a floor on the above, so tiny plausible-step estimates don't overreact
  tau: 0.12,       // seconds: time constant for catching up after a jump (smaller = snappier, more visible)
};

export function createRemoteSmoother(x, y, a) {
  return { x, y, a };
}

// Moves `state` towards `target`. Ordinary small movements (already smooth, from interpolation) pass
// straight through with no added lag; a jump (a stall resolving, or the very first sample) is eased in
// over a few frames instead of snapping, so the car never visibly teleports.
export function smoothRemote(state, target, dt, plausibleStep) {
  if (!state) return { x: target.x, y: target.y, a: target.a };
  const dx = target.x - state.x;
  const dy = target.y - state.y;
  const dist = Math.hypot(dx, dy);
  const jumpLimit = Math.max(plausibleStep * SMOOTH.jumpFactor, SMOOTH.minJump);
  if (dist > jumpLimit) {
    const rate = 1 - Math.exp(-dt / SMOOTH.tau);
    state.x += dx * rate;
    state.y += dy * rate;
    state.a += norm(target.a - state.a) * rate;
  } else {
    state.x = target.x;
    state.y = target.y;
    state.a = target.a;
  }
  return state;
}
