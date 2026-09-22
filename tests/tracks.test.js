import test from 'node:test';
import assert from 'node:assert/strict';
import { TRACKS, getTrack } from '../shared/tracks.js';
import { locate, pointAt } from '../shared/track-geom.js';
import { createCar, stepCar } from '../shared/physics.js';
import { createProgress, advanceProgress, gridSlot } from '../shared/race.js';
import { botInput } from '../shared/bot.js';

test('there are 10 tracks with unique ids', () => {
  assert.equal(TRACKS.length, 10);
  assert.equal(new Set(TRACKS.map((t) => t.id)).size, 10);
});

for (const def of TRACKS) {
  test(`${def.en}: geometry is a closed, evenly sampled loop`, () => {
    const t = getTrack(def.id);
    assert.ok(Math.abs(t.L - def.lapLength) / def.lapLength < 0.01, 'lap length near target');
    for (let i = 0; i < t.n; i++) {
      const j = (i + 1) % t.n;
      const d = Math.hypot(t.xs[j] - t.xs[i], t.ys[j] - t.ys[i]);
      assert.ok(d > t.spacing * 0.3 && d < t.spacing * 1.7, `sample spacing at ${i}: ${d}`);
    }
    const p = pointAt(t, 0);
    const q = pointAt(t, t.L);
    assert.ok(Math.hypot(p.x - q.x, p.y - q.y) < 1e-6);
  });

  test(`${def.en}: a bot can drive a clean lap and the lap counter agrees`, () => {
    const t = getTrack(def.id);
    const g = gridSlot(t, 0);
    const car = createCar(g.x, g.y, g.a, t);
    const prog = createProgress(t, g.s);
    const dt = 1 / 60;
    let time = 0;
    let maxDist = 0;
    while (prog.total < t.L && time < 120) {
      stepCar(car, botInput(car, t), dt, t);
      advanceProgress(t, prog, car.x, car.y);
      maxDist = Math.max(maxDist, car.dist);
      time += dt;
    }
    assert.ok(prog.total >= t.L, `did not finish a lap in 120s (total ${prog.total.toFixed(0)} / ${t.L.toFixed(0)})`);
    assert.ok(maxDist < t.halfW + 30, `bot strayed ${maxDist.toFixed(0)} from centerline`);
    // Enlarging the circuits must not change lap times much: they used to be 19-39 s for the bot.
    assert.ok(time > 15 && time < 45, `lap took ${time.toFixed(1)} s`);
    console.log(`  ${def.en}: lap ${time.toFixed(1)}s, length ${t.L.toFixed(0)}, max offset ${maxDist.toFixed(0)}`);
  });
}

for (const def of TRACKS.filter((d) => d.id !== 'suzuka')) {
  test(`${def.en}: separate stretches of road never touch each other`, () => {
    const t = getTrack(def.id);
    const minGap = t.width * 1.15;
    let worst = Infinity;
    for (let i = 0; i < t.n; i++) {
      for (let j = i + 1; j < t.n; j++) {
        const arc = Math.min(j - i, t.n - (j - i)) * t.spacing;
        if (arc < t.width * 4) continue; // neighbours along the same stretch
        worst = Math.min(worst, Math.hypot(t.xs[i] - t.xs[j], t.ys[i] - t.ys[j]));
      }
    }
    assert.ok(worst >= minGap, `closest approach ${worst.toFixed(0)} < ${minGap.toFixed(0)}`);
  });
}

test('locate with a hint stays on the right stretch where Suzuka crosses itself', () => {
  const t = getTrack('suzuka');
  // Find the crossing: two centerline samples that are close in space but far apart in arc length.
  let found = null;
  for (let i = 0; i < t.n && !found; i++) {
    for (let j = i + 40; j < t.n - 40; j++) {
      if (Math.hypot(t.xs[i] - t.xs[j], t.ys[i] - t.ys[j]) < 30) { found = [i, j]; break; }
    }
  }
  assert.ok(found, 'Suzuka should have a crossover');
  const [i, j] = found;
  const a = locate(t, t.xs[i], t.ys[i], i, 14);
  const b = locate(t, t.xs[i], t.ys[i], j, 14);
  assert.ok(Math.abs(a.seg - i) <= 1);
  assert.ok(Math.abs(b.seg - j) <= 14, 'hinted to the other pass, it stays there');
});
