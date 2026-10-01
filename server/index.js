import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { Room } from './rooms.js';
import { GhostStore } from './ghosts.js';
import {
  CODE_ALPHABET, CODE_LENGTH, SNAP_HZ, normalizeCode, isValidCode,
} from '../shared/protocol.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createGameServer({
  now = Date.now, laps, ghostsPath = path.join(root, 'data', 'ghosts.json'),
} = {}) {
  const ghosts = new GhostStore({ filePath: ghostsPath });
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => res.type('text').send('ok'));
  app.use('/shared', express.static(path.join(root, 'shared')));
  // Only Three.js's build folder is exposed (not the rest of node_modules).
  app.use('/vendor/three', express.static(path.join(root, 'node_modules', 'three', 'build')));
  app.use(express.static(path.join(root, 'public')));

  const server = http.createServer(app);
  // Cars are small, frequent JSON messages: TCP's Nagle algorithm would otherwise hold them back for
  // tens of milliseconds waiting to coalesce with the next one, and permessage-deflate compression
  // costs more CPU time than it saves bytes on payloads this small. Both only add latency here.
  server.on('connection', (socket) => socket.setNoDelay(true));
  const wss = new WebSocketServer({
    server, path: '/ws', maxPayload: 2048, perMessageDeflate: false,
  });
  const rooms = new Map();

  function newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      if (!rooms.has(code)) return code;
    }
  }

  function createRoom() {
    const code = newCode();
    const room = new Room({
      code, now, laps, ghosts, onEmpty: () => rooms.delete(code),
    });
    rooms.set(code, room);
    return room;
  }

  wss.on('connection', (ws) => {
    let room = null;
    let playerId = null;
    let alive = true;
    let tokens = 60;
    const refill = setInterval(() => { tokens = Math.min(60, tokens + 30); }, 500);
    const send = (data) => { if (ws.readyState === ws.OPEN) ws.send(data); };
    const reply = (obj) => send(JSON.stringify(obj));

    ws.on('pong', () => { alive = true; });

    ws.on('message', (raw) => {
      if (--tokens < 0) return; // flood protection
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (typeof msg !== 'object' || msg === null || typeof msg.t !== 'string') return;

      if (msg.t === 'ping') {
        reply({ t: 'pong', c: msg.c, s: now() });
        return;
      }

      if (room == null) {
        if (msg.t !== 'create' && msg.t !== 'join') return;
        let target;
        if (msg.t === 'create') {
          target = createRoom();
        } else {
          const code = normalizeCode(msg.code);
          target = isValidCode(code) ? rooms.get(code) : null;
          if (!target) { reply({ t: 'err', msg: '방을 찾을 수 없어요. 코드를 확인해 주세요' }); return; }
        }
        const res = target.addPlayer(send, msg.nick);
        if (res.error) {
          reply({ t: 'err', msg: res.error });
          if (msg.t === 'create') rooms.delete(target.code);
          return;
        }
        room = target;
        playerId = res.id;
        reply({ t: 'welcome', id: playerId });
        room.broadcastRoom();
        return;
      }
      room.handle(playerId, msg);
    });

    ws.on('close', () => {
      clearInterval(refill);
      if (room) room.removePlayer(playerId);
    });
    ws.on('error', () => ws.terminate());

    ws.heartbeat = () => {
      if (!alive) { ws.terminate(); return; }
      alive = false;
      ws.ping();
    };
  });

  const snapTimer = setInterval(() => { for (const r of rooms.values()) r.tick(); }, 1000 / SNAP_HZ);
  const beatTimer = setInterval(() => { for (const ws of wss.clients) ws.heartbeat?.(); }, 15000);

  return {
    server,
    rooms,
    ghosts,
    close() {
      clearInterval(snapTimer);
      clearInterval(beatTimer);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const game = createGameServer();
  game.server.listen(port, () => {
    console.log(`F1 Race server running: http://localhost:${port}`);
  });
}
