// Takes screenshots of the 3D view for visual review.
// Usage: node scripts/shots3d.mjs [trackId=monaco] [quality=0] [outDir]
// Solo race, driven by the bot. Writes 3d-*.png files and prints frame rates.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createGameServer } from '../server/index.js';
import { launchBrowser, drive, sleep } from './browser-helpers.mjs';

// Optional 4th argument "crossover": start the car just before the point where the circuit crosses itself.
const [trackId = 'monaco', quality = '0', outArg, where] = process.argv.slice(2);
const outDir = outArg ?? path.join(os.tmpdir(), 'f1-shots');
fs.mkdirSync(outDir, { recursive: true });

const game = createGameServer({ laps: 3 });
await new Promise((r) => game.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${game.server.address().port}`;
const browser = await launchBrowser();

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const problems = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`${m.type()}: ${m.text()}`); });

  await page.goto(`${base}/?debug&q=${quality}`);
  await page.type('#nick', 'Mira');
  await page.click('#btn-create');
  await page.waitForFunction(() => document.getElementById('lobby-code').textContent.length === 4);
  await page.click(`.track[data-id="${trackId}"]`);
  await page.click('#btn-start');
  await page.waitForFunction(() => !document.getElementById('hud').hidden);
  await sleep(1200);
  await page.screenshot({ path: path.join(outDir, `3d-${trackId}-1-grid.png`) });

  const fps = async () => page.evaluate(() => new Promise((resolve) => {
    let frames = 0;
    const t0 = performance.now();
    const step = () => { frames++; if (performance.now() - t0 < 2000) requestAnimationFrame(step); else resolve(frames / 2); };
    requestAnimationFrame(step);
  }));

  if (where === 'crossover') {
    await page.waitForFunction(() => document.getElementById('hud-center').textContent === 'GO!', { timeout: 15000 });
    await page.evaluate(async () => {
      const { pointAt } = await import('/shared/track-geom.js');
      const r = window.__f1.race;
      const t = r.track;
      let cross = null;
      for (let i = 0; i < t.n && cross === null; i++) {
        for (let j = i + 40; j < t.n - 40; j++) {
          if (Math.hypot(t.xs[i] - t.xs[j], t.ys[i] - t.ys[j]) < 20) { cross = j; break; }
        }
      }
      const s = cross * t.spacing - t.width * 2.8; // a little before the crossing, whatever the scale
      const p = pointAt(t, s);
      Object.assign(r.car, { x: p.x, y: p.y, a: p.a, v: 250, seg: Math.floor(s / t.spacing), dist: 0 });
      r.prog.sPrev = s;
      r.prog.seg = Math.floor(s / t.spacing);
      r.renderer.snap();
    });
  }

  const shots = new Map([[40, '2-straight'], [110, '3-corner'], [200, '4-later']]);
  await drive(page, {
    stopWhen: async (tick) => tick > 210,
    onTick: async (tick) => {
      if (shots.has(tick)) await page.screenshot({ path: path.join(outDir, `3d-${trackId}-${shots.get(tick)}.png`) });
    },
  });
  console.log(`frames per second (software WebGL): ${await fps()}`);
  console.log('console problems:', problems.length ? problems : 'none');
  console.log(`screenshots in ${outDir}`);
} finally {
  await browser.close();
  await game.close();
}
