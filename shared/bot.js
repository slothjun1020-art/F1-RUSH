// A simple pure-pursuit driver. Tests use it to prove every track is drivable and to feed the server
// realistic position reports; the browser e2e script uses it to play a full race.

import { pointAt, locate } from './track-geom.js';
import { CAR } from './physics.js';
import { SPEED_SCALE } from './scale.js';

const S = SPEED_SCALE;
const norm = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// What the bot assumes about the car. The brakes are soft, so it starts slowing well before a corner:
// at every distance ahead it works out the speed from which it can still reach that corner's speed.
const LATERAL = 420 * S;             // sideways acceleration budget for corners
const BRAKING = 0.4 * CAR.maxSpeed;  // deceleration it counts on (the soft brakes deliver more once warmed up)
const PROBE = 60 * S;                // spacing of the look-ahead samples
const REACH = 640 * S;               // how far ahead it looks

export function botInput(car, track) {
  const loc = locate(track, car.x, car.y, car.seg, 14);
  const look = 80 * S + Math.abs(car.v) * 0.3;
  const target = pointAt(track, loc.s + look);
  const desired = Math.atan2(target.y - car.y, target.x - car.x);
  const err = norm(desired - car.a);
  const steer = Math.max(-1, Math.min(1, err * 2.5));

  let targetSpeed = CAR.maxSpeed;
  for (let d = 0; d <= REACH; d += PROBE) {
    const a0 = pointAt(track, loc.s + d).a;
    const a1 = pointAt(track, loc.s + d + PROBE).a;
    const curve = Math.abs(norm(a1 - a0)) / PROBE;
    const cornerSpeed = Math.max(140 * S, Math.min(CAR.maxSpeed, Math.sqrt(LATERAL / Math.max(curve, 1e-4))));
    const allowedNow = Math.sqrt(cornerSpeed * cornerSpeed + 2 * BRAKING * d);
    if (allowedNow < targetSpeed) targetSpeed = allowedNow;
  }

  const throttle = car.v < targetSpeed ? 1 : 0;
  const brake = car.v > targetSpeed * 1.05 ? 1 : 0;
  return { throttle, brake, steer };
}
