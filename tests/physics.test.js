import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrack } from '../shared/track-geom.js';
import { CAR, createCar, stepCar } from '../shared/physics.js';

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

test('braking starts soft: the first touch is far gentler than the old constant 1.6 x top speed per second', () => {
  const speeds = run(newCar(M), BRAKE, 0.3);
  const decel = decelBetween(speeds, 0, 0.2);
  assert.ok(decel < 0.4 * M, `initial decel ${(decel / M).toFixed(2)} x top speed/s`);
  assert.ok(decel > 0.15 * M, 'but the brakes do bite');
});

test('holding the brake makes it progressively stronger', () => {
  const speeds = run(newCar(M), BRAKE, 2);
  const early = decelBetween(speeds, 0, 0.2);
  const mid = decelBetween(speeds, 0.8, 1.0);
  const late = decelBetween(speeds, 1.6, 1.8);
  assert.ok(mid > early * 1.3, `${mid.toFixed(0)} vs ${early.toFixed(0)}`);
  assert.ok(late > mid * 1.1, `${late.toFixed(0)} vs ${mid.toFixed(0)}`);
  assert.ok(late < 0.9 * M, 'and never becomes a wall');
});

test('a full stop from top speed takes a couple of seconds and speed falls smoothly, never below zero', () => {
  const speeds = run(newCar(M), BRAKE, 2.4);
  const stopped = speeds.findIndex((v) => v <= 0);
  assert.ok(stopped > 0, 'the car comes to a stop');
  const t = stopped * DT;
  assert.ok(t > 1.5 && t < 3.6, `stopped after ${t.toFixed(2)} s (was 0.62 s before)`);
  for (let i = 1; i <= stopped; i++) assert.ok(speeds[i] <= speeds[i - 1] + 1e-9, 'monotonic');
  // No step changes speed by more than a small fraction of top speed per second.
  for (let i = 1; i <= stopped; i++) assert.ok((speeds[i - 1] - speeds[i]) / DT < 0.9 * M + 1);
});

test('tapping the brake stays gentle: releasing resets the firmness', () => {
  const car = newCar(M);
  const first = decelBetween(run(car, BRAKE, 0.2), 0, 0.2);
  run(car, NONE, 1.2);
  const before = car.v;
  const second = (before - run(car, BRAKE, 0.2).at(-1)) / 0.2;
  assert.ok(second < first * 1.3, `second tap ${second.toFixed(0)} vs first ${first.toFixed(0)}`);
});

test('coasting: gentle at first, long tapering roll-out, no sudden stop', () => {
  const speeds = run(newCar(M), NONE, 20);
  assert.ok(speeds[Math.round(1 / DT)] > 0.7 * M, 'still above 70% of top speed after one second');
  for (let i = 1; i < speeds.length; i++) assert.ok(speeds[i] <= speeds[i - 1] + 1e-9 && speeds[i] >= 0, 'monotonic, never reverses');

  const stopped = speeds.findIndex((v) => v <= 0.5);
  assert.ok(stopped > 0, 'the car does eventually stop');
  assert.ok(stopped * DT > 6 && stopped * DT < 20, `rolled for ${(stopped * DT).toFixed(1)} s`);

  // Deceleration only ever tapers off as the car slows down (no constant-rate cutoff at the end)...
  const early = decelBetween(speeds, 0, 0.5);
  const slow = decelBetween(speeds, (stopped - 0.5 / DT) * DT, stopped * DT);
  assert.ok(early <= 0.3 * M, `initial coast decel ${(early / M).toFixed(2)} x top speed/s`);
  // ...so the last half second is much gentler than the old constant 0.21 x top speed per second.
  assert.ok(slow < 0.08 * M, `final decel ${(slow / M).toFixed(3)} x top speed/s`);
});

test('braking to a halt then holding the pedal switches to a gentle reverse', () => {
  const car = newCar(60 * (CAR.maxSpeed / 560));
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
