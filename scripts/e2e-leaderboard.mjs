// End-to-end check of the lobby's TOP5 lap-time leaderboard in real (headless) Chrome: the empty-track
// message, a finished race landing on the board, the same nickname never taking two rows, the board
// updating live for every player in the room the moment the host switches tracks, and the layout
// stacking to one column at a narrow viewport.
// Usage: node scripts/e2e-leaderboard.mjs   (needs Google Chrome; set CHROME_PATH if it lives elsewhere)

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
const lbRows = (p) => p.$$eval('#lb-table tbody tr', (trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent)));
const lbEmptyShown = (p) => p.$eval('#lb-empty', (el) => !el.hidden);

try {
  // ---- a track with no record yet shows the empty-state message, not a blank table ----
  const solo = await newPlayer('solo');
  await solo.goto(`${base}/?debug&q=3`);
  await solo.type('#nick', 'Fast');
  await solo.click('#btn-create');
  await solo.waitForFunction(() => document.getElementById('lobby-code').textContent.length === 4);
  const code = await solo.$eval('#lobby-code', (el) => el.textContent);
  await solo.click('.track[data-id="monaco"]');
  await solo.waitForFunction(() => document.querySelector('.track.selected')?.dataset.id === 'monaco');
  check(await lbEmptyShown(solo), 'an untouched track shows "아직 기록이 없어요"');
  check((await lbRows(solo)).length === 0, 'and no table rows');

  // ---- finishing a race on that track lands the driver on the board ----
  await solo.waitForFunction(() => !document.getElementById('btn-start').disabled);
  await solo.click('#btn-start');
  await drive(solo, { skill: 1, stopWhen: resultsShown(solo) });
  await solo.click('#btn-back');
  await solo.waitForFunction(() => !document.getElementById('screen-lobby').hidden);
  await solo.waitForFunction(() => document.querySelectorAll('#lb-table tbody tr').length === 1, { timeout: 5000 });
  check(!(await lbEmptyShown(solo)), 'the empty-state message is gone once there is a record');
  let rows = await lbRows(solo);
  check(rows[0][0] === '🥇' && rows[0][1] === 'Fast', `#1 is the finisher, gold medal (got ${JSON.stringify(rows[0])})`);
  check(/^\d+:\d{2}\.\d{3}$/.test(rows[0][2]), `the time is formatted m:ss.mmm (got ${rows[0][2]})`);

  // ---- the same nickname racing again never takes a second row ----
  await solo.waitForFunction(() => !document.getElementById('btn-start').disabled);
  await solo.click('#btn-start');
  await drive(solo, { skill: 0.8, stopWhen: resultsShown(solo) }); // likely slower; dedup must hold either way
  await solo.click('#btn-back');
  await solo.waitForFunction(() => !document.getElementById('screen-lobby').hidden);
  await sleep(300);
  rows = await lbRows(solo);
  check(rows.length === 1, `the same nick running twice still leaves one row (got ${rows.length})`);
  check(rows[0][1] === 'Fast', 'still that same driver');

  // ---- a second player in the room sees the same board, and sees it update the instant the host
  //      switches tracks (no record yet on the new one) ----
  const guest = await newPlayer('guest');
  await guest.goto(`${base}/?room=${code}&debug&q=3`);
  await guest.type('#nick', 'Watcher');
  await guest.click('#btn-join');
  await solo.waitForFunction(() => document.querySelectorAll('#plist li').length === 2);
  await guest.waitForFunction(() => document.querySelectorAll('#lb-table tbody tr').length === 1);
  check((await lbRows(guest))[0][1] === 'Fast', "the guest sees the host's track leaderboard on joining");

  await solo.click('.track[data-id="suzuka"]');
  await guest.waitForFunction(() => document.getElementById('lb-empty').hidden === false, { timeout: 5000 });
  check(await lbEmptyShown(guest), 'switching to a fresh track shows "아직 기록이 없어요" for the guest too, live');
  check(await lbEmptyShown(solo), 'and for the host who switched it');

  // ---- narrow viewport: the leaderboard stacks below instead of breaking the layout ----
  const wideCols = await solo.$eval('.lobby-layout', (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  check(wideCols >= 2, `wide viewport shows two layout columns (got ${wideCols})`);
  await solo.setViewport({ width: 480, height: 800 });
  await sleep(150);
  const narrowCols = await solo.$eval('.lobby-layout', (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  check(narrowCols === 1, `narrow viewport collapses to one column (got ${narrowCols})`);

  check(errors.length === 0, `no browser errors (${errors.join(' | ') || 'none'})`);
  console.log('\nAll leaderboard checks passed.');
} catch (err) {
  console.error(err.message);
  console.error('Browser errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  await game.close();
}
