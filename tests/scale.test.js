import test from 'node:test';
import assert from 'node:assert/strict';
import { SCALE, SPEED_SCALE, CAMERA_SCALE } from '../shared/scale.js';
import { TRACKS, getTrack } from '../shared/tracks.js';
import { SPACING, BARRIER, KERB_W } from '../shared/track-geom.js';
import { CAR } from '../shared/physics.js';
import { TERRAIN, WALL_H, buildTrees } from '../public/track3d.js';

test('the cars keep their size; only the world is scaled', () => {
  assert.equal(CAR.length, 56);
  assert.equal(CAR.width, 26);
  assert.equal(CAR.turn, 2.7);
});

test('every derived value follows the multipliers in shared/scale.js', () => {
  assert.equal(SPEED_SCALE, SCALE.length * SCALE.speedTrim);
  assert.equal(CAMERA_SCALE, Math.sqrt(SCALE.width));
  assert.equal(SPACING, 24 * SCALE.length);
  assert.equal(BARRIER, 80 * SCALE.width);
  assert.equal(KERB_W, 13 * SCALE.width);
  assert.equal(CAR.maxSpeed, 560 * SPEED_SCALE);
  assert.equal(CAR.accel, 420 * SPEED_SCALE);
  assert.equal(CAR.offSpeed, 230 * SPEED_SCALE);
  assert.equal(WALL_H, 18, 'guardrail height is about the cars, so it is not scaled');
  assert.ok(TERRAIN.margin > 3800 * CAMERA_SCALE, 'terrain reaches past the fog distance');
});

for (const def of TRACKS) {
  test(`${def.en}: lap length and road width use the multipliers, sample count is unchanged`, () => {
    const t = getTrack(def.id);
    assert.ok(Math.abs(t.L - def.km * 1800 * SCALE.length) / t.L < 0.01, `lap length ${t.L.toFixed(0)}`);
    assert.equal(t.width, 150 * SCALE.width);
    assert.equal(t.halfW, 75 * SCALE.width);
    // Sample spacing scales with the lap, so the number of samples (the "checkpoints") is what it always was.
    assert.equal(t.n, Math.round(def.km * 1800 / 24));
    assert.ok(Math.abs(t.spacing - SPACING) / SPACING < 0.02);
  });
}

test('tree belt keeps its density: more trees for a bigger track, none inside the barrier', () => {
  const t = getTrack('monza');
  const trees = buildTrees(t);
  assert.equal(trees.length, Math.round(420 * SCALE.length * SCALE.width));
});
