// End-to-end check of the best-lap ghost car in real (headless) Chrome: a first solo race with no track
// record yet seeds one on finishing, a second solo race on the same track is shown the saved ghost (a
// translucent car plus a "베스트랩: nick (time)" label), and a multiplayer race never shows a ghost even
// though a record now exists for that track.
// Usage: node scripts/e2e-ghost.mjs   (needs Google Chrome; set CHROME_PATH if it lives elsewhere)

import { createGameServer } from '../server/index.js';
import {
  launchBrowser, drive, sleep, fakeGhostsStore,
} from './browser-helpers.mjs';

const game = await createGameServer({ laps: 1, ghosts: fakeGhostsStore() });
await new Promise((r) => game.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${game.server.address().port}`;
const browser = await launchBrowser();

const errors = [];
async function newPlayer(name) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 800, height: 450 });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
  return page;
}
const check = (cond, msg) => { if (!cond) throw new Error(`FAILED: ${msg}`); console.log(`ok  ${msg}`); };
const resultsShown = (p) => async () => p.evaluate(() => !document.getElementById('screen-results').hidden);
const hasGhostCar = (p) => p.evaluate(() => window.__f1.race.renderer.cars.has('ghost'));
const ghostLabelText = (p) => p.evaluate(() => document.querySelector('#labels .nick3d.ghost')?.textContent ?? null);

try {
  // ---- first solo race: no record yet for this track, finishing seeds one ----
  const solo = await newPlayer('solo');
  await solo.goto(`${base}/?debug&q=3`);
  await solo.type('#nick', 'Seeder');
  await solo.click('#btn-create');
  await solo.waitForFunction(() => document.getElementById('lobby-code').textContent.length === 4);
  await solo.click('.track[data-id="redbullring"]');
  await solo.waitForFunction(() => !document.getElementById('btn-start').disabled);
  await solo.click('#btn-start');
  await solo.waitForFunction(() => !document.getElementById('hud').hidden);
  check(await solo.evaluate(() => window.__f1.race.ghost) === null, 'no ghost on the first-ever solo race on this track');
  check(!(await hasGhostCar(solo)), 'no ghost car mesh either');

  await drive(solo, { skill: 1, stopWhen: resultsShown(solo) });
  check(await resultsShown(solo)(), 'first solo race finished');

  // ---- second solo race on the same track: the saved ghost should now appear ----
  await solo.click('#btn-back');
  await solo.waitForFunction(() => !document.getElementById('screen-lobby').hidden);
  await solo.waitForFunction(() => !document.getElementById('btn-start').disabled);
  await solo.click('#btn-start');
  await solo.waitForFunction(() => !document.getElementById('hud').hidden);
  await solo.waitForFunction(() => window.__f1.race.ghost !== null, { timeout: 5000 });
  const ghostInfo = await solo.evaluate(() => ({ nick: window.__f1.race.ghost.nick, time: window.__f1.race.ghost.time }));
  check(ghostInfo.nick === 'Seeder', `the ghost is the first race's driver (got ${ghostInfo.nick})`);
  check(ghostInfo.time > 0, 'the ghost carries a positive lap time');

  // The ghost only actually renders once the race clock passes startAt (game.js draw()) — the countdown
  // (COUNTDOWN_MS) runs first, so wait for that rather than a short fixed sleep.
  await solo.waitForFunction(() => window.__f1.race.renderer.cars.has('ghost'), { timeout: 15000 });
  check(await hasGhostCar(solo), 'a ghost car mesh is placed in the scene');
  const label = await ghostLabelText(solo);
  check(label != null && label.includes('베스트랩') && label.includes('Seeder'), `the ghost label reads correctly (got: ${label})`);

  // The ghost should keep a finite, sane position as it drives — not stuck, not NaN.
  await sleep(500);
  const ghostPos = await solo.evaluate(() => {
    const e = window.__f1.race.renderer.cars.get('ghost');
    return e ? { x: e.mesh.position.x, z: e.mesh.position.z } : null;
  });
  check(
    !!ghostPos && Number.isFinite(ghostPos.x) && Number.isFinite(ghostPos.z),
    `the ghost car has a finite position (got ${JSON.stringify(ghostPos)})`,
  );

  // ---- multiplayer: a record now exists for this track, but a 2-player race never shows a ghost ----
  const host = await newPlayer('host');
  const guest = await newPlayer('guest');
  await host.goto(`${base}/?debug&q=3`);
  await host.type('#nick', 'Host');
  await host.click('#btn-create');
  await host.waitForFunction(() => document.getElementById('lobby-code').textContent.length === 4);
  const code = await host.$eval('#lobby-code', (el) => el.textContent);
  await host.click('.track[data-id="redbullring"]');

  await guest.goto(`${base}/?room=${code}&debug&q=3`);
  await guest.type('#nick', 'Guest');
  await guest.click('#btn-join');
  await host.waitForFunction(() => document.querySelectorAll('#plist li').length === 2);
  await guest.click('#btn-ready');
  await host.waitForFunction(() => !document.getElementById('btn-start').disabled);
  await host.click('#btn-start');
  // race.ghost is set synchronously when the race object is built (onGo in main.js), so there is no
  // need to wait out the countdown to "GO!" here — same as the solo check above.
  await host.waitForFunction(() => !document.getElementById('hud').hidden);
  check(await host.evaluate(() => window.__f1.race.ghost) === null, 'a 2-player race never gets a ghost, even with a saved record');
  check(!(await hasGhostCar(host)), 'no ghost car mesh in multiplayer');

  check(errors.length === 0, `no browser errors (${errors.join(' | ') || 'none'})`);
  console.log('\nAll ghost checks passed.');
} catch (err) {
  console.error(err.message);
  console.error('Browser errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  await game.close();
}
