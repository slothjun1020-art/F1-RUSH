// End-to-end check of the four new features in real (headless) Chrome:
// lobby toggles for collisions/gear mode (host-only, visible to everyone), the gear-mode controls dialog
// (shown the instant gear mode is turned on in the lobby, including to a player who joins later — never
// again at race start), semi-automatic shifting (Shift always upshifts; braking under the current gear's
// band downshifts automatically, never manually) with the gear HUD's informational-only "too fast" /
// "too slow" cues and live engine braking, and cars pushing each other apart when collisions are on.
// Runs at the lowest 3D quality for speed (?q=3).
// Usage: node scripts/e2e-features.mjs   (needs Google Chrome; set CHROME_PATH if it lives elsewhere)

import { createGameServer } from '../server/index.js';
import { launchBrowser, sleep, fakeGhostsStore } from './browser-helpers.mjs';

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
const visible = (page, sel) => page.$eval(sel, (el) => !el.hidden && el.getBoundingClientRect().width > 0);
const text = (page, sel) => page.$eval(sel, (el) => el.textContent);
const lobbyPlayers = (p, n) => p.waitForFunction((count) => document.querySelectorAll('#plist li').length === count, {}, n);
const raceState = (p) => p.evaluate(() => {
  const r = window.__f1.race;
  return r && { gear: r.gear, v: r.car.v, x: r.car.x, y: r.car.y };
});

try {
  const host = await newPlayer('host');
  const guest = await newPlayer('guest');

  await host.goto(`${base}/?q=3&debug`);
  await host.type('#nick', 'Hostie');
  await host.click('#btn-create');
  await host.waitForFunction(() => document.getElementById('lobby-code').textContent.length === 4);
  const code = await text(host, '#lobby-code');
  await guest.goto(`${base}/?room=${code}&q=3&debug`);
  await guest.type('#nick', 'Guesty');
  await guest.click('#btn-join');
  await lobbyPlayers(host, 2);
  await host.click('.track[data-id="redbullring"]');

  // ---- lobby toggles: host can flip them, everyone sees the state ----
  check(!(await host.$eval('#btn-collisions', (el) => el.classList.contains('on'))), 'collisions start off');
  check(!(await host.$eval('#btn-gearmode', (el) => el.classList.contains('on'))), 'gear mode starts off');
  check(await guest.$eval('#btn-collisions', (el) => el.disabled), 'a guest cannot toggle collisions');
  check(await guest.$eval('#btn-gearmode', (el) => el.disabled), 'a guest cannot toggle gear mode');
  check(!(await visible(host, '#gear-info')), 'no gear-mode dialog before it is turned on');

  await host.click('#btn-collisions');
  await guest.waitForFunction(() => document.getElementById('btn-collisions').classList.contains('on'));
  check((await text(guest, '#btn-collisions .t-state')) === '켜짐', 'the guest sees collisions turn on');

  // ---- turning gear mode on in the lobby shows the controls dialog immediately, to everyone there ----
  await host.click('#btn-gearmode');
  await guest.waitForFunction(() => document.getElementById('btn-gearmode').classList.contains('on'));
  check((await text(guest, '#btn-gearmode .t-state')) === '켜짐', 'the guest sees gear mode turn on');
  await Promise.all([host, guest].map((p) => p.waitForFunction(() => !document.getElementById('gear-info').hidden)));
  check(true, 'turning gear mode on shows everyone in the lobby the controls dialog right away');
  const dialogText = await text(host, '#gear-info');
  check(dialogText.includes('Shift') && dialogText.includes('브레이크'), `the dialog is just the controls, briefly (got: ${dialogText})`);
  check((await host.evaluate(() => document.activeElement?.id)) === 'gear-info-ok', 'focus starts on the OK button');
  await host.keyboard.press('Escape');
  check(await visible(host, '#gear-info') === false, 'Esc closes the dialog');
  await guest.click('#gear-info-ok');
  check(await visible(guest, '#gear-info') === false, 'the OK button closes the dialog too');

  // ---- a third player joins the lobby *after* gear mode was already turned on ----
  const third = await newPlayer('third');
  await third.goto(`${base}/?room=${code}&q=3&debug`);
  await third.type('#nick', 'Newbie');
  await third.click('#btn-join');
  await lobbyPlayers(host, 3);
  check(await third.$eval('#btn-gearmode', (el) => el.classList.contains('on')), 'the late joiner sees gear mode already on in the lobby');
  await third.waitForFunction(() => !document.getElementById('gear-info').hidden);
  check(true, 'and gets the controls dialog immediately too, without waiting for a race to start');
  await third.click('#gear-info-ok');

  // ---- the dialog never reappears once a race actually starts ----
  await guest.click('#btn-ready');
  await third.click('#btn-ready');
  await host.waitForFunction(() => !document.getElementById('btn-start').disabled);
  await host.click('#btn-start');
  await Promise.all([host, guest, third].map((p) => p.waitForFunction(() => !document.getElementById('hud').hidden)));
  await sleep(300);
  check(await host.$eval('#gear-info', (el) => el.hidden), 'the gear-mode dialog does not pop up again at race start');

  // Wait for the lights to actually go out: the physics/collision loop only runs once the race has started.
  await host.waitForFunction(() => document.getElementById('hud-center').textContent === 'GO!', { timeout: 15000 });

  check(await visible(host, '#hud-gear'), 'the gear HUD is shown for a gear-mode race');
  check((await text(host, '#hud-gear-num')) === '1', 'starts in 1st gear');

  // ---- Shift upshifts, any number of times, capped at gear 8 — never blocked. Both physical keys work
  //      identically (e.key, not e.code — see input.js) ----
  await host.keyboard.press('ShiftLeft');
  await host.waitForFunction(() => document.getElementById('hud-gear-num').textContent === '2');
  check(true, 'left Shift upshifts');
  await host.keyboard.press('ShiftRight');
  await host.waitForFunction(() => document.getElementById('hud-gear-num').textContent === '3');
  check(true, 'right Shift upshifts too');
  await host.evaluate(() => { window.__f1.race.gear = 8; }); // already at the top gear
  await host.waitForFunction(() => document.getElementById('hud-gear-num').textContent === '8');
  await host.keyboard.press('ShiftRight');
  await sleep(300);
  check((await text(host, '#hud-gear-num')) === '8', 'Shift never goes past gear 8 (8-speed, unchanged)');
  check((await host.evaluate(() => document.activeElement?.tagName)) === 'BODY', 'Shift does not keep keyboard focus');

  // ---- downshifting is automatic, tied to braking — never a manual key, and never while accelerating ----
  await host.evaluate(() => { window.__f1.race.car.v = 250; }); // gear 8, but far under even gear 2's band
  check((await text(host, '#hud-gear-num')) === '8', 'still gear 8 — speed dropping alone changes nothing');
  await host.keyboard.down('ArrowDown'); // brake
  await host.waitForFunction(() => document.getElementById('hud-gear-num').textContent !== '8', { timeout: 2000 });
  check(true, 'braking while under the current gear\'s band downshifts automatically');
  await host.keyboard.up('ArrowDown');
  const droppedTo = Number(await text(host, '#hud-gear-num'));
  check(droppedTo >= 1 && droppedTo < 8, `landed on a gear matching 250 units/s (got gear ${droppedTo})`);

  await host.keyboard.down('ArrowUp'); // accelerate again, no brake
  await sleep(200);
  await host.keyboard.up('ArrowUp');
  check(Number(await text(host, '#hud-gear-num')) === droppedTo, 'accelerating again never climbs a gear back up on its own — that still takes Shift');
  check(await host.$('#hud-gear-warn') === null, 'the old blocked-downshift warning element is gone entirely');

  // ---- HUD range indicators (informational only — they never touch driving input) ----
  // Re-locate after directly setting car.v/car.x, the same discipline stepCar follows internally, since
  // a stale cached segment hint would otherwise throw off every locate() call from here on.
  await host.evaluate(async () => {
    const { locate } = await import('/shared/track-geom.js');
    window.__relocate = () => {
      const r = window.__f1.race;
      const loc = locate(r.track, r.car.x, r.car.y);
      r.car.seg = loc.seg;
      r.car.dist = loc.dist;
    };
  });

  await host.evaluate(() => {
    const r = window.__f1.race;
    r.gear = 1; // back to a known state — the shifting checks above left gear/speed wherever they landed
    r.car.v = 250;
    window.__relocate();
  });
  check((await raceState(host)).v > 0, 'gear 1 at 250 world units/s is already over its 20 km/h cap: the "too fast" cue should be showing');
  await host.waitForFunction(() => document.getElementById('hud-gear-num').classList.contains('shift'));
  check(true, 'too fast for the gear shows the "shift" cue (still driving freely, not blocked)');

  // Engine braking actually pulls speed down toward the gear's cap over time, gently.
  const overCapBefore = (await raceState(host)).v;
  await sleep(1500);
  const overCapAfter = (await raceState(host)).v;
  check(overCapAfter < overCapBefore, `engine braking eased speed down from ${overCapBefore.toFixed(0)} toward the gear 1 cap (now ${overCapAfter.toFixed(0)})`);

  await host.evaluate(() => {
    const r = window.__f1.race;
    r.gear = 4; // 140 km/h cap; gear 3's cap (100) is the bottom of this gear's band
    r.car.v = 5; // well under the band -> lugging, and the "too slow" HUD cue
    window.__relocate();
  });
  await host.waitForFunction(() => document.getElementById('hud-gear-num').classList.contains('lug'));
  check(true, 'too slow for the gear shows the "lug" cue');
  check(await host.$eval('#hud-gear-num', (el) => el.classList.contains('shift')) === false, '"lug" and "shift" are mutually exclusive');

  await host.evaluate(() => {
    const r = window.__f1.race;
    r.gear = 3;
    r.car.v = 100000; // world units/s, comfortably above any gear cap, to force the "too fast" state again
    window.__relocate();
  });
  await host.waitForFunction(() => document.getElementById('hud-gear-num').classList.contains('shift'));
  check(true, 'the gear number lights up again once back over the (new gear\'s) cap');

  // ---- collisions: force an overlap and watch the cars separate ----
  const before = await host.evaluate(() => {
    const r = window.__f1.race;
    const other = [...r.remotes.values()][0]?.buf.at(-1);
    if (!other) return null;
    r.car.v = 0; // drop whatever speed the earlier gear-HUD hacks left it at
    r.car.x = other.x; r.car.y = other.y; // teleport onto the other car
    window.__relocate();
    return { x: r.car.x, y: r.car.y, ox: other.x, oy: other.y };
  });
  check(before != null, 'the host has a recent snapshot of the guest to overlap with');
  await sleep(400); // several frames of collision resolution
  const after = await host.evaluate(() => ({ x: window.__f1.race.car.x, y: window.__f1.race.car.y }));
  const dist = Math.hypot(after.x - before.ox, after.y - before.oy);
  check(dist > 5 && dist < 200, `overlapping cars pushed apart (moved ${dist.toFixed(1)} units clear)`);

  check(errors.length === 0, `no browser errors (${errors.join(' | ') || 'none'})`);
  console.log('\nAll feature checks passed.');
} catch (err) {
  console.error(err.message);
  console.error('Browser errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  await game.close();
}
