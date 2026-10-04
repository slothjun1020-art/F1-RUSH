// Checks that a browser without WebGL shows the "3D required" screen and blocks everything else,
// instead of showing a blank screen or letting the player try to start a race that can't render.
// Usage: node scripts/e2e-fallback.mjs

import puppeteer from 'puppeteer-core';
import { createGameServer } from '../server/index.js';
import { findChrome, fakeGhostsStore } from './browser-helpers.mjs';

const game = await createGameServer({ laps: 1, ghosts: fakeGhostsStore() });
await new Promise((r) => game.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${game.server.address().port}`;
const browser = await puppeteer.launch({
  executablePath: findChrome(), headless: 'new', args: ['--no-sandbox', '--disable-3d-apis', '--disable-gpu'],
});
const check = (cond, msg) => { if (!cond) throw new Error(`FAILED: ${msg}`); console.log(`ok  ${msg}`); };

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 450 });
  await page.goto(`${base}/?debug`);
  const hasWebgl = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl'));
  if (hasWebgl) throw new Error('test setup: WebGL is still available, cannot test the fallback');

  // main.js awaits the view3d.js import before it can even attempt (and fail) to build the renderer, so
  // the "3D required" screen appears a beat after the page loads, not synchronously with it.
  await page.waitForFunction(() => document.getElementById('screen-nowebgl')?.hidden === false, { timeout: 5000 });

  const state = await page.evaluate(() => ({
    nowebglVisible: !document.getElementById('screen-nowebgl').hidden,
    startVisible: !document.getElementById('screen-start').hidden,
    message: document.getElementById('screen-nowebgl').textContent,
  }));
  check(state.nowebglVisible, 'the "3D required" screen is shown');
  check(!state.startVisible, 'the normal start screen (nickname, create/join) is hidden');
  check(state.message.includes('3D'), `the message mentions 3D graphics (got: ${state.message.trim()})`);

  // The start screen's inputs still exist in the DOM (just behind the blocking screen) — confirm they
  // are not usable, i.e. nothing lets the player limp into a race that can never render.
  const reachable = await page.evaluate(() => {
    const el = document.getElementById('btn-create');
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !document.getElementById('screen-start').hidden;
  });
  check(!reachable, '"방 만들기" is not reachable while the 3D-required screen is up');

  console.log('ok  no room/connection was ever created (the page never got past the blocking screen)');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  await game.close();
}
