// End-to-end check of the two different "나가기"s in real (headless) Chrome:
//   - the in-race HUD "나가기" (quitRace()): confirmation dialog, DNF but STAYS in the room and lands
//     back in its own lobby view, host hand-over if the quitter was host, others keep racing, and the
//     "모두 로비로 돌려보내기" escape hatch for a quitting host who would otherwise never reach the
//     results screen's own back-to-lobby button.
//   - "방 나가기" (the lobby header) and the results screen's "나가기": an actual departure, straight back
//     to the start screen, no confirmation needed — the old behaviour, just moved off the race HUD.
// Runs at the lowest 3D quality (?q=3) so software WebGL keeps up.
// Usage: node scripts/e2e-leave.mjs   (needs Google Chrome; set CHROME_PATH if it lives elsewhere)

import { createGameServer } from '../server/index.js';
import { launchBrowser, drive, sleep, fakeGhostsStore } from './browser-helpers.mjs';

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
  check((await text(host, '#confirm')).includes('DNF로 처리돼요'), 'the dialog warns the race will be scored as a DNF');
  check((await host.evaluate(() => document.activeElement?.id)) === 'confirm-no', 'focus is on the safe "continue" button, never on the HUD button');
  await host.keyboard.press('Escape');
  check(!(await visible(host, '#confirm')) && await inRace(host), 'Escape cancels and the race goes on');
  check((await host.evaluate(() => document.activeElement?.tagName)) === 'BODY', 'no button keeps keyboard focus after cancelling');
  await host.keyboard.press('Space');
  await sleep(150);
  check(!(await visible(host, '#confirm')), 'Space (brake) does not open or trigger the leave dialog');

  // ---- the host quits the race on purpose: DNF, but stays in the room (unlike actually leaving) ----
  await host.click('#btn-quit');
  await host.click('#confirm-yes');
  check(await visible(host, '#screen-lobby') && !(await visible(host, '#hud')), "quitting lands the quitter back in the room's own lobby view");
  check(!(await inRace(host)), 'the quitter is done driving for this race');
  check((await text(host, '#lobby-code')) === code, 'unlike actually leaving, they are still looking at this room — they never left it');

  // ---- what the guest (now sole driver, and new host) sees ----
  await guest.waitForFunction(() => document.querySelector('#hud-board li.dnf'));
  const dnfRow = await text(guest, '#hud-board li.dnf');
  check(dnfRow.includes('Hostie') && dnfRow.includes('DNF'), `the quitter stays on the leaderboard as DNF (${dnfRow})`);
  check((await text(guest, '#hud-pos')) === '1/1', 'position counts only the drivers still racing');
  const note = await text(guest, '#toast');
  check(note.includes('Hostie') && note.includes('나갔어요') && note.includes('방장'), `the guest is told Hostie left the race and that they are host now (got: ${note})`);
  check(await inRace(guest), 'the remaining player is still racing');

  // ---- the quitting (now ex-) host's own lobby view, while the guest is still racing ----
  check((await text(host, '#lobby-hint')).includes('레이스 중'), 'the quitter sees that a race is still going on without them');
  check(await host.$eval('#btn-back-lobby', (el) => el.hidden), 'no escape-hatch button needed — they are not host any more');
  check(await host.$eval('#btn-start', (el) => el.hidden), 'not host any more, so no start button either');

  // ---- the guest finishes alone; results mark Hostie DNF, with no "(나감)" — they never left the room ----
  await drive(guest, { skill: 1, stopWhen: resultsShown(guest) });
  const rows = await tableRows(guest);
  check(rows.length === 2, 'results list both drivers');
  check(rows[0][1] === 'Guesty' && /^\d:\d\d\.\d{3}$/.test(rows[0][2]), 'the finisher is first with a race time');
  check(rows[1][1] === 'Hostie' && rows[1][2] === 'DNF' && rows[1][0] === '–', `the quitter is listed DNF, plain nickname, no "(나감)" (got ${JSON.stringify(rows[1])})`);
  check(await visible(guest, '#btn-back'), 'the new host gets the back-to-lobby button');

  // ---- the quitter is never pulled onto the results screen for a race they already left ----
  await host.waitForFunction(() => document.getElementById('lobby-hint').textContent.includes('방장이'));
  check(!(await visible(host, '#screen-results')), 'still looking at the lobby, not the results screen');

  await guest.click('#btn-back');
  await lobbyPlayers(host, 2);
  check(!(await host.$eval('#btn-ready', (el) => el.hidden)), 'back in a real lobby: the ex-host can ready up like anyone else');

  // ---- "방 나가기": the lobby button that actually leaves the room ----
  await host.click('#btn-leave-room');
  check(await visible(host, '#screen-start'), '"방 나가기" sends the quitter back to the real start screen, out of the room');
  await guest.waitForFunction(() => document.getElementById('toast').textContent.includes('Hostie'));
  check(true, 'the guest is told Hostie actually left this time');
  await lobbyPlayers(guest, 1);

  // ---- a solo quit: no one to hand the host role to, so the lobby itself offers the way back ----
  await guest.click('#btn-start');
  await guest.waitForFunction(() => !document.getElementById('hud').hidden);
  await guest.click('#btn-quit');
  await guest.click('#confirm-yes');
  check(await visible(guest, '#screen-lobby'), 'solo quit also lands back in the lobby view');
  await guest.waitForFunction(() => !document.getElementById('btn-back-lobby').hidden);
  check((await text(guest, '#lobby-hint')).includes('모두를 로비로'), 'the hint explains the escape-hatch button');
  await guest.click('#btn-back-lobby');
  await guest.waitForFunction(() => !document.getElementById('btn-start').disabled);
  check(true, 'back in a normal lobby, able to start again');

  // ---- leaving from the results screen still needs no confirmation (unchanged) ----
  await guest.click('#btn-start');
  await drive(guest, { skill: 1, stopWhen: resultsShown(guest) });
  await guest.click('#btn-leave');
  check(await visible(guest, '#screen-start') && !(await visible(guest, '#confirm')), 'leaving from the results screen needs no confirmation');
  check(game.rooms.size === 0, 'the last player leaving (for real) closes the room');

  check(errors.length === 0, `no browser errors (${errors.join(' | ') || 'none'})`);
  console.log('\nAll leave/quit checks passed.');
} catch (err) {
  console.error(err.message);
  console.error('Browser errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  await game.close();
}
