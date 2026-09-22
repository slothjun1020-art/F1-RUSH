// Checks that a public address (for example a Cloudflare quick tunnel) really serves the game:
// the page, the Three.js bundle, and a full create/join over secure WebSocket.
// Usage: node scripts/tunnel-check.mjs https://something.trycloudflare.com

import { WebSocket } from 'ws';

const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('Usage: node scripts/tunnel-check.mjs https://your-address');
  process.exit(1);
}

// A fresh tunnel needs a few seconds before its name resolves, so retry for a while.
async function get(path, tries = 15) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(base + path);
      return { status: r.status, type: r.headers.get('content-type'), text: await r.text() };
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(`not reachable: ${path}`);
}

const wait = async (fn, ms = 8000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for the server');
};

const open = (nick, msg) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
  const inbox = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  ws.on('open', () => { ws.send(JSON.stringify({ ...msg, nick })); resolve({ ws, inbox }); });
  ws.on('error', reject);
});

try {
  const health = await get('/healthz');
  console.log(`ok  /healthz -> ${health.status} ${health.text}`);
  const page = await get('/');
  console.log(`ok  game page -> ${page.status} ${page.text.includes('F1 Rush') ? '(F1 Rush)' : '(UNEXPECTED CONTENT)'}`);
  const three = await get('/vendor/three/three.module.js');
  console.log(`ok  3D library -> ${three.status}, ${Math.round(three.text.length / 1024)} KB`);

  const host = await open('Check-Host', { t: 'create' });
  const room = await wait(() => host.inbox.find((m) => m.t === 'room'));
  console.log(`ok  room created over WebSocket, code ${room.code}`);
  const guest = await open('Check-Guest', { t: 'join', code: room.code });
  await wait(() => host.inbox.find((m) => m.t === 'room' && m.players.length === 2));
  console.log('ok  a second player joined the room: 2 players');
  guest.ws.send(JSON.stringify({ t: 'ping', c: 1 }));
  await wait(() => guest.inbox.find((m) => m.t === 'pong'));
  console.log('ok  clock sync round trip works');
  host.ws.close();
  guest.ws.close();
  console.log('\nThe address works for playing.');
} catch (err) {
  console.error(`FAILED: ${err.message}`);
  process.exitCode = 1;
}
