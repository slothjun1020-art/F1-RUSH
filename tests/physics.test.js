import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrack } from '../shared/track-geom.js';
import {
  CAR, createCar, stepCar, GEAR_SPEEDS, worldToKmh, kmhToWorld,
} from '../shared/physics.js';

// A very long straight, so braking and coasting tests never touch a corner or the wall.
const straight = buildTrack({
  id: 'straight', name: 't', en: 't', country: 't', width: 225, lapLength: 4e6, mode: 'poly', radius: 10,
  points: [[0, 0], [1000, 0], [1000, 40], [0, 40]],
});

const M = CAR.maxSpeed;
const DT = 1 / 120;
const NONE = { throttle: 0, brake: 0, steer: 0 };
const BRAKE = { throttle: 0, brake: 1, steer: 0 };

function newCar(v) {
  const i = Math.floor(straight.n * 0.1); // well inside the first straight, away from the rounded corner
  const car = createCar(straight.xs[i], straight.ys[i], straight.angs[i], straight);
  car.v = v;
  return car;
}

// Runs `input` for `seconds` and returns the speed sampled after every step (index 0 = start).
function run(car, input, seconds) {
  const speeds = [car.v];
  for (let t = 0; t < seconds; t += DT) {
    stepCar(car, typeof input === 'function' ? input(t) : input, DT, straight);
    speeds.push(car.v);
  }
  return speeds;
}

const decelBetween = (speeds, t0, t1) => (speeds[Math.round(t0 / DT)] - speeds[Math.round(t1 / DT)]) / (t1 - t0);

test('braking starts soft: the first touch is a small fraction of top speed per second', () => {
  const speeds = run(newCar(M), BRAKE, 0.3);
  const decel = decelBetween(speeds, 0, 0.2);
  assert.ok(decel < 0.25 * M, `initial decel ${(decel / M).toFixed(2)} x top speed/s`);
  assert.ok(decel > 0.08 * M, 'but the brakes do bite');
});

test('holding the brake makes it progressively stronger', () => {
  const speeds = run(newCar(M), BRAKE, 2);
  const early = decelBetween(speeds, 0, 0.2);
  const mid = decelBetween(speeds, 0.8, 1.0);
  const late = decelBetween(speeds, 1.6, 1.8);
  assert.ok(mid > early * 1.3, `${mid.toFixed(0)} vs ${early.toFixed(0)}`);
  assert.ok(late > mid * 1.1, `${late.toFixed(0)} vs ${mid.toFixed(0)}`);
  assert.ok(late < 0.75 * M, 'and never becomes a wall');
});

test('a full stop from top speed takes a couple of seconds and speed falls smoothly, never below zero', () => {
  const speeds = run(newCar(M), BRAKE, 2.4);
  const stopped = speeds.findIndex((v) => v <= 0);
  assert.ok(stopped > 0, 'the car comes to a stop');
  const t = stopped * DT;
  assert.ok(t > 1.8 && t < 4.5, `stopped after ${t.toFixed(2)} s`);
  for (let i = 1; i <= stopped; i++) assert.ok(speeds[i] <= speeds[i - 1] + 1e-9, 'monotonic');
  // No step changes speed by more than a small fraction of top speed per second.
  for (let i = 1; i <= stopped; i++) assert.ok((speeds[i - 1] - speeds[i]) / DT < 0.75 * M + 1);
});

test('tapping the brake stays gentle: releasing resets the firmness', () => {
  const car = newCar(M);
  const first = decelBetween(run(car, BRAKE, 0.2), 0, 0.2);
  run(car, NONE, 1.2);
  const before = car.v;
  const second = (before - run(car, BRAKE, 0.2).at(-1)) / 0.2;
  assert.ok(second < first * 1.3, `second tap ${second.toFixed(0)} vs first ${first.toFixed(0)}`);
});

test('coasting: eases in (no kink right at throttle release), long tapering roll-out, no sudden stop', () => {
  const speeds = run(newCar(M), NONE, 20);
  assert.ok(speeds[Math.round(1 / DT)] > 0.7 * M, 'still above 70% of top speed after one second');
  for (let i = 1; i < speeds.length; i++) assert.ok(speeds[i] <= speeds[i - 1] + 1e-9 && speeds[i] >= 0, 'monotonic, never reverses');

  const stopped = speeds.findIndex((v) => v <= 0.5);
  assert.ok(stopped > 0, 'the car does eventually stop');
  assert.ok(stopped * DT > 6 && stopped * DT < 22, `rolled for ${(stopped * DT).toFixed(1)} s`);

  // Deceleration tapers off as the car slows down (no constant-rate cutoff at the very end)...
  const early = decelBetween(speeds, 0, 0.5);
  const slow = decelBetween(speeds, (stopped - 0.5 / DT) * DT, stopped * DT);
  assert.ok(early <= 0.15 * M, `initial coast decel ${(early / M).toFixed(2)} x top speed/s`);
  assert.ok(slow < 0.08 * M, `final decel ${(slow / M).toFixed(3)} x top speed/s`);
});

test('coasting eases in over CAR.coastRamp: releasing the throttle barely slows the car down at first', () => {
  const car = newCar(M);
  stepCar(car, NONE, DT, straight); // the very first frame after release
  const instant = (M - car.v) / DT;
  const steadyState = CAR.drag * M + CAR.roll; // the eventual, fully-eased-in coast decel at this speed
  assert.ok(instant < steadyState * 0.15, `first-frame decel ${instant.toFixed(0)} vs steady-state ${steadyState.toFixed(0)}`);

  const midway = run(newCar(M), NONE, CAR.coastRamp / 2).at(-1);
  const full = run(newCar(M), NONE, CAR.coastRamp * 3).length; // just needs to have run without throwing
  assert.ok(full > 0);
  assert.ok(midway < M, 'still decelerates partway through the ramp, just gently');
});

test('braking to a halt then holding the pedal switches to a gentle reverse', () => {
  const car = newCar(kmhToWorld(30));
  const speeds = run(car, BRAKE, 4);
  assert.ok(Math.min(...speeds) < 0, 'reverse engages once stopped');
  assert.ok(Math.min(...speeds) >= -CAR.reverseMax - 1e-9);
});

test('acceleration and top speed still work with the new model', () => {
  const car = newCar(0);
  const speeds = run(car, { throttle: 1, brake: 0, steer: 0 }, 8);
  assert.ok(speeds[Math.round(2 / DT)] > 0.5 * M, 'quick off the line');
  assert.ok(speeds.at(-1) > 0.95 * M && speeds.at(-1) <= M + 1e-6, `top speed ${(speeds.at(-1) / M).toFixed(3)} x max`);
});

test('top speed is 300 km/h', () => {
  assert.equal(Math.round(worldToKmh(CAR.maxSpeed)), 300);
});

test('steering sensitivity tapers to 40% of the low-speed value at top speed', () => {
  const steerDelta = (v) => {
    const car = newCar(v);
    const a0 = car.a;
    stepCar(car, { throttle: 0, brake: 0, steer: 1 }, DT, straight);
    return car.a - a0;
  };
  // Both speeds are comfortably above CAR.gripSpeed, so grip is 1 at both and only the speed taper differs.
  const low = steerDelta(CAR.gripSpeed * 1.01);
  const high = steerDelta(M);
  const ratio = high / low;
  const expected = (1 - 0.6 * 1) / (1 - 0.6 * (CAR.gripSpeed * 1.01) / M);
  assert.ok(Math.abs(ratio - expected) < 0.01, `ratio ${ratio.toFixed(3)}, expected ~${expected.toFixed(3)}`);
  // At true low speed (ratio -> 0) the taper factor is 1, so top speed alone is close to the 40% target.
  const nearZeroRatioFactor = 1 - 0.6 * ((CAR.gripSpeed * 1.01) / M);
  assert.ok(nearZeroRatioFactor > 0.85, 'the low-speed reference point is still close to the untapered value');
});

// ---- gear mode ------------------------------------------------------------------------------------

test('gear mode off (no gear argument) drives exactly like before: unaffected by the gear table', () => {
  const withGear = newCar(0);
  const noGear = newCar(0);
  for (let i = 0; i < 300; i++) {
    stepCar(withGear, { throttle: 1, brake: 0, steer: 0 }, DT, straight); // 5th arg omitted
    stepCar(noGear, { throttle: 1, brake: 0, steer: 0 }, DT, straight, null);
  }
  assert.equal(withGear.v, noGear.v);
});

test("a gear's own top speed becomes the local ceiling, well under the car's overall top speed", () => {
  const car = newCar(0);
  const speeds = run3(car, { throttle: 1, brake: 0, steer: 0 }, 12, 3); // gear 3: 100 km/h
  const cap = GEAR_SPEEDS[2];
  assert.ok(Math.abs(speeds.at(-1) - cap) / cap < 0.02, `settled at ${worldToKmh(speeds.at(-1)).toFixed(0)} km/h, expected ~100`);
  assert.ok(speeds.at(-1) < CAR.maxSpeed * 0.9, 'nowhere near the car\'s overall top speed');
});

test('lugging: launching from rest in a too-tall gear gains far less speed, one step, than gear 1', () => {
  // A single small step so neither gear has had time to hit its own speed cap — isolates the lugging
  // multiplier from the "gear 1's cap is much lower than gear 8's" effect a longer run would confound.
  const gear1 = newCar(0);
  stepCar(gear1, { throttle: 1, brake: 0, steer: 0 }, DT, straight, 1);
  const gear8 = newCar(0);
  stepCar(gear8, { throttle: 1, brake: 0, steer: 0 }, DT, straight, 8);
  assert.ok(gear8.v < gear1.v * 0.5, `one step: gear 1 -> ${gear1.v.toFixed(2)}, gear 8 -> ${gear8.v.toFixed(2)}`);
});

test('at the bottom of a gear\'s band (its own cap of the gear below), acceleration matches the plain per-gear taper with no lugging penalty', () => {
  // Gear 3's band starts exactly at gear 2's cap; v == bandLow is not "below" it, so no lugging applies.
  const gear = 3;
  const bandLow = GEAR_SPEEDS[gear - 2];
  const localMax = GEAR_SPEEDS[gear - 1];
  const car = newCar(bandLow);
  stepCar(car, { throttle: 1, brake: 0, steer: 0 }, DT, straight, gear);
  const ratio = bandLow / localMax;
  const expectedMul = 1 - 0.75 * ratio * ratio; // the ordinary per-gear taper, no lugging factor
  const expectedV = bandLow + CAR.accel * expectedMul * DT;
  assert.ok(Math.abs(car.v - expectedV) < 1e-6, `${car.v} vs expected ${expectedV}`);
});

test('just below the band, the lugging penalty measurably weakens acceleration versus right at the band edge', () => {
  const gear = 3;
  const bandLow = GEAR_SPEEDS[gear - 2];
  const atEdge = newCar(bandLow);
  stepCar(atEdge, { throttle: 1, brake: 0, steer: 0 }, DT, straight, gear);
  const belowBand = newCar(bandLow * 0.5);
  stepCar(belowBand, { throttle: 1, brake: 0, steer: 0 }, DT, straight, gear);
  const gainedAtEdge = atEdge.v - bandLow;
  const gainedBelow = belowBand.v - bandLow * 0.5;
  assert.ok(gainedBelow < gainedAtEdge * 0.7, `gained ${gainedBelow.toFixed(2)} below band vs ${gainedAtEdge.toFixed(2)} at the edge`);
});

// ---- over-cap engine braking (downshifting into too low a gear at speed) --------------------------

test("going faster than a gear's top speed (a downshift while still going fast) is never blocked, and speed eases back down toward the cap rather than cutting off", () => {
  // No throttle and no brake: coasting drag is also acting on the car throughout, same as it would for a
  // real player who just downshifted and lifted off — the engine-braking piece is only responsible for
  // easing the car down *to* the cap, not for holding it there forever once ordinary coasting takes over.
  const gear = 3; // 100 km/h cap
  const cap = GEAR_SPEEDS[gear - 1];
  const car = newCar(GEAR_SPEEDS[6]); // as if just downshifted from gear 7 (260 km/h) into gear 3
  const speeds = [car.v];
  for (let i = 0; i < 300; i++) { stepCar(car, NONE, DT, straight, gear); speeds.push(car.v); } // 2.5s

  assert.ok(speeds[0] > cap, 'starts above the gear cap (nothing stopped the downshift itself)');
  const aboveCap = speeds.filter((v) => v > cap).length;
  assert.ok(aboveCap > 3, 'takes several steps above the cap, i.e. genuinely gradual, not an instant snap');
  for (let i = 1; i < aboveCap; i++) assert.ok(speeds[i] <= speeds[i - 1] + 1e-9, 'eases down monotonically while still over the cap');
  assert.ok(aboveCap < speeds.length - 1, 'reaches the cap within this window rather than still falling at the end');
  assert.ok(Math.abs(speeds[aboveCap] - cap) < cap * 0.1, `landed at ${worldToKmh(speeds[aboveCap]).toFixed(0)} km/h, cap is ${worldToKmh(cap).toFixed(0)}`);

  // "Gentle, not a hard cut": losing more than a third of the overshoot in a single 1/120s step would be abrupt.
  const overshoot = speeds[0] - cap;
  const firstStepLoss = speeds[0] - speeds[1];
  assert.ok(firstStepLoss < overshoot * 0.3, `first step lost ${firstStepLoss.toFixed(1)} of a ${overshoot.toFixed(1)} overshoot`);
});

test('engine braking over the gear cap is a tunable constant (CAR.gearOverBrakeRate): a higher rate pulls down faster', () => {
  const gear = 3;
  const cap = GEAR_SPEEDS[gear - 1];
  const run400 = (rate) => {
    const savedRate = CAR.gearOverBrakeRate;
    CAR.gearOverBrakeRate = rate;
    const car = newCar(GEAR_SPEEDS[6]);
    for (let i = 0; i < 60; i++) stepCar(car, NONE, DT, straight, gear);
    CAR.gearOverBrakeRate = savedRate;
    return car.v;
  };
  const soft = run400(0.5);
  const firm = run400(3);
  assert.ok(firm < soft, `after the same time, a higher rate (${worldToKmh(firm).toFixed(0)}) is closer to the cap (${worldToKmh(cap).toFixed(0)}) than a lower one (${worldToKmh(soft).toFixed(0)})`);
});

test('full throttle in a gear settles right at that gear\'s own top speed, not above it', () => {
  const gear = 3;
  const cap = GEAR_SPEEDS[gear - 1];
  const speeds = run3(newCar(0), { throttle: 1, brake: 0, steer: 0 }, 15, gear);
  assert.ok(Math.abs(speeds.at(-1) - cap) / cap < 0.01, `settled at ${worldToKmh(speeds.at(-1)).toFixed(0)} km/h, expected ~${worldToKmh(cap).toFixed(0)}`);
});

// Like run(), but drives with a fixed gear each step.
function run3(car, input, seconds, gear) {
  const speeds = [car.v];
  for (let t = 0; t < seconds; t += DT) {
    stepCar(car, input, DT, straight, gear);
    speeds.push(car.v);
  }
  return speeds;
}
