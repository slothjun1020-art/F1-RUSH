// Arcade car model. Cars run in the browser only; the server never simulates them,
// it just checks the reported positions (see race.js and server/rooms.js).

import { locate, BARRIER } from './track-geom.js';
import { SPEED_SCALE } from './scale.js';

// Speeds, accelerations and distances are in world units and follow SPEED_SCALE (shared/scale.js) so a
// bigger track does not make laps longer. The car's own size and its turn rate do not scale.
const S = SPEED_SCALE;

export const CAR = {
  length: 56,
  width: 26,
  maxSpeed: 560 * S,     // on asphalt
  offSpeed: 230 * S,     // cap when the car center is off the asphalt
  accel: 420 * S,
  offDrag: 460 * S,      // how fast a car that is too fast for the grass is slowed to offSpeed
  overDrag: 240 * S,     // same, for exceeding maxSpeed on asphalt
  reverseMax: 140 * S,
  gripSpeed: 120 * S,    // below this speed the wheels have less bite, so steering is weaker
  turn: 2.7,             // rad/s at low speed

  // Brakes. Deceleration is a fraction of top speed per second: it starts soft and firms up the longer
  // the pedal is held (smoothstep over brakeRamp seconds). Letting go decays the ramp, so tapping stays gentle.
  brakeStart: 0.28,      // 0.28 x top speed per second at the first touch
  brakeFull: 0.85,       // after brakeRamp seconds of continuous braking
  brakeRamp: 1.8,
  brakeRelease: 2.5,     // ramp lost per second while the pedal is up

  // Coasting (throttle up, no brake). Speed-proportional drag gives a long tapering roll-out, and a small
  // rolling resistance brings the car gently to rest instead of cutting off at a constant rate.
  drag: 0.24,            // fraction of current speed lost per second
  roll: 0.018 * 560 * S, // constant part, world units per second squared
};

export function createCar(x, y, a, track) {
  const loc = locate(track, x, y);
  return { x, y, a, v: 0, seg: loc.seg, dist: loc.dist, brakeHold: 0 };
}

// input: { throttle: 0..1, brake: 0..1, steer: -1..1 (negative = left) }
export function stepCar(car, input, dt, track) {
  const off = car.dist > track.halfW;
  const vmax = off ? CAR.offSpeed : CAR.maxSpeed;
  let v = car.v;

  if (input.throttle > 0) {
    const ratio = Math.max(0, v) / CAR.maxSpeed;
    v += CAR.accel * (1 - 0.75 * ratio * ratio) * input.throttle * dt;
  }

  if (input.brake > 0) {
    if (v > 0) {
      car.brakeHold = Math.min(CAR.brakeRamp, (car.brakeHold ?? 0) + dt);
      const u = car.brakeHold / CAR.brakeRamp;
      const firm = u * u * (3 - 2 * u);
      const decel = CAR.maxSpeed * (CAR.brakeStart + (CAR.brakeFull - CAR.brakeStart) * firm);
      v = Math.max(0, v - decel * input.brake * dt);
    } else {
      v -= CAR.accel * 0.4 * input.brake * dt; // stopped: the pedal now selects reverse
    }
  } else {
    car.brakeHold = Math.max(0, (car.brakeHold ?? 0) - CAR.brakeRelease * dt);
  }

  if (!input.throttle && !input.brake) {
    const slow = (CAR.drag * Math.abs(v) + CAR.roll) * dt;
    v -= Math.sign(v) * Math.min(Math.abs(v), slow);
  }

  if (v > vmax) v = Math.max(vmax, v - (off ? CAR.offDrag : CAR.overDrag) * dt);
  if (v < -CAR.reverseMax) v = -CAR.reverseMax;

  const speedRatio = Math.min(1, Math.abs(v) / CAR.maxSpeed);
  const grip = Math.min(1, Math.abs(v) / CAR.gripSpeed);
  const turnRate = CAR.turn * (1 - 0.55 * speedRatio) * grip;
  car.a += input.steer * turnRate * dt * (v >= 0 ? 1 : -1);
  car.v = v;
  car.x += Math.cos(car.a) * v * dt;
  car.y += Math.sin(car.a) * v * dt;

  const loc = locate(track, car.x, car.y, car.seg, 14);
  car.seg = loc.seg;
  car.dist = loc.dist;

  // Outer wall: stop the car at the barrier and bleed off speed while it scrapes along it.
  const limit = track.halfW + BARRIER;
  if (loc.dist > limit) {
    const k = limit / loc.dist;
    car.x = loc.px + (car.x - loc.px) * k;
    car.y = loc.py + (car.y - loc.py) * k;
    car.dist = limit;
    car.v *= Math.pow(0.02, dt);
  }
  return car;
}
