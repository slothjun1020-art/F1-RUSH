// End-to-end check of the tire-wear system in real (headless) Chrome: the lobby toggle, the HUD gauge
// appearing and climbing, a 100%-wear DNF broadcasting to the other player, the DNF'd player's own screen
// switching to a clickable "spectate" leaderboard, and the results screen marking them DNF.
//
// The test server runs in this same Node process (like every other e2e script here), so
// shared/physics.js's CAR object is the exact instance server/rooms.js's wear math reads from — bumping
// CAR.wearGrassRate up for this run makes the whole DNF flow testable in a couple of seconds instead of
// the real ~25s the default rate implies. The same bump is applied separately in the browser (its own,
// unrelated copy of the module) so the HUD gauge climbs just as fast for the person actually "driving".
// Usage: node scripts/e2e-tirewear.mjs   (needs Google Chrome; set CHROME_PATH if it lives elsewhere)

import { CAR } from '../shared/physics.js';
import { createGameServer } from '../server/index.js';
import {
  launchBrowser, drive, sleep, fakeGhostsStore,
} from './browser-helpers.mjs';

CAR.wearGrassRate = 1; // 100% wear in ~1s of continuous grass contact, just for this test run

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
const text = (page, sel) => page.$eval(sel, (el) => el.textContent);
const resultsShown = (p) => async () => p.evaluate(() => !document.getElementById('screen-results').hidden);

try {
  const host = await newPlayer('host');
  const guest = await newPlayer('guest');

  await host.goto(`${base}/?debug&q=3`);
  await host.type('#nick', 'Hostie');
  await host.click('#btn-create');
  await host.waitForFunction(() => document.getElementById('lobby-code').textContent.length === 4);
  const code = await host.$eval('#lobby-code', (el) => el.textContent);
  await host.click('.track[data-id="redbullring"]');

  // ---- lobby toggle ----
  check(!(await host.$eval('#btn-tirewear', (el) => el.classList.contains('on'))), 'tire wear starts off');
  await host.click('#btn-tirewear');
  await host.waitForFunction(() => document.getElementById('btn-tirewear').classList.contains('on'));
  check(true, 'the toggle turns on');
  check((await text(host, '#btn-tirewear .t-state')) === '켜짐', 'and shows 켜짐');

  await guest.goto(`${base}/?room=${code}&debug&q=3`);
  await guest.type('#nick', 'Guesty');
  await guest.click('#btn-join');
  await host.waitForFunction(() => document.querySelectorAll('#plist li').length === 2);
  await guest.waitForFunction(() => document.getElementById('btn-tirewear').classList.contains('on'));
  check(true, 'the guest sees it on too');

  await guest.click('#btn-ready');
  await host.waitForFunction(() => !document.getElementById('btn-start').disabled);
  await host.click('#btn-start');
  await Promise.all([host, guest].map((p) => p.waitForFunction(() => !document.getElementById('hud').hidden)));

  check(await host.$eval('#hud-tire', (el) => !el.hidden), 'the HUD tire gauge is shown when tire wear is on');
  check((await text(host, '#tire-pct')) === '0%', 'it starts at 0%');
  check(await host.$eval('#tire-icon', (el) => el.classList.contains('w-ok')), 'and starts green (w-ok)');

  await host.waitForFunction(() => document.getElementById('hud-center').textContent === 'GO!', { timeout: 15000 });

  // ---- park the host's car in the grass and bump the browser's own copy of the wear rate too ----
  await host.evaluate(async () => {
    const { KERB_W } = await import('/shared/track-geom.js');
    const { CAR: carConst } = await import('/shared/physics.js');
    carConst.wearGrassRate = 1;
    const { car, track } = window.__f1.race;
    const a = track.angs[car.seg];
    const off = track.halfW + KERB_W + 50;
    car.x = track.xs[car.seg] - Math.sin(a) * off;
    car.y = track.ys[car.seg] + Math.cos(a) * off;
    car.v = 0;
  });

  await host.waitForFunction(() => {
    const pct = document.getElementById('tire-pct').textContent;
    return pct !== '0%';
  }, { timeout: 5000 });
  check(true, 'the gauge percentage climbs once parked in the grass');

  // ---- wait for the server to call the DNF (authoritative — see server/rooms.js's onState) ----
  await host.waitForFunction(() => document.getElementById('hud-center').textContent.includes('탈락'), { timeout: 20000 });
  check(true, "the DNF'd player's own screen explains why and how to spectate");
  check(await host.$eval('#hud-board', (el) => el.classList.contains('spectate-mode')), 'the leaderboard becomes clickable');

  await guest.waitForFunction(() => document.getElementById('toast').classList.contains('show'), { timeout: 5000 });
  const toastMsg = await text(guest, '#toast');
  check(toastMsg.includes('Hostie') && toastMsg.includes('타이어 마모'), `the guest is told why (got: ${toastMsg})`);

  // ---- spectating: click the guest's row, the camera target switches ----
  const guestId = await guest.evaluate(() => window.__f1.race.meId);
  await host.evaluate((id) => {
    const row = [...document.querySelectorAll('#hud-board li')].find((li) => !li.classList.contains('me'));
    row.click();
  }, guestId);
  await host.waitForFunction(
    (id) => window.__f1.race.spectateId === id,
    { timeout: 3000 },
    guestId,
  );
  check(true, 'clicking another row sets the spectate target to that player');

  // ---- the guest finishes; results mark the host DNF, not just "미완주" ----
  await drive(guest, { skill: 1, stopWhen: resultsShown(guest) });
  await host.waitForFunction(() => !document.getElementById('screen-results').hidden, { timeout: 10000 });
  const rows = await host.$$eval('#res-table tbody tr', (trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent)));
  const hostRow = rows.find((r) => r[1].includes('Hostie'));
  check(hostRow[2] === 'DNF', `the host's results row reads DNF, not 미완주 (got ${hostRow[2]})`);

  await sleep(200); // let any trailing console errors from the DNF/results transition land
  check(errors.length === 0, `no browser errors (${errors.join(' | ') || 'none'})`);
  console.log('\nAll tire-wear checks passed.');
} catch (err) {
  console.error(err.message);
  console.error('Browser errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  await game.close();
}
