// Room and race logic. Independent of the network layer: players are objects with a send(msg) function,
// and the clock is injected, so the whole race flow can be unit-tested with a fake clock.

import {
  MAX_PLAYERS, LAPS, COUNTDOWN_MS, FINISH_GRACE_MS, CAR_COLORS,
  sanitizeNick, isFiniteNum,
} from '../shared/protocol.js';
import { getTrack } from '../shared/tracks.js';
import { createProgress, advanceProgress, gridSlot } from '../shared/race.js';
import { CAR } from '../shared/physics.js';
import { SPEED_SCALE } from '../shared/scale.js';

// Fastest a car can legitimately advance, with headroom for network jitter (follows the world scale).
const MAX_SPEED_FOR_CHECKS = CAR.maxSpeed * 1.4;
const ADVANCE_SLACK = 40 * SPEED_SCALE;

export class Room {
  constructor({ code, now = Date.now, laps = LAPS, onEmpty = () => {} }) {
    this.code = code;
    this.now = now;
    this.laps = laps;
    this.onEmpty = onEmpty;
    this.players = new Map();
    this.hostId = null;
    this.trackId = 'monza';
    this.phase = 'lobby'; // lobby | racing | results
    this.race = null;
    this.nextId = 1;
  }

  // ---- membership -------------------------------------------------------

  addPlayer(send, rawNick) {
    if (this.players.size >= MAX_PLAYERS) return { error: '방이 가득 찼어요 (최대 8명)' };
    if (this.phase === 'racing') return { error: '레이스가 이미 진행 중이에요' };
    const nick = sanitizeNick(rawNick) || `Driver${this.nextId}`;
    const id = this.nextId++;
    const used = new Set([...this.players.values()].map((p) => p.color));
    const color = CAR_COLORS.find((c) => !used.has(c)) ?? CAR_COLORS[id % CAR_COLORS.length];
    const player = { id, nick: this.uniqueNick(nick), color, ready: false, send, rs: null };
    this.players.set(id, player);
    if (this.hostId == null) this.hostId = id;
    this.broadcastRoom();
    return { id, player };
  }

  uniqueNick(nick) {
    const taken = new Set([...this.players.values()].map((p) => p.nick));
    if (!taken.has(nick)) return nick;
    for (let i = 2; i < 100; i++) {
      const candidate = `${Array.from(nick).slice(0, 10).join('')}${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    return nick;
  }

  // Called when a player leaves on purpose or their connection drops. During a race the player is kept in
  // the final results (as DNF, or with their time if they had already finished), and the others carry on.
  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);

    const racing = this.phase === 'racing' && p.rs;
    if (racing) this.race.leavers.push({ ...this.resultRow(p), left: true });
    if (this.players.size === 0) {
      this.onEmpty();
      return;
    }

    const hostChanged = this.hostId === id;
    if (hostChanged) this.hostId = this.players.keys().next().value;
    this.broadcast({
      t: 'left',
      id,
      nick: p.nick,
      color: p.color,
      dnf: !!racing && !p.rs.finished,
      total: racing ? Math.round(p.rs.prog.total) : 0,
      hostId: this.hostId,
      hostChanged,
    });
    this.broadcastRoom();
    if (this.phase === 'racing') this.checkRaceEnd();
  }

  // ---- messages ---------------------------------------------------------

  handle(id, msg) {
    const p = this.players.get(id);
    if (!p || typeof msg !== 'object' || msg === null) return;
    switch (msg.t) {
      case 's': this.onState(p, msg); break;
      case 'track':
        if (id === this.hostId && this.phase === 'lobby' && getTrack(msg.id)) {
          this.trackId = msg.id;
          for (const q of this.players.values()) q.ready = false;
          this.broadcastRoom();
        }
        break;
      case 'ready':
        if (this.phase === 'lobby') {
          p.ready = !!msg.ready;
          this.broadcastRoom();
        }
        break;
      case 'start': this.start(p); break;
      case 'lobby':
        if (id === this.hostId && this.phase === 'results') {
          this.phase = 'lobby';
          this.race = null;
          for (const q of this.players.values()) { q.ready = false; q.rs = null; }
          this.broadcastRoom();
        }
        break;
      default: break;
    }
  }

  // ---- race -------------------------------------------------------------

  start(p) {
    if (p.id !== this.hostId || this.phase !== 'lobby') return;
    const others = [...this.players.values()].filter((q) => q.id !== this.hostId);
    if (!others.every((q) => q.ready)) return;

    const track = getTrack(this.trackId);
    const startAt = this.now() + COUNTDOWN_MS;
    const grid = [];
    let slot = 0;
    for (const q of this.players.values()) {
      const g = gridSlot(track, slot++);
      grid.push({ id: q.id, x: g.x, y: g.y, a: g.a });
      q.rs = {
        prog: createProgress(track, g.s),
        lastT: startAt,
        lapsDone: 0,
        lapStart: startAt,
        lapTimes: [],
        finished: false,
        finishTime: null,
        place: null,
        pos: { x: g.x, y: g.y, a: g.a, v: 0 },
      };
    }
    this.phase = 'racing';
    this.race = { track, startAt, finishedCount: 0, firstFinishAt: null, grid, leavers: [] };
    this.broadcast({
      t: 'go', track: this.trackId, laps: this.laps, startAt, serverNow: this.now(), grid,
    });
  }

  onState(p, msg) {
    if (this.phase !== 'racing' || !p.rs || p.rs.finished) return;
    if (![msg.x, msg.y, msg.a, msg.v].every((n) => isFiniteNum(n))) return;
    const { track, startAt } = this.race;
    const rs = p.rs;
    const recv = this.now();
    const claimed = isFiniteNum(msg.ts, 1e15) ? msg.ts : recv;
    const t = Math.min(Math.max(claimed, rs.lastT), recv);
    rs.pos = { x: msg.x, y: msg.y, a: msg.a, v: msg.v };
    if (t <= startAt) return; // no progress before the lights go out

    const dt = Math.max(t - rs.lastT, 50) / 1000;
    const before = rs.prog.total;
    const { dist } = advanceProgress(track, rs.prog, msg.x, msg.y, {
      win: 40,
      maxAdvance: MAX_SPEED_FOR_CHECKS * dt + ADVANCE_SLACK,
    });
    if (dist > track.width * 3) {
      // Far from the circuit: undo, the report is bogus.
      rs.prog.total = before;
      return;
    }
    const prevT = rs.lastT;
    rs.lastT = t;

    const lapsNow = Math.max(0, Math.floor(rs.prog.total / track.L));
    while (rs.lapsDone < lapsNow && !rs.finished) {
      rs.lapsDone++;
      const target = rs.lapsDone * track.L;
      const span = rs.prog.total - before || 1;
      const frac = Math.min(1, Math.max(0, (target - before) / span));
      const tCross = prevT + (t - prevT) * frac;
      rs.lapTimes.push(tCross - rs.lapStart);
      rs.lapStart = tCross;
      if (rs.lapsDone >= this.laps) this.finishPlayer(p, tCross);
    }
  }

  finishPlayer(p, tCross) {
    const rs = p.rs;
    rs.finished = true;
    rs.finishTime = tCross - this.race.startAt;
    rs.place = ++this.race.finishedCount;
    if (this.race.firstFinishAt == null) this.race.firstFinishAt = this.now();
    this.broadcast({
      t: 'fin', id: p.id, place: rs.place, time: Math.round(rs.finishTime), laps: rs.lapTimes.map(Math.round),
    });
    this.checkRaceEnd();
  }

  checkRaceEnd() {
    if (this.phase !== 'racing') return;
    const all = [...this.players.values()];
    if (all.every((p) => !p.rs || p.rs.finished)) this.finishRace();
  }

  tick() {
    if (this.phase !== 'racing') return;
    const now = this.now();
    if (this.race.firstFinishAt != null && now - this.race.firstFinishAt > FINISH_GRACE_MS) {
      this.finishRace();
      return;
    }
    this.broadcast({
      t: 'snap',
      st: now,
      // Rounded to keep each snapshot small now that it goes out SNAP_HZ times a second: a whole world
      // unit and a hundredth of a radian are both far finer than a car's own size, so nothing visible
      // is lost, and the shorter numbers matter more at this frequency than they did at 20 Hz.
      cars: [...this.players.values()].filter((p) => p.rs).map((p) => ({
        id: p.id,
        x: Math.round(p.rs.pos.x),
        y: Math.round(p.rs.pos.y),
        a: Math.round(p.rs.pos.a * 100) / 100,
        v: Math.round(p.rs.pos.v),
        tot: Math.round(p.rs.prog.total),
      })),
    });
  }

  resultRow(p) {
    return {
      id: p.id,
      nick: p.nick,
      color: p.color,
      finished: p.rs.finished,
      time: p.rs.finished ? Math.round(p.rs.finishTime) : null,
      best: p.rs.lapTimes.length ? Math.round(Math.min(...p.rs.lapTimes)) : null,
      total: p.rs.prog.total,
    };
  }

  // Order: finishers by time, then drivers still on track when the race was called by distance covered,
  // then anyone who left without finishing (DNF) by distance covered.
  finishRace() {
    if (this.phase !== 'racing') return;
    this.phase = 'results';
    const rows = [
      ...[...this.players.values()].filter((p) => p.rs).map((p) => this.resultRow(p)),
      ...this.race.leavers,
    ];
    const rank = (r) => (r.finished ? 0 : r.left ? 2 : 1);
    rows.sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return a.finished ? a.time - b.time : b.total - a.total;
    });
    rows.forEach((r, i) => { r.place = i + 1; delete r.total; });
    this.broadcast({ t: 'results', rows, laps: this.laps });
  }

  // ---- output -----------------------------------------------------------

  roomState() {
    return {
      t: 'room',
      code: this.code,
      hostId: this.hostId,
      track: this.trackId,
      phase: this.phase,
      laps: this.laps,
      players: [...this.players.values()].map((p) => ({
        id: p.id, nick: p.nick, color: p.color, ready: p.ready,
      })),
    };
  }

  broadcastRoom() {
    this.broadcast(this.roomState());
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) p.send(data);
  }
}
