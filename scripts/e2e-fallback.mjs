// Checks that a browser without WebGL falls back to the 2D view instead of showing a blank screen.
// Usage: node scripts/e2e-fallback.mjs

import puppeteer from 'puppeteer-core';
import { createGameServer } from '../server/index.js';
import { findChrome } from './browser-helpers.mjs';

const game = createGameServer({ laps: 1 });
await new Promise((r) => game.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${game.server.address().port}`;
const browser = await puppeteer.launch({
  executablePath: findChrome(), headless: 'new', args: ['--no-sandbox', '--disable-3d-apis', '--disable-gpu'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 450 });
  await page.goto(`${base}/?debug`);
  const hasWebgl = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl'));
  if (hasWebgl) throw new Error('test setup: WebGL is still available, cannot test the fallback');
  await page.type('#nick', 'Solo');
  await page.click('#btn-create');
  await page.waitForFunction(() => document.getElementById('lobby-code').textContent.length === 4);
  await page.click('#btn-start');
  await page.waitForFunction(() => !document.getElementById('hud').hidden);

  const state = await page.evaluate(() => ({
    canvas2d: !document.getElementById('game').hidden,
    canvas3d: !document.getElementById('game3d').hidden,
    toast: document.getElementById('toast').textContent,
    racing: !!window.__f1.race,
  }));
  console.log(state);
  if (!state.canvas2d || state.canvas3d || !state.racing) throw new Error('FAILED: did not fall back to the 2D view');
  if (!state.toast.includes('2D')) throw new Error('FAILED: no message explaining the switch');
  await page.keyboard.press('KeyV');
  await new Promise((r) => setTimeout(r, 300));
  if (await page.$eval('#game3d', (el) => !el.hidden)) throw new Error('FAILED: V must not enable 3D when WebGL is unavailable');
  console.log('ok  without WebGL the game falls back to 2D, explains why, and V does not break it');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  await game.close();
}
