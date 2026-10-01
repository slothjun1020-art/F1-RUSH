// Shared helpers for the browser scripts (e2e.mjs, shots3d.mjs): launch Chrome with software WebGL,
// and drive the player's car through real keyboard events using the bot from shared/bot.js.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

// A fresh, isolated ghost-records file for a test server, so finishing a race in one script run never
// writes to (or is affected by) the real repo's data/ghosts.json or another script's run.
export function tmpGhostsPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'f1-ghosts-')), 'ghosts.json');
}

export function findChrome() {
  const found = process.env.CHROME_PATH ?? [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((p) => fs.existsSync(p));
  if (!found) throw new Error('Chrome not found; set CHROME_PATH');
  return found;
}

// SwiftShader gives headless Chrome a software WebGL implementation, so 3D works without a GPU.
export function launchBrowser() {
  return puppeteer.launch({
    executablePath: findChrome(),
    headless: 'new',
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function keySync(page) {
  const down = new Set();
  return async (inp) => {
    const want = new Set();
    if (inp.throttle) want.add('ArrowUp');
    if (inp.brake) want.add('ArrowDown');
    if (inp.steer < -0.25) want.add('ArrowLeft');
    if (inp.steer > 0.25) want.add('ArrowRight');
    for (const k of [...down]) if (!want.has(k)) { await page.keyboard.up(k); down.delete(k); }
    for (const k of want) if (!down.has(k)) { await page.keyboard.down(k); down.add(k); }
  };
}

// Needs the page to be opened with ?debug so window.__f1.race is available.
export async function drive(page, { skill = 1, stopWhen, onTick, timeoutMs = 240000 }) {
  await page.evaluate(async () => {
    const { botInput } = await import('/shared/bot.js');
    window.__bot = () => {
      const r = window.__f1.race;
      return r ? botInput(r.car, r.track) : { throttle: 0, brake: 0, steer: 0 };
    };
  });
  const sync = keySync(page);
  const deadline = Date.now() + timeoutMs;
  let tick = 0;
  while (!(await stopWhen(tick))) {
    if (Date.now() > deadline) throw new Error('driver timed out');
    const inp = await page.evaluate(() => window.__bot());
    if (skill < 1 && tick % 6 === 5) inp.throttle = 0;   // a slightly slower driver
    await sync(inp);
    await onTick?.(tick);
    tick++;
    await sleep(30);
  }
  await sync({ throttle: 0, brake: 0, steer: 0 });
}
