import test from 'node:test';
import assert from 'node:assert/strict';
import { TRACKS, getTrack } from '../shared/tracks.js';
import { BARRIER, locate } from '../shared/track-geom.js';
import {
  buildTrackScene, buildTerrain, buildTrees, trackFrames, edgePoint, terrainHeight, toScene,
  Y, KERB_W, WALL_HALF_T, TERRAIN, COLORS, hexLinear,
} from '../public/track3d.js';

const wellFormed = (m, label) => {
  assert.equal(m.positions.length % 3, 0, `${label}: positions come in triples`);
  assert.equal(m.colors.length, m.positions.length, `${label}: one color per vertex`);
  const count = m.positions.length / 3;
  for (const i of m.indices) assert.ok(i < count, `${label}: index in range`);
  assert.ok(m.positions.every(Number.isFinite), `${label}: finite positions`);
};

test('toScene maps the 2D heading to the scene so forward stays forward', () => {
  const p = toScene(100, 250, 0);
  assert.deepEqual([p.x, p.z], [100, 250]);
  // A car heading +x (a = 0) faces scene +x; heading +y (a = pi/2) faces scene +z (down the 2D screen).
  const forward = (a) => { const r = toScene(0, 0, a).rotY; return [Math.cos(r), -Math.sin(r)]; };
  const [fx0, fz0] = forward(0);
  assert.ok(Math.abs(fx0 - 1) < 1e-9 && Math.abs(fz0) < 1e-9);
  const [fx1, fz1] = forward(Math.PI / 2);
  assert.ok(Math.abs(fx1) < 1e-9 && Math.abs(fz1 - 1) < 1e-9);
});

for (const def of TRACKS) {
  test(`${def.en}: 3D road geometry is well formed and matches the physics edges`, () => {
    const t = getTrack(def.id);
    const scene = buildTrackScene(t);
    wellFormed(scene.flat, 'flat');
    wellFormed(scene.walls, 'walls');
    assert.equal(scene.stats.asphalt, t.n);
    assert.ok(scene.stats.kerb > t.n, 'most kerb strips exist');
    assert.ok(scene.stats.wall > t.n, 'most wall segments exist');

    // Road edges sit exactly halfW from the centerline.
    const fr = trackFrames(t);
    for (const i of [0, Math.floor(t.n / 3), Math.floor((2 * t.n) / 3)]) {
      for (const s of [-1, 1]) {
        const [x, , z] = edgePoint(t, fr, i, s * t.halfW, Y.asphalt);
        const d = Math.hypot(x - t.xs[i], z - t.ys[i]);
        assert.ok(Math.abs(d - t.halfW) < 1e-6);
      }
    }

    // Every guardrail vertex lies at the physical barrier distance or beyond (never on a road).
    // Allowed slack: the inner face is WALL_HALF_T inside the barrier line, the placement check has a 4 unit
    // tolerance, and measuring against sample points instead of segments adds a little more.
    const reach = t.halfW + BARRIER;
    const floor = reach - WALL_HALF_T - 4 - 3;
    const w = scene.walls.positions;
    for (let v = 0; v < w.length / 3; v += 5) {
      const loc = locate(t, w[v * 3], w[v * 3 + 2]);
      assert.ok(loc.dist >= floor, `wall vertex ${loc.dist.toFixed(1)} from centerline, expected >= ${floor}`);
    }
  });

  test(`${def.en}: terrain is flat around the whole circuit and trees keep clear of the road`, () => {
    const t = getTrack(def.id);
    const terrain = buildTerrain(t);
    wellFormed(terrain, 'terrain');
    const flatTo = t.halfW + TERRAIN.flatReach - 8;
    const p = terrain.positions;
    let raised = 0;
    for (let v = 0; v < p.length / 3; v += 7) {
      const loc = locate(t, p[v * 3], p[v * 3 + 2]);
      if (loc.dist <= flatTo) assert.ok(p[v * 3 + 1] <= Y.ground + 1, `terrain rises ${p[v * 3 + 1]} at ${loc.dist.toFixed(0)} from the road`);
      if (p[v * 3 + 1] > Y.ground + 100) raised++;
    }
    assert.ok(raised > 0, 'there are hills somewhere');

    const trees = buildTrees(t);
    assert.ok(trees.length > 100, `only ${trees.length} trees`);
    for (const tree of trees) {
      const loc = locate(t, tree.x, tree.z);
      assert.ok(loc.dist >= t.halfW + BARRIER + 30, 'tree is well outside the guardrail');
    }
  });
}

test('kerbs alternate red and white; the start line is orange', () => {
  const t = getTrack('monza');
  const { flat } = buildTrackScene(t);
  const has = (hex) => {
    const [r, g, b] = hexLinear(hex);
    for (let v = 0; v < flat.colors.length; v += 3) {
      if (Math.abs(flat.colors[v] - r) < 1e-6 && Math.abs(flat.colors[v + 1] - g) < 1e-6 && Math.abs(flat.colors[v + 2] - b) < 1e-6) return true;
    }
    return false;
  };
  assert.ok(has(COLORS.kerbRed), 'red kerb');
  assert.ok(has(COLORS.kerbWhite), 'white kerb');
  assert.ok(has(COLORS.start), 'orange start line');
});

test('Suzuka: nothing but road is drawn where the circuit crosses itself', () => {
  const t = getTrack('suzuka');
  // Find the crossover: samples close in space but far apart along the lap.
  let cross = null;
  for (let i = 0; i < t.n && !cross; i++) {
    for (let j = i + 40; j < t.n - 40; j++) {
      if (Math.hypot(t.xs[i] - t.xs[j], t.ys[i] - t.ys[j]) < 20) { cross = { x: t.xs[i], z: t.ys[i] }; break; }
    }
  }
  assert.ok(cross, 'Suzuka has a crossover');
  const { flat, walls } = buildTrackScene(t);
  // No wall, and no kerb/runoff/dash (anything above asphalt height), may sit on the crossing road.
  const near = (arr, minY) => {
    for (let v = 0; v < arr.positions.length; v += 3) {
      if (arr.positions[v + 1] > minY && Math.hypot(arr.positions[v] - cross.x, arr.positions[v + 2] - cross.z) < t.halfW - 6) return true;
    }
    return false;
  };
  assert.equal(near(walls, Y.ground + 1), false, 'no guardrail across the road');
  // Kerbs (y = Y.kerb) must not appear on the other road either.
  let kerbOnRoad = false;
  for (let v = 0; v < flat.positions.length; v += 3) {
    const y = flat.positions[v + 1];
    if ((y === Math.fround(Y.kerb) || y === Math.fround(Y.runoff)) && Math.hypot(flat.positions[v] - cross.x, flat.positions[v + 2] - cross.z) < t.halfW - 6) kerbOnRoad = true;
  }
  assert.equal(kerbOnRoad, false, 'no kerb or runoff strip across the road');
});

test('terrain height is continuous at the edge of the flat zone', () => {
  const t = getTrack('monza');
  const flat = t.halfW + TERRAIN.flatReach;
  assert.equal(terrainHeight(t, 0, 0, flat), Y.ground);
  assert.ok(terrainHeight(t, 0, 0, flat + 5) - Y.ground < 1);
  assert.ok(KERB_W > 0);
});
