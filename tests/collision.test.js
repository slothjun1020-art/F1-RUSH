import test from 'node:test';
import assert from 'node:assert/strict';
import { COLLISION, resolveCollisions } from '../shared/collision.js';

const DT = 1 / 60;

test('far apart: nothing happens', () => {
  const car = { x: 0, y: 0, a: 0, v: 200 };
  const before = { ...car };
  const hit = resolveCollisions(car, [{ x: 1000, y: 0 }], DT);
  assert.equal(hit, false);
  assert.deepEqual(car, before);
});

test('overlapping cars are pushed apart along the line between their centers', () => {
  const car = { x: 10, y: 0, a: 0, v: 0 };
  const other = { x: 0, y: 0 };
  const hit = resolveCollisions(car, [other], DT);
  assert.equal(hit, true);
  assert.ok(car.x > 10, 'pushed away from the other car, along +x');
  assert.ok(Math.abs(car.y) < 1e-9, 'no sideways push when directly in line');
  // Resolves about half the overlap on its own each frame (the other side does the rest).
  const overlap = COLLISION.radius * 2 - 10;
  assert.ok(Math.abs((car.x - 10) - overlap * COLLISION.push) < 1e-9);
});

test('a push is proportional to how deep the overlap is', () => {
  const shallow = { x: COLLISION.radius * 2 - 2, y: 0, a: 0, v: 0 };
  resolveCollisions(shallow, [{ x: 0, y: 0 }], DT);
  const deep = { x: COLLISION.radius * 0.5, y: 0, a: 0, v: 0 };
  resolveCollisions(deep, [{ x: 0, y: 0 }], DT);
  assert.ok((deep.x - COLLISION.radius * 0.5) > (shallow.x - (COLLISION.radius * 2 - 2)));
});

test('driving straight into another car bleeds off speed; driving away does not', () => {
  // Car sits just behind another car and is heading straight at it (+x).
  const into = { x: 0, y: 0, a: 0, v: 300 };
  resolveCollisions(into, [{ x: 10, y: 0 }], DT);
  assert.ok(into.v < 300, `expected speed loss, got ${into.v}`);

  // Same overlap, but heading away (-x): no speed lost.
  const away = { x: 0, y: 0, a: Math.PI, v: 300 };
  resolveCollisions(away, [{ x: 10, y: 0 }], DT);
  assert.equal(away.v, 300, 'moving away from the hit costs no speed');
});

test('a glancing (perpendicular) hit costs far less speed than a head-on one', () => {
  const headOn = { x: 0, y: 0, a: 0, v: 300 };
  resolveCollisions(headOn, [{ x: 10, y: 0 }], DT);
  const glancing = { x: 0, y: 0, a: Math.PI / 2, v: 300 };
  resolveCollisions(glancing, [{ x: 10, y: 0 }], DT);
  assert.ok((300 - headOn.v) > (300 - glancing.v) * 3, 'head-on loses much more speed than a graze');
});

test('a stationary or reversing car never gains speed from a collision', () => {
  const stopped = { x: 0, y: 0, a: 0, v: 0 };
  resolveCollisions(stopped, [{ x: 10, y: 0 }], DT);
  assert.equal(stopped.v, 0);
  const reversing = { x: 0, y: 0, a: 0, v: -50 };
  resolveCollisions(reversing, [{ x: 10, y: 0 }], DT);
  assert.equal(reversing.v, -50);
});

test('exactly overlapping cars (zero distance) resolve along the car\'s own heading instead of dividing by zero', () => {
  const car = { x: 5, y: 5, a: Math.PI / 4, v: 0 };
  const hit = resolveCollisions(car, [{ x: 5, y: 5 }], DT);
  assert.equal(hit, true);
  assert.ok(Number.isFinite(car.x) && Number.isFinite(car.y));
  assert.ok(car.x > 5 && car.y > 5, 'pushed out along its own heading');
});

test('multiple overlapping cars are each resolved in turn', () => {
  const car = { x: 0, y: 0, a: 0, v: 0 };
  const hit = resolveCollisions(car, [{ x: 10, y: 0 }, { x: -10, y: 0 }], DT);
  assert.equal(hit, true);
  assert.ok(Number.isFinite(car.x));
});
