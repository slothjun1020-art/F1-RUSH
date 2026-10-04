// Room and race logic. Independent of the network layer: players are objects with a send(msg) function,
// and the clock is injected, so the whole race flow can be unit-tested with a fake clock.

import {
  MAX_PLAYERS, LAPS, COUNTDOWN_MS, FINISH_GRACE_MS, CAR_COLORS,
  sanitizeNick, isFiniteNum,
} from '../shared/protocol.js';
import { getTrack } from '../shared/tracks.js';
import { createProgress, advanceProgress, gridSlot } from '../shared/race.js';
import { CAR, wearRate } from '../shared/physics.js';
import { SPEED_SCALE } from '../shared/scale.js';

// Fastest a car can legitimately advance, with headroom for network jitter (follows the world scale).
const MAX_SPEED_FOR_CHECKS = CAR.maxSpeed * 1.4;
const ADVANCE_SLACK = 40 * SPEED_SCALE;

// How often (ms of race time) a car's position is sampled for the best-lap ghost trail. Used only by
// solo races with a saved record for the track (see start() and public/ghost.js, which replays it).
const GHOST_SAMPLE_MS = 100;

// Stands in for a real GhostStore (server/ghosts.js) when a Room isn't given one, so ghosts are simply
// never recorded or offered — existing callers/tests that don't care about ghosts need no changes.
const NULL_GHOSTS = { get: () => undefined, top5: () => [], maybeUpdate: () => false };

export class Room {
  constructor({
    code, now = Date.now, laps = LAPS, onEmpty = () => {}, ghosts = NULL_GHOSTS,
  }) {
    this.code = code;
    this.now = now;
    this.laps = laps;
    this.onEmpty = onEmpty;
    this.ghosts = ghosts;
    this.players = new Map();
    this.hostId = null;
    this.trackId = 'monza';
    this.collisions = false; // bumper-car style pushback between cars; off = the old ghost (pass-through) cars
    this.gearMode = false;   // 8-speed semi-automatic sequential gearbox; off = today's automatic model
    this.tireWear = false;   // grass/kerb tire wear with an accel penalty and a 100%-wear DNF; off = no wear at all
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
      case 'collisions':
        if (id === this.hostId && this.phase === 'lobby') {
          this.collisions = !!msg.on;
          for (const q of this.players.values()) q.ready = false;
          this.broadcastRoom();
        }
        break;
      case 'gear':
        if (id === this.hostId && this.phase === 'lobby') {
          this.gearMode = !!msg.on;
          for (const q of this.players.values()) q.ready = false;
          this.broadcastRoom();
        }
        break;
      case 'tirewear':
        if (id === this.hostId && this.phase === 'lobby') {
          this.tireWear = !!msg.on;
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
        // Best-lap ghost recording (see onState/recordLapForGhost and finishPlayer below).
        lapSamples: [[0, Math.round(g.x), Math.round(g.y), Math.round(g.a * 100) / 100]],
        lastSampleT: startAt,
        bestLapInRace: null,
        // Tire wear (see onState below). wear is 0..1, computed purely from reported positions — the
        // server stays the sole authority on when a DNF actually happens, same as lap counting.
        wear: 0,
        dnf: false,
      };
    }
    this.phase = 'racing';
    this.race = { track, startAt, finishedCount: 0, firstFinishAt: null, grid, leavers: [] };
    // A ghost only makes sense racing solo (a real opponent would be confusing to tell apart from it,
    // and the point is company when there's no one else) — and only once this track has a record.
    const ghostRecord = this.players.size === 1 ? this.ghosts.get(this.trackId) : null;
    this.broadcast({
      t: 'go', track: this.trackId, laps: this.laps, startAt, serverNow: this.now(), grid,
      collisions: this.collisions, gearMode: this.gearMode, tireWear: this.tireWear,
      ghost: ghostRecord ? { nick: ghostRecord.nick, time: ghostRecord.time, path: ghostRecord.path } : undefined,
    });
  }

  onState(p, msg) {
    if (this.phase !== 'racing' || !p.rs || p.rs.finished || p.rs.dnf) return;
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

    if (this.tireWear) {
      rs.wear = Math.min(1, rs.wear + wearRate(dist, track) * dt);
      if (rs.wear >= 1) { this.dnfPlayer(p, t); return; }
    }

    const lapsNow = Math.max(0, Math.floor(rs.prog.total / track.L));
    while (rs.lapsDone < lapsNow && !rs.finished) {
      rs.lapsDone++;
      const target = rs.lapsDone * track.L;
      const span = rs.prog.total - before || 1;
      const frac = Math.min(1, Math.max(0, (target - before) / span));
      const tCross = prevT + (t - prevT) * frac;
      const lapTime = tCross - rs.lapStart;
      rs.lapTimes.push(lapTime);
      this.recordLapForGhost(rs, lapTime);
      rs.lapStart = tCross;
      if (rs.lapsDone >= this.laps) this.finishPlayer(p, tCross);
    }

    // Sample the car's position for the ghost trail of whichever lap is currently in progress (the one
    // that just started, if a crossing just happened above). Throttled to roughly GHOST_SAMPLE_MS of
    // race time, not wall-clock time between messages, so it stays steady regardless of send rate.
    if (t - rs.lastSampleT >= GHOST_SAMPLE_MS) {
      rs.lastSampleT = t;
      rs.lapSamples.push([Math.round(t - rs.lapStart), Math.round(msg.x), Math.round(msg.y), Math.round(msg.a * 100) / 100]);
    }
  }

  // Keeps rs.bestLapInRace as the fastest lap this player has completed so far this race, then starts a
  // fresh trail for the next lap. Called on every lap crossing, including the finishing one.
  recordLapForGhost(rs, lapTime) {
    if (rs.lapSamples.length && (!rs.bestLapInRace || lapTime < rs.bestLapInRace.time)) {
      rs.bestLapInRace = { time: lapTime, path: rs.lapSamples };
    }
    rs.lapSamples = [];
    rs.lastSampleT = -Infinity; // so the next sample (the new lap's first point) is recorded immediately
  }

  finishPlayer(p, tCross) {
    const rs = p.rs;
    rs.finished = true;
    rs.finishTime = tCross - this.race.startAt;
    rs.place = ++this.race.finishedCount;
    if (this.race.firstFinishAt == null) this.race.firstFinishAt = this.now();
    if (rs.bestLapInRace) {
      this.ghosts.maybeUpdate(this.trackId, { nick: p.nick, time: rs.bestLapInRace.time, path: rs.bestLapInRace.path });
    }
    this.broadcast({
      t: 'fin', id: p.id, place: rs.place, time: Math.round(rs.finishTime), laps: rs.lapTimes.map(Math.round),
    });
    this.checkRaceEnd();
  }

  // Tire wear reached 100% (tireWear room setting only — see onState). The player stays connected and in
  // this.players (unlike leaving), so they keep seeing the race — just unable to drive any further, and
  // free to spectate another car — while everyone else is told why they dropped out.
  dnfPlayer(p, t) {
    const rs = p.rs;
    rs.dnf = true;
    rs.dnfTime = t - this.race.startAt;
    this.broadcast({ t: 'dnf', id: p.id, nick: p.nick, reason: 'wear' });
    this.checkRaceEnd();
  }

  checkRaceEnd() {
    if (this.phase !== 'racing') return;
    const all = [...this.players.values()];
    if (all.every((p) => !p.rs || p.rs.finished || p.rs.dnf)) this.finishRace();
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
      dnf: !!p.rs.dnf, // tire-wear DNF specifically — see dnfPlayer(). Leaving the room is tracked separately (this.race.leavers).
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
      collisions: this.collisions,
      gearMode: this.gearMode,
      tireWear: this.tireWear,
      phase: this.phase,
      laps: this.laps,
      players: [...this.players.values()].map((p) => ({
        id: p.id, nick: p.nick, color: p.color, ready: p.ready,
      })),
      // The selected track's leaderboard, for the lobby's TOP5 panel. Riding along on every existing
      // broadcastRoom() call (join, ready, track change, back-to-lobby, …) keeps it live for everyone in
      // the room with zero extra message types.
      top5: this.ghosts.top5(this.trackId),
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
