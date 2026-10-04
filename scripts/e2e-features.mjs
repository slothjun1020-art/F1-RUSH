// End-to-end check of the four new features in real (headless) Chrome:
// lobby toggles for collisions/gear mode (host-only, visible to everyone), the gear-mode controls
// dialog (shown at race start, including to a player who joins the room later), free shifting with the
// gear HUD's informational-only "too fast" / "too slow" cues and live engine braking, and cars pushing
// each other apart when collisions are on. Runs at the lowest 3D quality for speed (?q=3).
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

  await host.click('#btn-collisions');
  await guest.waitForFunction(() => document.getElementById('btn-collisions').classList.contains('on'));
  check((await text(guest, '#btn-collisions .t-state')) === '켜짐', 'the guest sees collisions turn on');

  await host.click('#btn-gearmode');
  await guest.waitForFunction(() => document.getElementById('btn-gearmode').classList.contains('on'));
  check((await text(guest, '#btn-gearmode .t-state')) === '켜짐', 'the guest sees gear mode turn on');

  // ---- a third player joins the lobby *after* gear mode was already turned on ----
  const third = await newPlayer('third');
  await third.goto(`${base}/?room=${code}&q=3&debug`);
  await third.type('#nick', 'Newbie');
  await third.click('#btn-join');
  await lobbyPlayers(host, 3);
  check(await third.$eval('#btn-gearmode', (el) => el.classList.contains('on')), 'the late joiner sees gear mode already on in the lobby');

  // ---- race 1: everyone (including the late joiner) sees the gear-mode dialog on their first race ----
  await guest.click('#btn-ready');
  await third.click('#btn-ready');
  await host.waitForFunction(() => !document.getElementById('btn-start').disabled);
  await host.click('#btn-start');
  await Promise.all([host, guest, third].map((p) => p.waitForFunction(() => !document.getElementById('hud').hidden)));

  // ---- gear-mode controls dialog: shown to everyone, blocks driving keys, closes via OK or Esc ----
  await Promise.all([host, guest, third].map((p) => p.waitForFunction(() => !document.getElementById('gear-info').hidden)));
  check(true, 'the player who joined later also gets the gear-mode dialog, on their first race');
  await third.click('#gear-info-ok');
  check((await text(host, '#gear-info')).includes('3') && (await text(host, '#gear-info')).includes('4'), 'the dialog explains the 3/4 keys');
  check((await host.evaluate(() => document.activeElement?.id)) === 'gear-info-ok', 'focus starts on the OK button');
  await host.keyboard.down('ArrowUp');
  await sleep(120);
  await host.keyboard.up('ArrowUp');
  const whileOpen = await raceState(host);
  check(whileOpen.v === 0, 'driving keys are ignored while the dialog is open');
  await host.keyboard.press('Escape');
  check(await visible(host, '#gear-info') === false, 'Esc closes the dialog');
  await guest.click('#gear-info-ok');
  check(await visible(guest, '#gear-info') === false, 'the OK button closes the dialog too');

  // Wait for the lights to actually go out: the physics/collision loop only runs once the race has
  // started, and the countdown dialog above may still have been up when it began.
  await host.waitForFunction(() => document.getElementById('hud-center').textContent === 'GO!', { timeout: 15000 });

  check(await visible(host, '#hud-gear'), 'the gear HUD is shown for a gear-mode race');
  check((await text(host, '#hud-gear-num')) === '1', 'starts in 1st gear');

  // ---- shifting is never blocked: up, then straight down again from any speed ----
  await host.keyboard.press('Digit4');
  await host.waitForFunction(() => document.getElementById('hud-gear-num').textContent === '2');
  check(true, '4 upshifts');

  await host.evaluate(() => { window.__f1.race.car.v = 250; }); // far above gear 1's 20 km/h cap
  await host.keyboard.press('Digit3');
  // Shifts to 1 right away — no block, no delay. Speed itself starts easing down immediately afterward
  // (gear 1's engine braking), which is covered separately below, so this only checks the shift landed.
  await host.waitForFunction(() => document.getElementById('hud-gear-num').textContent === '1', { timeout: 2000 });
  check(true, 'downshifting even at high speed is immediate, no block');
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
