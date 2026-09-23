// Bumper-car style collision between players' cars: no damage, just pushed apart and a little speed
// lost on a head-on hit. Runs on each client for its own car only (the server never simulates cars — see
// shared/physics.js), so it is an approximation, not an authority: each side independently notices the
// overlap and resolves about half of it, and the result re-converges every frame even if the two sides'
// estimates of each other's position are briefly out of sync over the network.
//
// Cars are treated as circles. The real car is a 56x26 rectangle; a circle is a deliberate simplification
// (good enough for a casual "bump" feel) rather than a full oriented-box test.

export const COLLISION = {
  radius: 24,       // world units, roughly the car's footprint (not scaled by track size — see shared/scale.js)
  push: 0.5,        // fraction of the overlap this car resolves on its own each frame
  speedLossRate: 6, // 1/s: how fast a head-on hit bleeds speed (scaled by dt and how head-on it is)
};

// car: the local car { x, y, a, v, ... } — mutated in place (x, y, v).
// others: array of { x, y } for every other car to check against.
// Returns true if a collision was resolved this call.
export function resolveCollisions(car, others, dt) {
  let hit = false;
  const minDist = COLLISION.radius * 2;
  for (const o of others) {
    const dx = car.x - o.x;
    const dy = car.y - o.y;
    const dist = Math.hypot(dx, dy);
    if (dist >= minDist) continue;
    hit = true;
    const overlap = minDist - dist;
    // dist can be ~0 if two cars land exactly on top of each other; push along the car's own heading
    // in that degenerate case so it doesn't sit stuck at a division by zero.
    const nx = dist > 1e-6 ? dx / dist : Math.cos(car.a);
    const ny = dist > 1e-6 ? dy / dist : Math.sin(car.a);
    car.x += nx * overlap * COLLISION.push;
    car.y += ny * overlap * COLLISION.push;

    // Lose speed in proportion to how head-on the hit is: driving straight into another car costs more
    // speed than clipping it at a glancing angle, which costs almost none.
    const into = -(Math.cos(car.a) * nx + Math.sin(car.a) * ny); // >0 when heading toward the other car
    if (into > 0 && car.v > 0) {
      car.v -= car.v * COLLISION.speedLossRate * into * dt;
    }
  }
  return hit;
}
