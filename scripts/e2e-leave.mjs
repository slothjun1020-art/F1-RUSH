// End-to-end check of leaving a room in real (headless) Chrome:
// the confirmation dialog, the host leaving during the countdown, DNF on the leaderboard, host hand-over,
// the remaining player finishing alone with a normal results screen, rejoining, and leaving from the
// results screen. Runs at the lowest 3D quality (?q=3) so software WebGL keeps up.
// Usage: node scripts/e2e-leave.mjs   (needs Google Chrome; set CHROME_PATH if it lives elsewhere)

import { createGameServer } from '../server/index.js';
import { launchBrowser, drive, sleep } from './browser-helpers.mjs';

const game = createGameServer({ laps: 1 });
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
const resultsShown = (p) => async () => p.evaluate(() => !document.getElementById('screen-results').hidden);
const inRace = (p) => p.evaluate(() => !!window.__f1.race);
const lobbyPlayers = (p, n) => p.waitForFunction((count) => document.querySelectorAll('#plist li').length === count, {}, n);
const tableRows = (p) => p.$$eval('#res-table tbody tr', (trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent)));

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
  await guest.click('#btn-ready');
  await host.waitForFunction(() => !document.getElementById('btn-start').disabled);
  await host.click('#btn-start');
  await Promise.all([host, guest].map((p) => p.waitForFunction(() => !document.getElementById('hud').hidden)));
  await host.waitForFunction(() => ['READY', '3', '2', '1'].includes(document.getElementById('hud-center').textContent));

  check(await visible(host, '#game3d'), 'the 3D canvas is shown');

  // ---- the confirmation dialog (host, during the countdown) ----
  check(!(await visible(host, '#confirm')), 'no dialog before the button is used');
  await host.click('#btn-quit');
  check(await visible(host, '#confirm'), 'the leave button asks for confirmation');
  check((await text(host, '#confirm')).includes('나가면 이번 기록이 사라져요'), 'the dialog warns that the record will be lost');
  check((await host.evaluate(() => document.activeElement?.id)) === 'confirm-no', 'focus is on the safe "continue" button, never on the HUD button');
  await host.keyboard.press('Escape');
  check(!(await visible(host, '#confirm')) && await inRace(host), 'Escape cancels and the race goes on');
  check((await host.evaluate(() => document.activeElement?.tagName)) === 'BODY', 'no button keeps keyboard focus after cancelling');
  await host.keyboard.press('Space');
  await sleep(150);
  check(!(await visible(host, '#confirm')), 'Space (brake) does not open or trigger the leave dialog');

  // ---- the host leaves during the countdown ----
  await host.click('#btn-quit');
  await host.click('#confirm-yes');
  check(await visible(host, '#screen-start') && !(await visible(host, '#hud')), 'confirming returns the leaver to the start screen');
  check(!(await inRace(host)), 'the leaver is out of the race');
  check(!host.url().includes('room='), 'the invite code is dropped from the address');

  // ---- what the others see ----
  await guest.waitForFunction(() => document.querySelector('#hud-board li.dnf'));
  const dnfRow = await text(guest, '#hud-board li.dnf');
  check(dnfRow.includes('Hostie') && dnfRow.includes('DNF'), `the leaver stays on the leaderboard as DNF (${dnfRow})`);
  check((await text(guest, '#hud-pos')) === '1/1', 'position counts only the drivers still racing');
  const note = await text(guest, '#toast');
  check(note.includes('Hostie') && note.includes('기록 없음') && note.includes('방장'), 'the guest is told who left (no record) and that they are host now');

  // ---- the remaining player carries on alone and gets a normal results screen ----
  check(await inRace(guest), 'the remaining player is still racing');
  await drive(guest, { skill: 1, stopWhen: resultsShown(guest) });
  const rows = await tableRows(guest);
  console.log(rows);
  check(rows.length === 2, 'results list both drivers');
  check(rows[0][1] === 'Guesty' && /^\d:\d\d\.\d{3}$/.test(rows[0][2]), 'the finisher is first with a race time');
  check(rows[1][1] === 'Hostie (나감)' && rows[1][2] === 'DNF' && rows[1][0] === '–', 'the leaver is listed last as DNF with no time');
  check(await visible(guest, '#btn-back'), 'the new host gets the back-to-lobby button');
  await guest.click('#btn-back');
  await lobbyPlayers(guest, 1);
  check(!(await guest.$eval('#btn-start', (el) => el.disabled)), 'the new host can start a race on their own');

  // ---- rejoin, race again, leave from the results screen ----
  check((await text(guest, '#lobby-code')) === code, 'the room is still there');
  await host.type('#code', code);
  await host.click('#btn-join');
  await lobbyPlayers(guest, 2);
  await host.click('#btn-ready');
  await guest.waitForFunction(() => !document.getElementById('btn-start').disabled);
  await guest.click('#btn-start');
  await Promise.all([host, guest].map((p) => p.waitForFunction(() => !document.getElementById('hud').hidden)));
  await Promise.all([
    drive(host, { skill: 1, stopWhen: resultsShown(host) }),
    drive(guest, { skill: 0.85, stopWhen: resultsShown(guest) }),
  ]);
  const second = await tableRows(host);
  check(second.length === 2 && second.every((r) => r[2] !== 'DNF'), 'a normal two-driver race again, nobody DNF');

  await host.click('#btn-leave');
  check(await visible(host, '#screen-start') && !(await visible(host, '#confirm')), 'leaving from the results screen needs no confirmation');
  await guest.waitForFunction(() => document.getElementById('toast').textContent.includes('Hostie'));
  check(true, 'the other player is told');
  check(!(await guest.$eval('#btn-back', (el) => el.hidden)), 'the host still has the back-to-lobby button');

  // ---- last player leaves in the middle of a race: the room is closed ----
  await guest.click('#btn-back');
  await lobbyPlayers(guest, 1);
  await guest.click('#btn-start');
  await guest.waitForFunction(() => !document.getElementById('hud').hidden);
  await guest.click('#btn-quit');
  await guest.click('#confirm-yes');
  await sleep(300);
  check(game.rooms.size === 0, 'when the last player leaves, the room is removed on the server');

  check(errors.length === 0, `no browser errors (${errors.join(' | ') || 'none'})`);
  console.log('\nAll leave checks passed.');
} catch (err) {
  console.error(err.message);
  console.error('Browser errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  await game.close();
}
