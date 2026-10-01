import test from 'node:test';
import assert from 'node:assert/strict';
import { ghostPoseAt } from '../public/ghost.js';

test('an empty or missing path has nothing to replay', () => {
  assert.equal(ghostPoseAt([], 500), null);
  assert.equal(ghostPoseAt(null, 500), null);
});

test('a single-sample path always returns that point', () => {
  const path = [[0, 10, 20, 0.5]];
  assert.deepEqual(ghostPoseAt(path, 0), { x: 10, y: 20, a: 0.5 });
  assert.deepEqual(ghostPoseAt(path, 5000), { x: 10, y: 20, a: 0.5 });
});

test('interpolates linearly between two bracketing samples', () => {
  const path = [[0, 0, 0, 0], [1000, 100, 200, 0]];
  const mid = ghostPoseAt(path, 250);
  assert.equal(mid.x, 25);
  assert.equal(mid.y, 50);
});

test('exactly at a sample returns that sample', () => {
  const path = [[0, 0, 0, 0], [100, 10, 10, 0], [200, 20, 20, 0]];
  assert.deepEqual(ghostPoseAt(path, 100), { x: 10, y: 10, a: 0 });
});

test('heading interpolates the short way around the wrap from +pi to -pi', () => {
  const path = [[0, 0, 0, 3.0], [1000, 0, 0, -3.0]];
  const mid = ghostPoseAt(path, 500);
  // Going the short way (through pi/-pi), not the long way back through 0.
  assert.ok(Math.abs(mid.a) > 3, `expected near +-pi, got ${mid.a}`);
});

test('loops back to the start once elapsed time passes the recorded lap duration', () => {
  const path = [[0, 0, 0, 0], [1000, 100, 100, 0]];
  const justPastStart = ghostPoseAt(path, 50);      // first lap
  const oneLapLater = ghostPoseAt(path, 1050);      // exactly one full lap later
  const twoLapsLater = ghostPoseAt(path, 2050);     // two full laps later
  assert.deepEqual(oneLapLater, justPastStart);
  assert.deepEqual(twoLapsLater, justPastStart);
});

test('negative elapsed time still wraps into a valid position, not a crash', () => {
  const path = [[0, 0, 0, 0], [1000, 100, 100, 0]];
  assert.doesNotThrow(() => ghostPoseAt(path, -50));
  const pose = ghostPoseAt(path, -50);
  assert.ok(Number.isFinite(pose.x) && Number.isFinite(pose.y));
});
