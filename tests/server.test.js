import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createGameServer } from '../server/index.js';

async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    inbox.push(msg);
    for (const w of [...waiters]) w();
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const waitFor = (pred, ms = 2000) => new Promise((resolve, reject) => {
    const check = () => {
      const hit = inbox.find(pred);
      if (hit) { waiters.splice(waiters.indexOf(check), 1); clearTimeout(timer); resolve(hit); return true; }
      return false;
    };
    const timer = setTimeout(() => reject(new Error('timeout waiting for message')), ms);
    if (!check()) waiters.push(check);
  });
  return { ws, inbox, waitFor, send: (o) => ws.send(JSON.stringify(o)) };
}

test('websocket smoke: create, join, ready, start, clock ping', async () => {
  const game = createGameServer();
  await new Promise((r) => game.server.listen(0, '127.0.0.1', r));
  const { port } = game.server.address();
  try {
    const host = await connect(port);
    host.send({ t: 'create', nick: 'Host' });
    const welcome = await host.waitFor((m) => m.t === 'welcome');
    const room = await host.waitFor((m) => m.t === 'room');
    assert.match(room.code, /^[A-Z2-9]{4}$/);
    assert.equal(room.hostId, welcome.id);

    const guest = await connect(port);
    guest.send({ t: 'join', code: room.code.toLowerCase(), nick: 'Guest' });
    await guest.waitFor((m) => m.t === 'welcome');
    await host.waitFor((m) => m.t === 'room' && m.players.length === 2);

    guest.send({ t: 'ready', ready: true });
    await host.waitFor((m) => m.t === 'room' && m.players.some((p) => p.ready));
    host.send({ t: 'start' });
    const go = await guest.waitFor((m) => m.t === 'go');
    assert.equal(go.grid.length, 2);

    guest.send({ t: 'ping', c: 42 });
    const pong = await guest.waitFor((m) => m.t === 'pong');
    assert.equal(pong.c, 42);
    assert.ok(Math.abs(pong.s - Date.now()) < 2000);

    const stranger = await connect(port);
    stranger.send({ t: 'join', code: 'ZZZZ', nick: 'Nobody' });
    const err = await stranger.waitFor((m) => m.t === 'err');
    assert.ok(err.msg);

    // Leaving empties the room.
    host.ws.close();
    guest.ws.close();
    stranger.ws.close();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(game.rooms.size, 0);
  } finally {
    await game.close();
  }
});

test('low-latency socket options: Nagle is disabled and permessage-deflate is off', async () => {
  const game = createGameServer();
  await new Promise((r) => game.server.listen(0, '127.0.0.1', r));
  const { port } = game.server.address();
  try {
    // The server calls socket.setNoDelay(true) on every raw connection (see server/index.js). Node
    // offers no way to read TCP_NODELAY back off a real socket, so instead call our specific listener
    // directly with a minimal fake socket, rather than emitting 'connection' on the real http.Server
    // (which would also run Node's own internal HTTP connection handling and needs a full socket).
    const ours = game.server.listeners('connection').find((fn) => fn.toString().includes('setNoDelay'));
    assert.ok(ours, 'a connection listener calling setNoDelay was registered');
    const calls = [];
    ours({ setNoDelay: (v) => calls.push(v) });
    assert.deepEqual(calls, [true]);

    // permessage-deflate: connect offering compression and check the server did not accept it.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { perMessageDeflate: true });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    assert.ok(!String(ws.extensions).includes('permessage-deflate'), `permessage-deflate should not be negotiated, got ${JSON.stringify(ws.extensions)}`);
    ws.close();
  } finally {
    await game.close();
  }
});
