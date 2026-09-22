import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JITTER, SMOOTH, EXTRAPOLATE_CAP_MS,
  createJitterTracker, recordArrival, stepJitterTracker,
  remotePoseAt, createRemoteSmoother, smoothRemote,
} from '../public/interp.js';

// ---- adaptive interpolation delay ---------------------------------------------------------------

test('a steady stream of arrivals settles near the minimum delay', () => {
  const tr = createJitterTracker();
  let t = 0;
  for (let i = 0; i < 60; i++) { t += 33; recordArrival(tr, t); }
  assert.ok(tr.target < JITTER.base + 15, `target ${tr.target.toFixed(0)}ms should stay near the floor when arrivals are regular`);
});

test('irregular arrivals grow the delay target, up to the clamp', () => {
  const tr = createJitterTracker();
  let t = 0;
  for (let i = 0; i < 80; i++) { t += i % 2 === 0 ? 10 : 400; recordArrival(tr, t); } // wildly bursty
  assert.ok(tr.target > JITTER.base + 40, `target only grew to ${tr.target.toFixed(0)}ms`);
  assert.ok(tr.target <= JITTER.max, 'never exceeds the ceiling');
});

test('the delay actually used chases its target gradually, not in one jump', () => {
  const tr = createJitterTracker();
  tr.target = 300; // pretend jitter just spiked
  const after1 = stepJitterTracker(tr, 16);
  assert.ok(after1 > JITTER.base && after1 < 300, `one 16ms frame moved it to ${after1.toFixed(1)}, should be partway`);
  let last = after1;
  for (let i = 0; i < 200; i++) last = stepJitterTracker(tr, 16);
  assert.ok(Math.abs(last - 300) < 1, 'given enough frames it converges on the target');
});

test('delay shrinks back down again once arrivals settle', () => {
  const tr = createJitterTracker();
  tr.target = 300;
  tr.delay = 300;
  for (let i = 0; i < 30; i++) recordArrival(tr, i * 33); // perfectly regular from here on
  assert.ok(tr.target < 150, `target should have relaxed toward the floor, got ${tr.target.toFixed(0)}`);
  let delay = tr.delay;
  for (let i = 0; i < 300; i++) delay = stepJitterTracker(tr, 16);
  assert.ok(delay < 150, `used delay should follow the target back down, got ${delay.toFixed(0)}`);
});

// ---- interpolation + capped extrapolation -------------------------------------------------------

test('an empty buffer has no pose', () => {
  assert.equal(remotePoseAt([], 1000), null);
});

test('before the first sample, the first sample is shown as-is', () => {
  const buf = [{ st: 1000, x: 10, y: 20, a: 0, v: 50 }];
  assert.deepEqual(remotePoseAt(buf, 500), { x: 10, y: 20, a: 0, v: 50 });
});

test('between two samples, position and heading are linearly interpolated', () => {
  const buf = [
    { st: 1000, x: 0, y: 0, a: 0, v: 100 },
    { st: 1100, x: 100, y: 0, a: Math.PI / 2, v: 200 },
  ];
  const mid = remotePoseAt(buf, 1050);
  assert.ok(Math.abs(mid.x - 50) < 1e-9);
  assert.ok(Math.abs(mid.a - Math.PI / 4) < 1e-9);
  assert.ok(Math.abs(mid.v - 150) < 1e-9);
});

test('heading interpolation takes the short way around the wrap from +pi to -pi', () => {
  const buf = [
    { st: 0, x: 0, y: 0, a: 3.0, v: 0 },
    { st: 100, x: 0, y: 0, a: -3.0, v: 0 },
  ];
  const mid = remotePoseAt(buf, 50);
  assert.ok(Math.abs(mid.a) > 3.0, `should wrap through pi, got ${mid.a}`); // not straight through 0
});

test('past the last sample, position extrapolates along its last heading and speed', () => {
  const buf = [{ st: 1000, x: 0, y: 0, a: 0, v: 300 }]; // moving at 300 units/s along +x
  const pose = remotePoseAt(buf, 1050); // 50ms later
  assert.ok(Math.abs(pose.x - 15) < 1e-6, `expected 0.3 * (50/1000) = 15, got ${pose.x}`);
  assert.equal(pose.y, 0);
});

test('extrapolation is capped, so a long stall does not send the car flying', () => {
  const buf = [{ st: 1000, x: 0, y: 0, a: 0, v: 300 }];
  const atCap = remotePoseAt(buf, 1000 + EXTRAPOLATE_CAP_MS);
  const wayLater = remotePoseAt(buf, 1000 + EXTRAPOLATE_CAP_MS + 5000); // a five second stall
  assert.equal(atCap.x, wayLater.x, 'extrapolated distance stops growing past the cap');
});

// ---- jump smoothing -------------------------------------------------------------------------------

test('with no prior state, the target is used directly', () => {
  assert.deepEqual(smoothRemote(null, { x: 5, y: 6, a: 1 }, 1 / 60, 10), { x: 5, y: 6, a: 1 });
});

test('small, plausible movement passes straight through with no added lag', () => {
  const state = createRemoteSmoother(0, 0, 0);
  const target = { x: 2, y: 0, a: 0 }; // well under the jump threshold for a 40 unit/frame plausible step
  const shown = smoothRemote(state, target, 1 / 60, 40);
  assert.deepEqual(shown, { x: 2, y: 0, a: 0 });
});

test('a big jump (a stall resolving) is eased in, not snapped to instantly', () => {
  const state = createRemoteSmoother(0, 0, 0);
  const target = { x: 1000, y: 0, a: 0 }; // far beyond anything plausible in one frame
  const dt = 1 / 60;
  const first = smoothRemote(state, target, dt, 20);
  assert.ok(first.x > 0 && first.x < 1000, `first frame should move partway, got ${first.x.toFixed(1)}`);
  assert.ok(first.x < 1000 * 0.5, 'and not overshoot straight to the middle or beyond in a single 16ms frame');
});

test('after a jump, the position keeps closing the gap every frame and settles near the target', () => {
  const state = createRemoteSmoother(0, 0, 0);
  const target = { x: 500, y: 300, a: Math.PI / 2 };
  const dt = 1 / 60;
  let prevDist = Infinity;
  for (let i = 0; i < 90; i++) { // 1.5s, i.e. about 12 time constants (SMOOTH.tau = 0.12s)
    smoothRemote(state, target, dt, 20);
    const dist = Math.hypot(target.x - state.x, target.y - state.y);
    assert.ok(dist <= prevDist + 1e-9, `distance to target should never grow (frame ${i})`);
    prevDist = dist;
  }
  assert.ok(prevDist < 1, `should have converged, still ${prevDist.toFixed(2)} away`);
  assert.ok(Math.abs(state.a - target.a) < 0.01, 'heading also converges');
});

test('a fast car gets a proportionally larger "plausible step" so normal driving never looks like a jump', () => {
  const state = createRemoteSmoother(0, 0, 0);
  // At 800 units/s and a 1/60s frame, a car can plausibly move ~13.3 units - smaller than SMOOTH.minJump
  // on its own, so the caller-supplied plausibleStep (not the floor) must be what lets this through.
  const dt = 1 / 60;
  const plausibleStep = 800 * dt;
  const target = { x: plausibleStep * 2, y: 0, a: 0 }; // 2 frames' worth of travel, still normal driving
  const shown = smoothRemote(state, target, dt, plausibleStep);
  assert.deepEqual(shown, target, 'ordinary fast movement is not treated as a jump');
});
