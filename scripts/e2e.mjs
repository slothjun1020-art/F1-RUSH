// End-to-end check in real (headless) Chrome: two players, lobby, a 1-lap race driven by the bot
// through actual keyboard events, the 3D chase view, the 2D/3D switch, the reset button, the results
// screen, and back to the lobby.
// Usage: node scripts/e2e.mjs   (needs Google Chrome; set CHROME_PATH if it lives elsewhere)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createGameServer } from '../server/index.js';
import { launchBrowser, drive, sleep } from './browser-helpers.mjs';

const outDir = process.env.E2E_OUT ?? path.join(os.tmpdir(), 'f1-e2e');
fs.mkdirSync(outDir, { recursive: true });

const game = createGameServer({ laps: 1 });
await new Promise((r) => game.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${game.server.address().port}`;
const browser = await launchBrowser();

const errors = [];
async function newPlayer(name) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  // Small viewport: headless Chrome renders WebGL in software, and fill rate is what makes it slow.
  await page.setViewport({ width: 640, height: 400 });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(outDir, `${name}.png`) });
const check = (cond, msg) => { if (!cond) throw new Error(`FAILED: ${msg}`); console.log(`ok  ${msg}`); };
const visible = (page, sel) => page.$eval(sel, (el) => !el.hidden && el.getBoundingClientRect().width > 0);
const carState = (page) => page.evaluate(() => {
  const r = window.__f1.race;
  return { dist: r.car.dist, v: r.car.v, lapsDone: r.lapsDone, total: r.prog.total };
});

try {
  const host = await newPlayer('host');
  const guest = await newPlayer('guest');

  // q=3 = lowest 3D quality (no shadows), so software WebGL in headless Chrome keeps up.
  // debug=1 (not just ?debug) also turns on the ping/FPS corner overlay for the checks below.
  await host.goto(`${base}/?debug=1&q=3`);
  await host.type('#nick', 'Hostie');
  await host.click('#btn-create');
  await host.waitForFunction(() => document.getElementById('lobby-code').textContent.length === 4);
  const code = await host.$eval('#lobby-code', (el) => el.textContent);
  check(/^[A-Z2-9]{4}$/.test(code), `host got a room code (${code})`);

  await guest.goto(`${base}/?room=${code}&debug&q=3`); // bare ?debug: the test hook, but no overlay
  check((await guest.$eval('#code', (el) => el.value)) === code, 'invite link pre-fills the room code');
  await guest.type('#nick', 'Guesty');
  await guest.click('#btn-join');
  await guest.waitForFunction(() => document.querySelectorAll('#plist li').length === 2);
  await host.waitForFunction(() => document.querySelectorAll('#plist li').length === 2);
  check(true, 'both players see each other in the lobby');
  check(await host.$eval('#debug-hud', (el) => !el.hidden), '?debug=1 shows the ping/FPS corner overlay');
  check(await guest.$eval('#debug-hud', (el) => el.hidden), 'plain ?debug (the test hook) does not show the overlay');

  check(await host.$eval('#btn-start', (el) => el.disabled), 'host cannot start before the guest is ready');
  await host.click('.track[data-id="monaco"]');
  await guest.waitForFunction(() => document.querySelector('.track.selected')?.dataset.id === 'monaco');
  check(true, "guest sees the host's track choice (Monaco)");

  await guest.click('#btn-ready');
  await host.waitForFunction(() => !document.getElementById('btn-start').disabled);
  await host.click('#btn-start');

  await Promise.all([host, guest].map((p) => p.waitForFunction(() => !document.getElementById('hud').hidden)));
  await sleep(1500);
  check(['READY', '3', '2', '1'].includes(await guest.$eval('#hud-center', (el) => el.textContent)), 'countdown is shown before the start');

  // ---- 3D chase view ----
  for (const [name, page] of [['host', host], ['guest', guest]]) {
    check(await visible(page, '#game3d') && !(await visible(page, '#game')), `${name}: the 3D canvas is shown by default (2D canvas hidden)`);
  }
  await guest.waitForFunction(() => document.querySelectorAll('#labels .nick3d').length === 2);
  const labels = await guest.$$eval('#labels .nick3d', (els) => els.map((e) => e.textContent).sort());
  check(labels.join() === 'Guesty,Hostie', `nicknames float above both cars (${labels.join(', ')})`);
  await shot(host, '3d-1-countdown-host');
  await host.waitForFunction(() => /\d+ ms/.test(document.getElementById('dbg-ping').textContent), { timeout: 5000 });
  check(await host.$eval('#dbg-fps', (el) => /\d+ FPS/.test(el.textContent)), 'the debug overlay shows a frame rate');
  check(await host.$eval('#dbg-ping', (el) => /\d+ ms/.test(el.textContent)), 'the debug overlay shows a ping in ms');

  // ---- wait for GO, then the reset button and R key ----
  await host.waitForFunction(() => document.getElementById('hud-center').textContent === 'GO!', { timeout: 15000 });
  for (const way of ['button', 'key']) {
    // Put the car on the grass beside the road, 45 units past the asphalt edge.
    await host.evaluate(() => {
      const { car, track } = window.__f1.race;
      const a = track.angs[car.seg];
      const off = track.halfW + 45;
      car.x = track.xs[car.seg] - Math.sin(a) * off;
      car.y = track.ys[car.seg] + Math.cos(a) * off;
      car.v = 300;
    });
    await sleep(100);
    const off = await carState(host);
    check(off.dist > 100, `(${way}) car was placed off the track (${off.dist.toFixed(0)} from the centerline)`);
    if (way === 'button') await host.click('#btn-reset');
    else await host.keyboard.press('KeyR');
    await sleep(250);
    const back = await carState(host);
    check(back.dist < 3 && Math.abs(back.v) < 30, `(${way}) reset puts the car back on the track and stops it`);
    check(back.lapsDone === 0, `(${way}) reset does not change the lap count`);
  }
  check(await host.evaluate(() => document.activeElement?.tagName !== 'BUTTON'), 'the reset button does not keep keyboard focus (Space still brakes)');

  // ---- switch to the old 2D view and back ----
  await host.keyboard.press('KeyV');
  await host.waitForFunction(() => !document.getElementById('game').hidden);
  check(!(await visible(host, '#game3d')) && !(await visible(host, '#labels')), 'V switches to the 2D view (3D canvas and labels hidden)');
  await sleep(300);
  await shot(host, '2d-view-host');
  check(await host.$('#btn-view') === null, 'there is no on-screen 2D/3D button any more (only the V key)');
  await host.keyboard.press('KeyV');
  await host.waitForFunction(() => !document.getElementById('game3d').hidden);
  check(await visible(host, '#game3d') && !(await visible(host, '#game')), 'V switches back to 3D');

  // ---- full race, driven by the bot ----
  const resultsShown = (p) => async () => p.evaluate(() => !document.getElementById('screen-results').hidden);
  let shotMid = false;
  const midShot = async () => {
    if (!shotMid && (await host.evaluate(() => window.__f1.race?.car.v > 300))) {
      shotMid = true;
      await shot(host, '3d-2-race-host');
      await shot(guest, '3d-3-race-guest');
    }
  };
  await Promise.all([
    drive(host, { skill: 1, stopWhen: async () => { await midShot(); return resultsShown(host)(); } }),
    drive(guest, { skill: 0.85, stopWhen: resultsShown(guest) }),
  ]);

  await shot(host, '3d-4-results-host');
  const rows = await host.$$eval('#res-table tbody tr', (trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent)));
  console.log(rows);
  check(rows.length === 2, 'results list both drivers');
  const ms = (t) => { const [m, s] = t.split(':'); return Number(m) * 60000 + Number(s) * 1000; };
  check(rows.map((r) => r[1]).sort().join() === 'Guesty,Hostie', 'both drivers are listed by nickname');
  check(/^\d:\d\d\.\d{3}$/.test(rows[0][2]) && ms(rows[0][2]) <= ms(rows[1][2]), 'the lower race time is ranked first');
  check(await host.$eval('#hud-lap', (el) => /LAP 1\/1/.test(el.textContent)), 'HUD overlay (lap) is still shown over the 3D view');

  check(await guest.$eval('#btn-back', (el) => el.hidden), 'only the host sees the back-to-lobby button');
  await host.click('#btn-back');
  await Promise.all([host, guest].map((p) => p.waitForFunction(() => !document.getElementById('screen-lobby').hidden)));
  check(true, 'host sends everyone back to the lobby');

  check(errors.length === 0, `no browser errors (${errors.join(' | ') || 'none'})`);
  console.log(`\nAll e2e checks passed. Screenshots: ${outDir}`);
} catch (err) {
  console.error(err.message);
  console.error('Browser errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  await game.close();
}
