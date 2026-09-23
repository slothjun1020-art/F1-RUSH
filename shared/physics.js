// Arcade car model. Cars run in the browser only; the server never simulates them,
// it just checks the reported positions (see race.js and server/rooms.js).

import { locate, BARRIER } from './track-geom.js';
import { SPEED_SCALE } from './scale.js';

// Speeds, accelerations and distances are in world units and follow SPEED_SCALE (shared/scale.js) so a
// bigger track does not make laps longer. The car's own size and its turn rate do not scale.
const S = SPEED_SCALE;

// One real km/h is this many world units/second at the current track scale. The HUD speed readout and
// the gear table below both go through this, so a car's speed always reads correctly in km/h no matter
// how big the track is (see shared/scale.js).
export const WORLD_PER_KMH = 2 * S;
export const kmhToWorld = (kmh) => kmh * WORLD_PER_KMH;
export const worldToKmh = (v) => v / WORLD_PER_KMH;

// The 8-speed sequential gearbox's top speed per gear, in km/h. The one place to change these — CAR.maxSpeed
// below is derived from the top entry, so the overall top speed follows even with gear mode off.
export const GEAR_SPEEDS_KMH = [20, 60, 100, 140, 180, 220, 260, 300];
export const GEAR_SPEEDS = GEAR_SPEEDS_KMH.map(kmhToWorld);

export const CAR = {
  length: 56,
  width: 26,
  maxSpeed: GEAR_SPEEDS[GEAR_SPEEDS.length - 1], // on asphalt; 300 km/h (see GEAR_SPEEDS_KMH above)
  offSpeed: 230 * S,     // cap when the car center is off the asphalt
  accel: 420 * S,
  offDrag: 460 * S,      // how fast a car that is too fast for the grass is slowed to offSpeed
  overDrag: 240 * S,     // same, for exceeding maxSpeed on asphalt (ungeared, or off the gear's own cap)
  reverseMax: 140 * S,
  gripSpeed: 120 * S,    // below this speed the wheels have less bite, so steering is weaker
  turn: 2.7,             // rad/s at low speed

  // Brakes. Deceleration is a fraction of top speed per second: it starts soft and firms up the longer
  // the pedal is held (smoothstep over brakeRamp seconds). Letting go decays the ramp, so tapping stays
  // gentle. Softened from the original 0.28/0.85/1.8s tuning, which had been set for a 280 km/h car and
  // started to feel harsh once top speed rose to 300 km/h.
  brakeStart: 0.15,      // 0.15 x top speed per second at the first touch
  brakeFull: 0.68,       // after brakeRamp seconds of continuous braking
  brakeRamp: 2.4,
  brakeRelease: 2.5,     // ramp lost per second while the pedal is up

  // Coasting (throttle up, no brake). Like the brakes, this eases in rather than applying full strength
  // the instant the pedal is lifted (coastRamp), so releasing the throttle doesn't feel like hitting a
  // wall. Once fully ramped in, speed-proportional drag gives a long tapering roll-out, and a small
  // rolling resistance brings the car gently to rest instead of cutting off at a constant rate.
  coastRamp: 1.1,        // seconds to ease from no coast drag at all up to the full drag/roll below
  drag: 0.24,            // fraction of current speed lost per second, once fully eased in
  roll: 0.018 * GEAR_SPEEDS[GEAR_SPEEDS.length - 1], // constant part, world units per second squared

  // Gear mode only (shared/race rules elsewhere are unaffected). gearLugMin is the floor on how weak
  // acceleration gets when well under a gear's band (a too-tall gear at low speed still creeps forward).
  // gearOverBrakeRate is how fast speed eases back down to a gear's own top speed when over it (a too-low
  // gear at high speed): higher = firmer engine braking, in 1/second (an exponential approach, so it is
  // gentle at first and never a hard cut).
  gearLugMin: 0.35,
  gearOverBrakeRate: 1.5,
};

export function createCar(x, y, a, track) {
  const loc = locate(track, x, y);
  return {
    x, y, a, v: 0, seg: loc.seg, dist: loc.dist, brakeHold: 0, coastHold: 0,
  };
}

// input: { throttle: 0..1, brake: 0..1, steer: -1..1 (negative = left) }
// gear: 1-8 when the room's gear mode is on, or null/undefined for the ungeared model (unchanged from
// before gears existed). With a gear: using a gear too tall for the current speed ("lugging") weakens
// acceleration, and going faster than the gear's own top speed (too low a gear) gently engine-brakes
// back down toward it — but shifting itself is never blocked; the gear only ever affects the physics.
export function stepCar(car, input, dt, track, gear = null) {
  const gearCap = gear ? GEAR_SPEEDS[gear - 1] : null;
  const localMax = gearCap != null ? Math.min(gearCap, CAR.maxSpeed) : CAR.maxSpeed;
  const off = car.dist > track.halfW;
  const vmax = off ? Math.min(CAR.offSpeed, localMax) : localMax;
  let v = car.v;

  // Gated on v < localMax: once at the local ceiling the throttle stops adding further speed (the engine
  // is out of room in this gear), so sustained full throttle settles right at the cap instead of creeping
  // past it. Any overshoot from another cause (a downshift while already going faster, mainly) is left
  // entirely to the gentle engine-braking further down, rather than fighting it here.
  if (input.throttle > 0 && v < localMax) {
    const ratio = Math.max(0, v) / localMax;
    let mul = 1 - 0.75 * ratio * ratio;
    if (gearCap != null && gear > 1) {
      const bandLow = GEAR_SPEEDS[gear - 2]; // the gear below's cap: the ideal minimum speed for this gear
      if (v < bandLow) mul *= Math.max(CAR.gearLugMin, v / bandLow); // lugging: weak accel under the band
    }
    v += CAR.accel * mul * input.throttle * dt;
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
    car.coastHold = 0;
  } else {
    car.brakeHold = Math.max(0, (car.brakeHold ?? 0) - CAR.brakeRelease * dt);
  }

  if (!input.throttle && !input.brake) {
    // Ease in: coastHold ramps 0 -> 1 over coastRamp seconds, so drag starts at (near) zero right at the
    // moment the throttle is released and only reaches full strength a little while after — no kink.
    car.coastHold = Math.min(CAR.coastRamp, (car.coastHold ?? 0) + dt);
    const cu = car.coastHold / CAR.coastRamp;
    const cfirm = cu * cu * (3 - 2 * cu);
    const slow = (CAR.drag * Math.abs(v) + CAR.roll) * cfirm * dt;
    v -= Math.sign(v) * Math.min(Math.abs(v), slow);
  } else if (input.throttle > 0) {
    car.coastHold = 0;
  }

  // Over the local ceiling. A gear that is too low for the current speed engine-brakes smoothly back
  // down toward its own top speed (an exponential approach: firm at first, gentle as it nears the cap,
  // never a hard cut) rather than the harsher constant-rate bleed-off used for the other two cases below
  // (running off the track, or — with gear mode off — simply exceeding the car's overall top speed).
  if (v > vmax) {
    if (gearCap != null && !off && vmax === gearCap && vmax < CAR.maxSpeed) {
      v = gearCap + (v - gearCap) * Math.exp(-CAR.gearOverBrakeRate * dt);
    } else {
      v = Math.max(vmax, v - (off ? CAR.offDrag : CAR.overDrag) * dt);
    }
  }
  if (v < -CAR.reverseMax) v = -CAR.reverseMax;

  // Steering sensitivity tapers gradually as speed rises, down to 40% of the low-speed value at top speed.
  const speedRatio = Math.min(1, Math.abs(v) / CAR.maxSpeed);
  const grip = Math.min(1, Math.abs(v) / CAR.gripSpeed);
  const turnRate = CAR.turn * (1 - 0.6 * speedRatio) * grip;
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
