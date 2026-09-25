// Race controller: runs the local car, interpolates remote cars, and drives the HUD.
// The picture itself is drawn by the 3D renderer (view3d.js, which also owns the camera mode — chase,
// T-cam or helmet-cam); physics, lap tracking and networking here don't depend on which camera is active.

import { createCar, stepCar, GEAR_SPEEDS, worldToKmh } from '/shared/physics.js';
import { advanceProgress, createProgress, lapsCompleted } from '/shared/race.js';
import { locate, pointAt } from '/shared/track-geom.js';
import { SEND_HZ } from '/shared/protocol.js';
import { resolveCollisions } from '/shared/collision.js';
import { readInput, consumeReset, consumeGearShift } from './input.js';
import { drawTrackFit } from './render.js';
import {
  createJitterTracker, recordArrival, stepJitterTracker,
  remotePoseAt, createRemoteSmoother, smoothRemote,
} from './interp.js';

const SHIFT_LIGHT_RATIO = 0.92; // "too fast for this gear" cue once past this fraction of its top speed

const SEND_EVERY = 1000 / SEND_HZ;   // ms between position reports to the server (see shared/protocol.js)
const r1 = (n) => Math.round(n);     // world units are large enough that whole units are plenty precise
const norm = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export function formatTime(ms) {
  if (ms == null) return '--:--.---';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const t = Math.floor(ms % 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(t).padStart(3, '0')}`;
}

export class RaceView {
  constructor({
    renderer, hud, net, track, laps, startAt, grid, meId, players, onLap, onReset,
    gearMode = false, collisions = false, debug = false,
  }) {
    this.renderer = renderer;
    this.hud = hud;
    this.debug = debug;
    this.jitter = createJitterTracker();
    this.fps = { count: 0, acc: 0 };
    this.net = net;
    this.track = track;
    this.laps = laps;
    this.startAt = startAt;
    this.meId = meId;
    this.players = new Map(players.map((p) => [p.id, p]));
    this.onLap = onLap;
    this.onReset = onReset;
    this.gearMode = gearMode;
    this.collisions = collisions;
    this.gear = 1;

    const g = grid.find((x) => x.id === meId) ?? grid[0];
    this.car = createCar(g.x, g.y, g.a, track);
    this.prog = createProgress(track, this.gridS(g));
    this.remotes = new Map();
    this.finPlaces = new Map();
    this.gone = new Map();      // players who left mid-race: id -> { nick, color, total, dnf }
    this.lapsDone = 0;
    this.lapStart = startAt;
    this.bestLap = null;
    this.finished = false;
    this.finishMs = null;
    this.lastSend = 0;
    this.last = 0;
    this.raf = 0;
    this.running = false;
    this.boardKey = '';
    this.text = {};

    this.mini = document.createElement('canvas');
    this.mini.width = hud.minimap.width;
    this.mini.height = hud.minimap.height;
    drawTrackFit(this.mini.getContext('2d'), track, this.mini.width, this.mini.height, { color: '#ffffff' });
    this.miniMap = this.computeMiniMap();

    this.frame = this.frame.bind(this);
  }

  // Progress value the grid slot corresponds to (slots are behind the start line).
  gridS(g) {
    const loc = locate(this.track, g.x, g.y);
    return loc.s > this.track.L / 2 ? loc.s - this.track.L : loc.s;
  }

  computeMiniMap() {
    const { track } = this;
    const w = this.mini.width;
    const h = this.mini.height;
    const margin = 8;
    const sc = Math.min((w - margin * 2) / track.bbox.w, (h - margin * 2) / track.bbox.h);
    return { sc, tx: (w - track.bbox.w * sc) / 2, ty: (h - track.bbox.h * sc) / 2 };
  }

  start() {
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  setPlayers(list) {
    this.players = new Map(list.map((p) => [p.id, p]));
    for (const id of this.remotes.keys()) if (!this.players.has(id)) this.remotes.delete(id);
  }

  handleSnap(msg) {
    // Once per packet, not per car: this is how *this snapshot* arrived, which is what the adaptive
    // interpolation delay needs to track (see public/interp.js).
    recordArrival(this.jitter, performance.now());
    for (const c of msg.cars) {
      if (c.id === this.meId) continue;
      let r = this.remotes.get(c.id);
      if (!r) { r = { buf: [], tot: 0, smoother: null }; this.remotes.set(c.id, r); }
      r.buf.push({ st: msg.st, x: c.x, y: c.y, a: c.a, v: c.v });
      if (r.buf.length > 40) r.buf.shift();
      r.tot = c.tot;
    }
  }

  // Someone left the room. Their car disappears (setPlayers drops it), but they stay on the leaderboard:
  // as DNF if they hadn't finished, or with their finishing place if they had.
  handleLeft(msg) {
    if (msg.id === this.meId) return;
    this.gone.set(msg.id, { nick: msg.nick, color: msg.color, total: msg.total ?? 0, dnf: !!msg.dnf });
  }

  handleFin(msg) {
    this.finPlaces.set(msg.id, msg.place);
    if (msg.id === this.meId) {
      this.finished = true;
      this.finishMs = msg.time;
      this.official = msg;
    }
  }

  respawn() {
    const loc = locate(this.track, this.car.x, this.car.y, this.car.seg, 30);
    const p = pointAt(this.track, loc.s);
    Object.assign(this.car, { x: p.x, y: p.y, a: p.a, v: 0, seg: loc.seg, dist: 0 });
    this.renderer.snap?.();
    this.onReset?.();
  }

  frame(ts) {
    if (!this.running) return;
    const dt = Math.min((ts - this.last) / 1000 || 0.016, 1 / 20);
    this.last = ts;
    const sn = this.net.serverNow();
    this.update(dt, sn);
    this.draw(dt, sn);
    if (this.debug) this.updateDebugHud(dt);
    this.raf = requestAnimationFrame(this.frame);
  }

  update(dt, sn) {
    const { car, track } = this;
    const started = sn >= this.startAt;
    const input = readInput(dt);
    const reset = consumeReset();
    const shift = consumeGearShift();
    let drive = { throttle: 0, brake: 0, steer: 0 };
    if (started && !this.finished) {
      drive = input;
      if (reset) this.respawn();
    } else if (this.finished) {
      // Roll to a stop past the line; braking below zero speed would reverse the car back over it.
      drive = { throttle: 0, brake: car.v > 5 ? 0.35 : 0, steer: 0 };
    }

    // Not gated on `started`: picking a gear during the countdown (like selecting 1st before lights out)
    // is harmless since the car isn't moving yet, and it means a shift pressed a moment early isn't lost.
    // Shifting itself is never refused — any gear at any speed — only the physics (stepCar's lugging and
    // engine-braking) makes a mismatched gear cost you something.
    if (this.gearMode && !this.finished) {
      if (shift.up && this.gear < 8) this.gear++;
      if (shift.down && this.gear > 1) this.gear--;
    }

    if (started) {
      const gear = this.gearMode ? this.gear : null;
      let rem = dt;
      while (rem > 1e-6) {
        const h = Math.min(rem, 1 / 60);
        stepCar(car, drive, h, track, gear);
        rem -= h;
      }
      if (this.collisions && !this.finished) {
        const others = [];
        for (const [id, r] of this.remotes) {
          if (!this.players.has(id)) continue;
          const pose = remotePoseAt(r.buf, sn); // current best guess, not the delayed render pose
          if (pose) others.push(pose);
        }
        if (resolveCollisions(car, others, dt)) {
          const loc = locate(track, car.x, car.y, car.seg, 14);
          car.seg = loc.seg;
          car.dist = loc.dist;
        }
      }
      advanceProgress(track, this.prog, car.x, car.y);
    }

    const done = lapsCompleted(track, this.prog);
    while (this.lapsDone < done && !this.finished) {
      this.lapsDone++;
      const ms = sn - this.lapStart;
      this.lapStart = sn;
      this.bestLap = this.bestLap == null ? ms : Math.min(this.bestLap, ms);
      if (this.lapsDone >= this.laps) {
        this.finished = true;
        this.finishMs = sn - this.startAt;
      }
      this.onLap?.(this.lapsDone, ms, this.finished);
    }

    // Keep reporting after crossing the line locally: the server needs a position beyond it to confirm the finish.
    // Fields are kept small (whole units, 2-decimal heading) because SEND_HZ sends this several times a
    // second over what may be a tunnelled connection — see shared/protocol.js.
    if (started && !this.official && sn - this.lastSend >= SEND_EVERY) {
      this.lastSend = sn;
      this.net.send({ t: 's', x: r1(car.x), y: r1(car.y), a: Math.round(car.a * 100) / 100, v: Math.round(car.v), ts: Math.round(sn) });
    } else if (!started && sn - this.lastSend >= 500) {
      // Keep the server's view of the grid position fresh before the start.
      this.lastSend = sn;
      this.net.send({ t: 's', x: r1(car.x), y: r1(car.y), a: Math.round(car.a * 100) / 100, v: 0, ts: Math.round(sn) });
    }
  }

  draw(dt, sn) {
    // The delay chases its target gradually (stepJitterTracker), so it grows when the link is rough and
    // shrinks again once it settles, rather than snapping — see public/interp.js for the full picture:
    // buffered interpolation behind this delay, capped extrapolation past the last sample, and a jump
    // smoother so a stall-then-resume eases back in instead of teleporting.
    const delay = stepJitterTracker(this.jitter, dt * 1000);
    const renderT = sn - delay;
    const others = [];
    for (const [id, r] of this.remotes) {
      const info = this.players.get(id);
      const raw = remotePoseAt(r.buf, renderT);
      if (!raw || !info) continue;
      if (!r.smoother) r.smoother = createRemoteSmoother(raw.x, raw.y, raw.a);
      const plausibleStep = Math.max(Math.abs(raw.v) * dt, 1);
      const shown = smoothRemote(r.smoother, raw, dt, plausibleStep);
      others.push({ id, x: shown.x, y: shown.y, a: shown.a, color: info.color, nick: info.nick });
    }
    this.renderer.render({
      dt, sn, track: this.track, car: this.car, me: this.players.get(this.meId), others,
    });
    this.drawHud(sn, others);
  }

  updateDebugHud(dt) {
    const dbg = this.hud.dbg;
    if (!dbg) return;
    this.fps.count++;
    this.fps.acc += dt;
    if (this.fps.acc >= 0.5) {
      this.setText('dbgFps', dbg.fps, `${Math.round(this.fps.count / this.fps.acc)} FPS`);
      const ping = this.net.pingEma ?? this.net.rtt;
      this.setText('dbgPing', dbg.ping, ping == null ? 'ping --' : `${Math.round(ping)} ms`);
      this.fps.count = 0;
      this.fps.acc = 0;
    }
  }

  ranking() {
    const rows = [];
    for (const [id, info] of this.players) {
      const total = id === this.meId ? this.prog.total : this.remotes.get(id)?.tot ?? -1e9;
      rows.push({ id, nick: info.nick, color: info.color, total, place: this.finPlaces.get(id) ?? null, dnf: false });
    }
    for (const [id, g] of this.gone) {
      if (this.players.has(id)) continue;
      const place = this.finPlaces.get(id) ?? null;
      rows.push({ id, nick: g.nick, color: g.color, total: g.total, place, dnf: place == null });
    }
    // Finishers by place, then drivers still racing by distance, then DNFs (also by distance).
    const rank = (r) => (r.place != null ? 0 : r.dnf ? 2 : 1);
    rows.sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return a.place != null ? a.place - b.place : b.total - a.total;
    });
    return rows;
  }

  setText(key, el, value) {
    if (this.text[key] !== value) {
      this.text[key] = value;
      el.textContent = value;
    }
  }

  drawHud(sn, others) {
    const { hud, track } = this;
    const started = sn >= this.startAt;
    const lap = Math.min(this.laps, this.lapsDone + 1);
    this.setText('lap', hud.lap, `LAP ${this.finished ? this.laps : lap}/${this.laps}`);
    this.setText('speed', hud.speed, `${Math.round(worldToKmh(Math.abs(this.car.v)))} km/h`);
    const raceMs = started ? (this.finished ? this.finishMs : sn - this.startAt) : 0;
    this.setText('time', hud.time, formatTime(Math.max(0, raceMs)));

    if (this.gearMode && hud.gear) {
      this.setText('gear', hud.gear.num, String(this.gear));
      // Never blocks anything — just tells the driver which way they're mismatched, if at all.
      const tooFast = this.car.v > GEAR_SPEEDS[this.gear - 1] * SHIFT_LIGHT_RATIO;
      const tooSlow = this.gear > 1 && this.car.v < GEAR_SPEEDS[this.gear - 2];
      const gearCls = tooFast ? 'shift' : tooSlow ? 'lug' : '';
      if (this.text.gearCls !== gearCls) { this.text.gearCls = gearCls; hud.gear.num.className = gearCls; }
    }

    const rows = this.ranking();
    const myPos = rows.findIndex((r) => r.id === this.meId) + 1;
    this.setText('pos', hud.pos, `${myPos}/${rows.filter((r) => !r.dnf).length}`); // DNFs are out of the count

    const key = rows.map((r) => `${r.id}:${Math.floor(Math.max(0, r.total) / track.L)}:${r.place ?? ''}:${r.dnf ? 'x' : ''}`).join('|');
    if (key !== this.boardKey) {
      this.boardKey = key;
      hud.board.replaceChildren(...rows.map((r, i) => {
        const li = document.createElement('li');
        li.className = r.id === this.meId ? 'me' : r.dnf ? 'dnf' : '';
        const pos = document.createElement('span');
        pos.className = 'pos';
        pos.textContent = r.dnf ? '–' : String(i + 1);
        const dot = document.createElement('i');
        dot.style.background = r.color;
        const nick = document.createElement('span');
        nick.className = 'nick';
        nick.textContent = r.nick;
        const info = document.createElement('span');
        info.className = 'lapn';
        info.textContent = r.dnf ? 'DNF' : r.place != null ? '🏁' : `L${Math.min(this.laps, Math.max(0, Math.floor(r.total / track.L)) + 1)}`;
        li.append(pos, dot, nick, info);
        return li;
      }));
    }

    // Big center message: countdown, wrong-way warning, or finish banner.
    let center = '';
    let cls = '';
    const remaining = this.startAt - sn;
    if (remaining > 0) {
      const k = Math.ceil(remaining / 1000);
      center = k >= 4 ? 'READY' : String(k);
      cls = 'count';
    } else if (remaining > -900) {
      center = 'GO!';
      cls = 'go';
    } else if (this.finished) {
      const p = this.official?.place;
      center = p ? `🏁 ${p}위 완주!  ${formatTime(this.finishMs)}` : `🏁 완주!  ${formatTime(this.finishMs)}\n순위 확인 중…`;
      cls = 'finish';
    } else {
      const ang = track.angs[this.car.seg];
      if (Math.abs(norm(this.car.a - ang)) > 2.2 && this.car.v > 60) { center = '역주행!'; cls = 'warn'; }
    }
    this.setText('center', hud.center, center);
    if (this.text.centerCls !== cls) {
      this.text.centerCls = cls;
      hud.center.className = cls;
    }

    // Minimap
    const mctx = hud.minimap.getContext('2d');
    mctx.clearRect(0, 0, hud.minimap.width, hud.minimap.height);
    mctx.drawImage(this.mini, 0, 0);
    const { sc, tx, ty } = this.miniMap;
    const dotAt = (x, y, color, radius) => {
      mctx.fillStyle = color;
      mctx.beginPath();
      mctx.arc(tx + x * sc, ty + y * sc, radius, 0, Math.PI * 2);
      mctx.fill();
    };
    for (const o of others) dotAt(o.x, o.y, o.color, 4);
    dotAt(this.car.x, this.car.y, '#ffffff', 6);
    dotAt(this.car.x, this.car.y, this.players.get(this.meId)?.color ?? '#e10600', 4);
  }
}
