import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/rooms.js';
import { getTrack } from '../shared/tracks.js';
import { createCar, stepCar } from '../shared/physics.js';
import { pointAt, KERB_W } from '../shared/track-geom.js';
import { botInput } from '../shared/bot.js';

function setup(laps = 5) {
  const clock = { t: 1_000_000 };
  const room = new Room({ code: 'TEST', now: () => clock.t, laps });
  const join = (nick) => {
    const inbox = [];
    const res = room.addPlayer((data) => inbox.push(JSON.parse(data)), nick);
    return { ...res, inbox, last: (type) => [...inbox].reverse().find((m) => m.t === type) };
  };
  return { clock, room, join };
}

test('lobby: host picks a track, others must ready up before start', () => {
  const { room, join } = setup();
  const a = join('Alice');
  const b = join('Bob');
  assert.equal(room.hostId, a.id);

  room.handle(b.id, { t: 'track', id: 'suzuka' });            // non-host ignored
  assert.equal(room.trackId, 'monza');
  room.handle(a.id, { t: 'track', id: 'suzuka' });
  assert.equal(room.trackId, 'suzuka');
  room.handle(a.id, { t: 'track', id: 'nope' });              // unknown track ignored
  assert.equal(room.trackId, 'suzuka');

  room.handle(a.id, { t: 'start' });                           // Bob not ready
  assert.equal(room.phase, 'lobby');
  room.handle(b.id, { t: 'ready', ready: true });
  room.handle(b.id, { t: 'start' });                           // non-host can't start
  assert.equal(room.phase, 'lobby');
  room.handle(a.id, { t: 'start' });
  assert.equal(room.phase, 'racing');

  const go = a.last('go');
  assert.equal(go.track, 'suzuka');
  assert.equal(go.laps, 5);
  assert.equal(go.grid.length, 2);
  assert.ok(go.startAt > go.serverNow);
  assert.equal(go.collisions, false);
  assert.equal(go.gearMode, false);
});

test('lobby: host toggles collisions and gear mode; both reset ready and reach room/go messages', () => {
  const { room, join } = setup();
  const a = join('Host');
  const b = join('Guest');
  assert.equal(room.collisions, false);
  assert.equal(room.gearMode, false);
  assert.equal(a.last('room').collisions, false);

  room.handle(b.id, { t: 'ready', ready: true });
  room.handle(b.id, { t: 'collisions', on: true }); // non-host ignored
  assert.equal(room.collisions, false);
  assert.equal(room.players.get(b.id).ready, true, 'ignored toggle does not reset ready');

  room.handle(a.id, { t: 'collisions', on: true });
  assert.equal(room.collisions, true);
  assert.equal(a.last('room').collisions, true);
  assert.equal(room.players.get(b.id).ready, false, 'toggling collisions resets ready, like changing track');

  room.handle(b.id, { t: 'ready', ready: true });
  room.handle(a.id, { t: 'gear', on: true });
  assert.equal(room.gearMode, true);
  assert.equal(a.last('room').gearMode, true);
  assert.equal(room.players.get(b.id).ready, false, 'toggling gear mode also resets ready');

  room.handle(b.id, { t: 'ready', ready: true });
  room.handle(a.id, { t: 'start' });
  const go = a.last('go');
  assert.equal(go.collisions, true);
  assert.equal(go.gearMode, true);

  room.handle(a.id, { t: 'collisions', on: false }); // ignored once racing
  assert.equal(room.collisions, true);
});

test('nicknames are sanitized and made unique; room caps at 8', () => {
  const { room, join } = setup();
  const a = join('  <b>Max</b>\u0007   Ver  ');
  assert.equal(a.player.nick, '<b>Max</b> Ver'.slice(0, 12));
  const b = join('Sam');
  const c = join('Sam');
  assert.notEqual(b.player.nick, c.player.nick);
  for (let i = 0; i < 5; i++) join(`p${i}`);
  assert.equal(room.players.size, 8);
  assert.ok(join('ninth').error);
});

test('joining a race in progress is refused; host migrates when host leaves', () => {
  const { room, join } = setup();
  const a = join('A');
  const b = join('B');
  room.handle(b.id, { t: 'ready', ready: true });
  room.handle(a.id, { t: 'start' });
  assert.ok(join('late').error);
  room.removePlayer(a.id);
  assert.equal(room.hostId, b.id);
});

// Drive a player's car with the bot and report positions the way a browser client would.
function makeDriver(room, clock, p, skill = 1) {
  const track = getTrack(room.trackId);
  const g = room.race.grid.find((x) => x.id === p.id);
  const car = createCar(g.x, g.y, g.a, track);
  return () => {
    for (let i = 0; i < 3; i++) {
      const inp = botInput(car, track);
      inp.throttle *= skill;
      if (clock.t >= room.race.startAt) stepCar(car, inp, 1 / 60, track);
    }
    room.handle(p.id, { t: 's', x: car.x, y: car.y, a: car.a, v: car.v, ts: clock.t });
  };
}

test('full 5-lap race: faster driver wins, times match simulated time, results are broadcast', () => {
  const { clock, room, join } = setup();
  const a = join('Fast');
  const b = join('Slow');
  room.handle(a.id, { t: 'track', id: 'redbullring' });
  room.handle(b.id, { t: 'ready', ready: true });
  room.handle(a.id, { t: 'start' });
  const startAt = room.race.startAt;

  const driveA = makeDriver(room, clock, a, 1);
  const driveB = makeDriver(room, clock, b, 0.85);
  for (let i = 0; i < 20 * 400 && room.phase === 'racing'; i++) {
    clock.t += 50;
    driveA();
    driveB();
    room.tick();
  }

  assert.equal(room.phase, 'results');
  const res = a.last('results');
  assert.equal(res.rows.length, 2);
  assert.deepEqual(res.rows.map((r) => r.nick), ['Fast', 'Slow']);
  assert.ok(res.rows.every((r) => r.finished));
  assert.ok(res.rows[0].time < res.rows[1].time);
  const fins = a.inbox.filter((m) => m.t === 'fin');
  assert.equal(fins.length, 2);
  assert.equal(fins[0].place, 1);
  assert.equal(fins[0].laps.length, 5);
  // The first finisher's time can't exceed the elapsed simulated time.
  assert.ok(res.rows[0].time <= clock.t - startAt);
  assert.ok(res.rows[0].best > 15000 && res.rows[0].best < 40000, `best lap ${res.rows[0].best}`);
  assert.ok(a.inbox.some((m) => m.t === 'snap'), 'snapshots were broadcast');

  room.handle(b.id, { t: 'lobby' });     // non-host can't reset
  assert.equal(room.phase, 'results');
  room.handle(a.id, { t: 'lobby' });
  assert.equal(room.phase, 'lobby');
});

// ---- leaving mid-race -------------------------------------------------------

// Advance the fake clock in 50 ms steps, letting each driver report a position, until `done()`.
function runUntil(room, clock, drivers, done, maxSteps = 20 * 400) {
  for (let i = 0; i < maxSteps && !done(); i++) {
    clock.t += 50;
    for (const d of drivers) d();
    room.tick();
  }
}

function startRace(n, laps = 1) {
  const { clock, room, join } = setup(laps);
  const players = Array.from({ length: n }, (_, i) => join(['Host', 'Guest', 'Third'][i]));
  room.handle(players[0].id, { t: 'track', id: 'redbullring' });
  for (const p of players.slice(1)) room.handle(p.id, { t: 'ready', ready: true });
  room.handle(players[0].id, { t: 'start' });
  return { clock, room, players };
}

test('leaving during the countdown: the rest carry on, the leaver is DNF, the host role moves on', () => {
  const { clock, room, players: [host, guest, third] } = startRace(3);
  assert.ok(clock.t < room.race.startAt, 'still counting down');

  room.removePlayer(host.id);
  assert.equal(room.phase, 'racing');
  assert.equal(room.hostId, guest.id, 'host role passes to the next player');
  const left = guest.last('left');
  assert.deepEqual([left.id, left.nick, left.dnf], [host.id, 'Host', true]);
  assert.deepEqual([left.hostChanged, left.hostId], [true, guest.id], 'the message says who the new host is');
  assert.equal(guest.last('room').hostId, guest.id);
  assert.ok(!third.last('room').players.some((p) => p.id === host.id));

  const drivers = [makeDriver(room, clock, guest, 1), makeDriver(room, clock, third, 0.85)];
  runUntil(room, clock, drivers, () => room.phase === 'results');
  assert.equal(room.phase, 'results');

  const { rows } = guest.last('results');
  assert.deepEqual(rows.map((r) => r.nick), ['Guest', 'Third', 'Host']);
  assert.deepEqual(rows.map((r) => r.finished), [true, true, false]);
  assert.deepEqual(rows.map((r) => r.place), [1, 2, 3]);
  const dnf = rows[2];
  assert.equal(dnf.left, true);
  assert.equal(dnf.time, null);
  assert.equal(dnf.best, null);
  assert.ok(!('total' in dnf));
  assert.ok(host.inbox.every((m) => m.t !== 'results'), 'the leaver no longer gets room traffic');
});

test('a lone survivor keeps racing and still gets a normal results screen; the new host can reset the room', () => {
  const { clock, room, players: [host, guest] } = startRace(2);
  const driveHost = makeDriver(room, clock, host, 1);
  const driveGuest = makeDriver(room, clock, guest, 1);
  for (let i = 0; i < 20 * 8; i++) { clock.t += 50; driveHost(); driveGuest(); room.tick(); }
  assert.equal(room.phase, 'racing');

  room.removePlayer(host.id);
  assert.equal(room.phase, 'racing', 'one driver left is still a race');
  assert.equal(room.hostId, guest.id);
  assert.ok(guest.last('left').dnf);

  runUntil(room, clock, [driveGuest], () => room.phase === 'results');
  assert.equal(room.phase, 'results');
  const results = guest.inbox.filter((m) => m.t === 'results');
  assert.equal(results.length, 1, 'results are sent exactly once');
  const { rows } = results[0];
  assert.deepEqual(rows.map((r) => [r.nick, r.finished, !!r.left]), [['Guest', true, false], ['Host', false, true]]);
  assert.ok(rows[0].time > 0 && rows[0].best > 0);
  assert.equal(guest.last('room').hostId, guest.id);

  room.handle(guest.id, { t: 'lobby' });     // the new host can send everyone back to the lobby
  assert.equal(room.phase, 'lobby');
  assert.equal(room.race, null);
});

test('leaving after finishing keeps your result; nobody is marked DNF', () => {
  const { clock, room, players: [a, b] } = startRace(2);
  const driveA = makeDriver(room, clock, a, 1);
  const driveB = makeDriver(room, clock, b, 0.85);
  runUntil(room, clock, [driveA, driveB], () => room.players.get(a.id).rs.finished);
  assert.equal(room.phase, 'racing', 'the other driver is still on the track');

  room.removePlayer(a.id);
  assert.equal(b.last('left').dnf, false, 'a finished driver leaving is not a DNF');

  runUntil(room, clock, [driveB], () => room.phase === 'results');
  const { rows } = b.last('results');
  assert.deepEqual(rows.map((r) => [r.nick, r.finished]), [['Host', true], ['Guest', true]]);
  assert.ok(rows[0].time < rows[1].time);
  assert.ok(rows[0].time > 0, 'the leaver keeps their recorded time');
});

test('when everyone else has finished, an unfinished driver leaving ends the race at once', () => {
  const { clock, room, players: [a, b] } = startRace(2);
  runUntil(room, clock, [makeDriver(room, clock, a, 1)], () => room.players.get(a.id).rs.finished);
  assert.equal(room.phase, 'racing', 'waiting for the second driver');

  room.removePlayer(b.id);
  assert.equal(room.phase, 'results');
  const { rows } = a.last('results');
  assert.deepEqual(rows.map((r) => [r.nick, r.finished, !!r.left]), [['Host', true, false], ['Guest', false, true]]);
});

test('drivers who stay but never finish rank above those who left', () => {
  const { clock, room, players: [a, b, c] } = startRace(3);
  const driveA = makeDriver(room, clock, a, 1);
  const driveB = makeDriver(room, clock, b, 0.5);
  const driveC = makeDriver(room, clock, c, 0.5);
  for (let i = 0; i < 20 * 25; i++) { clock.t += 50; driveA(); driveB(); driveC(); room.tick(); }
  room.removePlayer(b.id);                         // B leaves, far ahead of C on the road
  runUntil(room, clock, [driveA], () => room.phase === 'results', 20 * 300);
  const { rows } = a.last('results');
  assert.equal(room.phase, 'results', 'the grace period after the first finisher ends the race');
  assert.deepEqual(rows.map((r) => [r.nick, !!r.left]), [['Host', false], ['Third', false], ['Guest', true]]);
});

test('leaving from the lobby is a plain removal; the last player leaving closes the room', () => {
  const clock = { t: 5000 };
  let emptied = 0;
  const room = new Room({ code: 'GONE', now: () => clock.t, onEmpty: () => { emptied++; } });
  const box = (nick) => { const inbox = []; const r = room.addPlayer((d) => inbox.push(JSON.parse(d)), nick); return { ...r, inbox }; };
  const a = box('A');
  const b = box('B');

  room.removePlayer(b.id);
  const left = a.inbox.findLast((m) => m.t === 'left');
  assert.deepEqual([left.nick, left.dnf], ['B', false]);
  assert.equal(room.phase, 'lobby');
  assert.equal(room.hostId, a.id);
  assert.equal(emptied, 0);

  room.removePlayer(a.id);
  assert.equal(emptied, 1);
  room.removePlayer(a.id);                          // removing twice is harmless
  assert.equal(emptied, 1);
});

test('the leaver disappears from position snapshots', () => {
  const { clock, room, players: [host, guest] } = startRace(2);
  clock.t += 100;
  room.tick();
  assert.equal(guest.last('snap').cars.length, 2);
  room.removePlayer(host.id);
  clock.t += 100;
  room.tick();
  assert.deepEqual(guest.last('snap').cars.map((c) => c.id), [guest.id]);
});

test('teleporting around the track does not skip laps', () => {
  const { clock, room, join } = setup(1);
  const a = join('Cheat');
  room.handle(a.id, { t: 'track', id: 'redbullring' });
  room.handle(a.id, { t: 'start' });
  const track = getTrack('redbullring');
  clock.t = room.race.startAt + 100;
  const g = room.race.grid[0];
  room.handle(a.id, { t: 's', x: g.x, y: g.y, a: g.a, v: 0, ts: clock.t });
  for (let i = 0; i < 40; i++) {
    clock.t += 50;
    // Jump 5000 units ahead each report.
    const p = pointAt(track, 5000 * (i + 1));
    room.handle(a.id, { t: 's', x: p.x, y: p.y, a: p.a, v: 500, ts: clock.t });
  }
  assert.equal(room.phase, 'racing');
  assert.equal(room.players.get(a.id).rs.finished, false);
});

test('driving the wrong way never completes a lap', () => {
  const { clock, room, join } = setup(1);
  const a = join('Backwards');
  room.handle(a.id, { t: 'track', id: 'redbullring' });
  room.handle(a.id, { t: 'start' });
  const track = getTrack('redbullring');
  clock.t = room.race.startAt;
  for (let i = 0; i < 20 * 60; i++) {
    clock.t += 50;
    const p = pointAt(track, -i * 20);
    room.handle(a.id, { t: 's', x: p.x, y: p.y, a: p.a + Math.PI, v: 400, ts: clock.t });
  }
  assert.equal(room.phase, 'racing');
  assert.ok(room.players.get(a.id).rs.prog.total <= 0);
});

test('garbage state reports are ignored', () => {
  const { clock, room, join } = setup(1);
  const a = join('Fuzz');
  room.handle(a.id, { t: 'start' });
  clock.t = room.race.startAt + 100;
  const before = room.players.get(a.id).rs.prog.total;
  room.handle(a.id, { t: 's', x: NaN, y: 0, a: 0, v: 0 });
  room.handle(a.id, { t: 's', x: 'a', y: 0, a: 0, v: 0 });
  room.handle(a.id, { t: 's', x: 1e12, y: 0, a: 0, v: 0 });
  room.handle(a.id, null);
  room.handle(a.id, 'hello');
  assert.equal(room.players.get(a.id).rs.prog.total, before);
});

// ---- best-lap ghost -----------------------------------------------------------

// A minimal stand-in for server/ghosts.js's GhostStore (same get/maybeUpdate shape, no file I/O),
// so these tests exercise Room's wiring without touching disk — GhostStore itself is covered by
// tests/ghosts.test.js, and scripts/e2e-ghost.mjs exercises the real file-backed store end to end.
function fakeGhosts() {
  const records = new Map();
  return {
    get: (trackId) => records.get(trackId)?.[0],
    top5: (trackId) => (records.get(trackId) ?? []).map(({ nick, time }) => ({ nick, time })),
    maybeUpdate(trackId, { nick, time, path }) {
      if (!path.length) return false;
      const list = records.get(trackId) ?? [];
      const existing = list.find((r) => r.nick === nick);
      if (existing && existing.time <= time) return false;
      const next = list.filter((r) => r.nick !== nick);
      next.push({ nick, time, path });
      next.sort((a, b) => a.time - b.time);
      next.length = Math.min(next.length, 5);
      next.forEach((r, i) => { if (i > 0) delete r.path; });
      records.set(trackId, next);
      return true;
    },
  };
}

function soloSetup(laps = 1) {
  const clock = { t: 1_000_000 };
  const ghosts = fakeGhosts();
  const room = new Room({
    code: 'TEST', now: () => clock.t, laps, ghosts,
  });
  const join = (nick) => {
    const inbox = [];
    const res = room.addPlayer((data) => inbox.push(JSON.parse(data)), nick);
    return { ...res, inbox, last: (type) => [...inbox].reverse().find((m) => m.t === type) };
  };
  return {
    clock, room, join, ghosts,
  };
}

test('a solo race with no track record yet starts with no ghost, and finishing seeds one', () => {
  const {
    clock, room, join, ghosts,
  } = soloSetup(1);
  const a = join('Solo');
  room.handle(a.id, { t: 'track', id: 'redbullring' });
  room.handle(a.id, { t: 'start' });
  assert.equal(a.last('go').ghost, undefined, 'no record yet for this track');

  const drive = makeDriver(room, clock, a, 1);
  for (let i = 0; i < 20 * 400 && room.phase === 'racing'; i++) {
    clock.t += 50;
    drive();
    room.tick();
  }
  assert.equal(room.phase, 'results');

  const record = ghosts.get('redbullring');
  assert.ok(record, 'finishing the race saved a best-lap record');
  assert.equal(record.nick, 'Solo');
  assert.ok(record.path.length > 1, 'the lap trail has more than one sample');
  assert.ok(
    record.path.every(([t]) => t >= 0 && t <= record.time + 1),
    'every sample falls within the recorded lap',
  );
  const best = Math.min(...room.players.get(a.id).rs.lapTimes);
  assert.equal(record.time, best, 'the saved time matches the best lap used on the results screen');
});

test('a second solo race on the same track is sent the saved ghost', () => {
  const { room, join, ghosts } = soloSetup(1);
  ghosts.maybeUpdate('redbullring', { nick: 'Champ', time: 42000, path: [[0, 0, 0, 0], [100, 1, 1, 0]] });
  const a = join('Challenger');
  room.handle(a.id, { t: 'track', id: 'redbullring' });
  room.handle(a.id, { t: 'start' });
  const go = a.last('go');
  assert.deepEqual(go.ghost, { nick: 'Champ', time: 42000, path: [[0, 0, 0, 0], [100, 1, 1, 0]] });
});

test('a track with no saved record offers no ghost', () => {
  const { room, join } = soloSetup(1);
  const a = join('Alone');
  room.handle(a.id, { t: 'track', id: 'suzuka' });
  room.handle(a.id, { t: 'start' });
  assert.equal(a.last('go').ghost, undefined);
});

test('a multiplayer race never attaches a ghost, even with a saved record', () => {
  const { room, join, ghosts } = soloSetup(1);
  ghosts.maybeUpdate('redbullring', { nick: 'Champ', time: 42000, path: [[0, 0, 0, 0]] });
  const a = join('Host');
  const b = join('Guest');
  room.handle(a.id, { t: 'track', id: 'redbullring' });
  room.handle(b.id, { t: 'ready', ready: true });
  room.handle(a.id, { t: 'start' });
  assert.equal(a.last('go').ghost, undefined);
});

test('a slower repeat solo run does not overwrite a faster saved ghost', () => {
  const {
    clock, room, join, ghosts,
  } = soloSetup(1);
  ghosts.maybeUpdate('redbullring', { nick: 'Champ', time: 1, path: [[0, 0, 0, 0]] }); // unbeatable
  const a = join('Slower');
  room.handle(a.id, { t: 'track', id: 'redbullring' });
  room.handle(a.id, { t: 'start' });

  const drive = makeDriver(room, clock, a, 1);
  for (let i = 0; i < 20 * 400 && room.phase === 'racing'; i++) {
    clock.t += 50;
    drive();
    room.tick();
  }
  assert.equal(room.phase, 'results');
  assert.equal(ghosts.get('redbullring').nick, 'Champ', 'the existing faster record survives');
});

// ---- lobby TOP5 leaderboard (rides along on the 'room' broadcast) -------------------------------

test('the room message carries the selected track\'s leaderboard', () => {
  const { room, join, ghosts } = soloSetup(1);
  ghosts.maybeUpdate('monza', { nick: 'Champ', time: 50000, path: [[0, 0, 0, 0]] }); // room defaults to monza
  const a = join('Solo');
  assert.deepEqual(a.last('room').top5, [{ nick: 'Champ', time: 50000 }]);
});

test('an untouched track reports an empty leaderboard, not an error', () => {
  const { join } = soloSetup(1);
  const a = join('Solo');
  assert.deepEqual(a.last('room').top5, []);
});

test('switching track updates everyone\'s leaderboard in the room immediately', () => {
  const { room, join, ghosts } = soloSetup(1);
  ghosts.maybeUpdate('monza', { nick: 'MonzaChamp', time: 50000, path: [[0, 0, 0, 0]] });
  ghosts.maybeUpdate('suzuka', { nick: 'SuzukaChamp', time: 60000, path: [[0, 0, 0, 0]] });
  const a = join('Host');
  const b = join('Guest');
  assert.deepEqual(a.last('room').top5, [{ nick: 'MonzaChamp', time: 50000 }]);

  room.handle(a.id, { t: 'track', id: 'suzuka' });
  assert.deepEqual(a.last('room').top5, [{ nick: 'SuzukaChamp', time: 60000 }], 'the host sees the new track\'s board');
  assert.deepEqual(b.last('room').top5, [{ nick: 'SuzukaChamp', time: 60000 }], 'so does the guest, same broadcast');
});

test('finishing a race and returning to the lobby reflects the newly set record', () => {
  const { clock, room, join } = soloSetup(1);
  const a = join('Solo');
  room.handle(a.id, { t: 'track', id: 'redbullring' });
  room.handle(a.id, { t: 'start' });

  const drive = makeDriver(room, clock, a, 1);
  for (let i = 0; i < 20 * 400 && room.phase === 'racing'; i++) {
    clock.t += 50;
    drive();
    room.tick();
  }
  assert.equal(room.phase, 'results');

  room.handle(a.id, { t: 'lobby' });
  const top5 = a.last('room').top5;
  assert.equal(top5.length, 1);
  assert.equal(top5[0].nick, 'Solo');
});

// ---- tire wear ------------------------------------------------------------------------------

// Parks a car just off the start line, offset laterally from the centerline by `offset` (world units),
// and reports that single stationary position. `offset` past track.halfW is the kerb/grass; see physics.js.
function reportParked(room, clock, p, track, offset) {
  const a = track.angs[0];
  const x = track.xs[0] - Math.sin(a) * offset;
  const y = track.ys[0] + Math.cos(a) * offset;
  room.handle(p.id, { t: 's', x, y, a, v: 0, ts: clock.t });
}

test('tire wear is off by default; turning it on resets ready like collisions/gear mode', () => {
  const { room, join } = setup();
  const a = join('Host');
  const b = join('Guest');
  assert.equal(room.tireWear, false);
  assert.equal(a.last('room').tireWear, false);

  room.handle(b.id, { t: 'ready', ready: true });
  room.handle(b.id, { t: 'tirewear', on: true }); // non-host ignored
  assert.equal(room.tireWear, false);
  assert.equal(room.players.get(b.id).ready, true, 'ignored toggle does not reset ready');

  room.handle(a.id, { t: 'tirewear', on: true });
  assert.equal(room.tireWear, true);
  assert.equal(a.last('room').tireWear, true);
  assert.equal(room.players.get(b.id).ready, false, 'toggling tire wear resets ready, like the other toggles');

  room.handle(b.id, { t: 'ready', ready: true });
  room.handle(a.id, { t: 'start' });
  assert.equal(a.last('go').tireWear, true);
});

test('tire wear off: sitting in the grass never accumulates wear or causes a DNF', () => {
  const { clock, room, join } = setup(1);
  const a = join('Solo');
  room.handle(a.id, { t: 'track', id: 'redbullring' });
  room.handle(a.id, { t: 'start' });
  const track = getTrack('redbullring');
  clock.t = room.race.startAt + 60000; // a full minute parked in the grass
  reportParked(room, clock, a, track, track.halfW + 200);
  assert.equal(room.players.get(a.id).rs.wear, 0);
  assert.equal(room.players.get(a.id).rs.dnf, false);
});

test('tire wear on: sitting in the grass accumulates wear and DNFs at 100%', () => {
  const { clock, room, join } = setup(1);
  const a = join('Solo');
  room.handle(a.id, { t: 'tirewear', on: true });
  room.handle(a.id, { t: 'track', id: 'redbullring' });
  room.handle(a.id, { t: 'start' });
  const track = getTrack('redbullring');
  const off = track.halfW + 200;

  clock.t = room.race.startAt + 10000; // 10s of grass: not enough yet
  reportParked(room, clock, a, track, off);
  const rs = room.players.get(a.id).rs;
  assert.ok(rs.wear > 0 && rs.wear < 1, `wear after 10s: ${rs.wear}`);
  assert.equal(rs.dnf, false);

  clock.t = room.race.startAt + 30000; // 30s total: comfortably past 100%
  reportParked(room, clock, a, track, off);
  assert.equal(room.players.get(a.id).rs.dnf, true);
  assert.equal(room.players.get(a.id).rs.wear, 1);
});

test('a wear DNF broadcasts a dnf message and ends a solo race, with the row marked DNF in the results', () => {
  const { clock, room, join } = setup(1);
  const a = join('Solo');
  room.handle(a.id, { t: 'tirewear', on: true });
  room.handle(a.id, { t: 'track', id: 'redbullring' });
  room.handle(a.id, { t: 'start' });
  const track = getTrack('redbullring');
  clock.t = room.race.startAt + 30000;
  reportParked(room, clock, a, track, track.halfW + 200);

  const dnfMsg = a.last('dnf');
  assert.ok(dnfMsg);
  assert.equal(dnfMsg.id, a.id);
  assert.equal(dnfMsg.nick, 'Solo');
  assert.equal(dnfMsg.reason, 'wear');
  assert.equal(room.phase, 'results', 'the only player DNF-ing ends the race, same as finishing would');
  const row = a.last('results').rows.find((r) => r.id === a.id);
  assert.equal(row.dnf, true);
  assert.equal(row.finished, false);
});

test("one player's wear DNF does not end the race while another is still going", () => {
  const { clock, room, join } = setup(1);
  const a = join('Faller'); // host
  const b = join('Survivor');
  room.handle(a.id, { t: 'tirewear', on: true });
  room.handle(a.id, { t: 'track', id: 'redbullring' });
  room.handle(b.id, { t: 'ready', ready: true });
  room.handle(a.id, { t: 'start' });
  const track = getTrack('redbullring');
  clock.t = room.race.startAt + 30000;
  reportParked(room, clock, a, track, track.halfW + 200);

  assert.equal(room.players.get(a.id).rs.dnf, true);
  assert.equal(room.phase, 'racing', 'the other player is still racing');

  const driveB = makeDriver(room, clock, b, 1);
  for (let i = 0; i < 20 * 400 && room.phase === 'racing'; i++) {
    clock.t += 50;
    driveB();
    room.tick();
  }
  assert.equal(room.phase, 'results');
  const rows = a.last('results').rows;
  assert.equal(rows.find((r) => r.id === b.id).finished, true);
  assert.equal(rows.find((r) => r.id === a.id).dnf, true);
});

test('kerb wear accumulates slower than grass wear over the same time', () => {
  const { clock, room, join } = setup(1);
  const a = join('Solo');
  room.handle(a.id, { t: 'tirewear', on: true });
  room.handle(a.id, { t: 'track', id: 'redbullring' });
  room.handle(a.id, { t: 'start' });
  const track = getTrack('redbullring');
  clock.t = room.race.startAt + 5000;
  reportParked(room, clock, a, track, track.halfW + KERB_W / 2);
  const kerbWear = room.players.get(a.id).rs.wear;
  assert.ok(kerbWear > 0 && kerbWear < 1);

  const second = setup(1);
  const c = second.join('Solo2');
  second.room.handle(c.id, { t: 'tirewear', on: true });
  second.room.handle(c.id, { t: 'track', id: 'redbullring' });
  second.room.handle(c.id, { t: 'start' });
  second.clock.t = second.room.race.startAt + 5000;
  reportParked(second.room, second.clock, c, track, track.halfW + KERB_W + 50);
  const grassWear = second.room.players.get(c.id).rs.wear;

  assert.ok(grassWear > kerbWear, `grass ${grassWear} should wear faster than kerb ${kerbWear}`);
});

test("once DNF'd, further state reports from that player are ignored", () => {
  const { clock, room, join } = setup(1);
  const a = join('Solo');
  room.handle(a.id, { t: 'tirewear', on: true });
  room.handle(a.id, { t: 'track', id: 'redbullring' });
  room.handle(a.id, { t: 'start' });
  const track = getTrack('redbullring');
  clock.t = room.race.startAt + 30000;
  reportParked(room, clock, a, track, track.halfW + 200);
  assert.equal(room.players.get(a.id).rs.dnf, true);
  const totalAfterDnf = room.players.get(a.id).rs.prog.total;

  // Try to report a normal on-track position afterwards — should be a no-op.
  clock.t += 1000;
  const p = pointAt(track, 5000);
  room.handle(a.id, { t: 's', x: p.x, y: p.y, a: p.a, v: 200, ts: clock.t });
  assert.equal(room.players.get(a.id).rs.prog.total, totalAfterDnf);
});
