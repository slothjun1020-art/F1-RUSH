import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GhostStore } from '../server/ghosts.js';

function tmpPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'f1-ghosts-')), 'ghosts.json');
}

test('starts empty when the file does not exist yet', () => {
  const store = new GhostStore({ filePath: tmpPath() });
  assert.equal(store.get('monza'), undefined);
  assert.deepEqual(store.top5('monza'), []);
});

test('the first record for a track is always kept, as the sole (fastest) entry', () => {
  const store = new GhostStore({ filePath: tmpPath() });
  const replaced = store.maybeUpdate('monza', { nick: 'Max', time: 80000, path: [[0, 0, 0, 0]] });
  assert.equal(replaced, true);
  assert.deepEqual(store.get('monza'), { nick: 'Max', time: 80000, path: [[0, 0, 0, 0]] });
  assert.deepEqual(store.top5('monza'), [{ nick: 'Max', time: 80000 }]);
});

test('a faster lap from a different driver takes over as the fastest (ghost) entry', () => {
  const store = new GhostStore({ filePath: tmpPath() });
  store.maybeUpdate('monza', { nick: 'Max', time: 80000, path: [[0, 0, 0, 0]] });
  const replaced = store.maybeUpdate('monza', { nick: 'Lewis', time: 79000, path: [[0, 2, 2, 0]] });
  assert.equal(replaced, true);
  assert.equal(store.get('monza').nick, 'Lewis');
  assert.equal(store.get('monza').time, 79000);
});

test('a slower lap from a different driver still joins the leaderboard, without dethroning the leader', () => {
  const store = new GhostStore({ filePath: tmpPath() });
  store.maybeUpdate('monza', { nick: 'Max', time: 80000, path: [[0, 0, 0, 0]] });
  const replaced = store.maybeUpdate('monza', { nick: 'Slow', time: 90000, path: [[0, 1, 1, 0]] });
  assert.equal(replaced, true, 'the leaderboard itself changed (a new row), even though #1 did not');
  assert.equal(store.get('monza').nick, 'Max', 'the ghost car still replays the faster lap');
  assert.deepEqual(store.top5('monza'), [{ nick: 'Max', time: 80000 }, { nick: 'Slow', time: 90000 }]);
});

test('a slower lap from the SAME driver does not replace their own leaderboard entry', () => {
  const store = new GhostStore({ filePath: tmpPath() });
  store.maybeUpdate('monza', { nick: 'Max', time: 80000, path: [[0, 0, 0, 0]] });
  const replaced = store.maybeUpdate('monza', { nick: 'Max', time: 85000, path: [[0, 9, 9, 0]] });
  assert.equal(replaced, false);
  assert.equal(store.get('monza').time, 80000);
  assert.deepEqual(store.top5('monza'), [{ nick: 'Max', time: 80000 }]);
});

test('a faster lap from the SAME driver improves their own entry rather than adding a second one', () => {
  const store = new GhostStore({ filePath: tmpPath() });
  store.maybeUpdate('monza', { nick: 'Max', time: 80000, path: [[0, 0, 0, 0]] });
  store.maybeUpdate('monza', { nick: 'Max', time: 75000, path: [[0, 1, 1, 0]] });
  assert.deepEqual(store.top5('monza'), [{ nick: 'Max', time: 75000 }]);
});

test('one leaderboard slot per nickname: the same person never occupies two rows', () => {
  const store = new GhostStore({ filePath: tmpPath() });
  store.maybeUpdate('monza', { nick: 'Max', time: 80000, path: [[0, 0, 0, 0]] });
  store.maybeUpdate('monza', { nick: 'Lewis', time: 82000, path: [[0, 1, 1, 0]] });
  store.maybeUpdate('monza', { nick: 'Max', time: 78000, path: [[0, 2, 2, 0]] }); // Max improves
  const rows = store.top5('monza');
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((r) => r.nick === 'Max').length, 1);
  assert.deepEqual(rows, [{ nick: 'Max', time: 78000 }, { nick: 'Lewis', time: 82000 }]);
});

test('the leaderboard caps at 5, dropping the slowest when a 6th, faster driver arrives', () => {
  const store = new GhostStore({ filePath: tmpPath() });
  const names = ['A', 'B', 'C', 'D', 'E'];
  names.forEach((nick, i) => store.maybeUpdate('monza', { nick, time: 80000 + i * 1000, path: [[0, 0, 0, 0]] }));
  assert.equal(store.top5('monza').length, 5);

  store.maybeUpdate('monza', { nick: 'F', time: 80500, path: [[0, 0, 0, 0]] }); // faster than D and E
  const rows = store.top5('monza');
  assert.equal(rows.length, 5);
  assert.equal(rows.some((r) => r.nick === 'F'), true, 'the new, faster driver made the cut');
  assert.equal(rows.some((r) => r.nick === 'E'), false, 'the slowest of the old five was dropped');
});

test('a 6th driver slower than everyone already on the board does not make the cut', () => {
  const store = new GhostStore({ filePath: tmpPath() });
  const names = ['A', 'B', 'C', 'D', 'E'];
  names.forEach((nick, i) => store.maybeUpdate('monza', { nick, time: 80000 + i * 1000, path: [[0, 0, 0, 0]] }));
  store.maybeUpdate('monza', { nick: 'Z', time: 999000, path: [[0, 0, 0, 0]] });
  assert.equal(store.top5('monza').some((r) => r.nick === 'Z'), false);
  assert.equal(store.top5('monza').length, 5);
});

test('only the fastest entry carries a replay path; the rest are nick + time only', () => {
  const store = new GhostStore({ filePath: tmpPath() });
  store.maybeUpdate('monza', { nick: 'Max', time: 80000, path: [[0, 0, 0, 0]] });
  store.maybeUpdate('monza', { nick: 'Lewis', time: 82000, path: [[0, 1, 1, 0]] });
  const rows = store.top5('monza');
  assert.equal(rows.every((r) => !('path' in r)), true, 'top5() never exposes path data');
  assert.ok(Array.isArray(store.get('monza').path), 'but get() (the ghost car) still has the #1 path');
});

test('a record with an empty path is rejected', () => {
  const store = new GhostStore({ filePath: tmpPath() });
  const replaced = store.maybeUpdate('monza', { nick: 'Max', time: 80000, path: [] });
  assert.equal(replaced, false);
  assert.equal(store.get('monza'), undefined);
});

test('tracks are independent of each other', () => {
  const store = new GhostStore({ filePath: tmpPath() });
  store.maybeUpdate('monza', { nick: 'Max', time: 80000, path: [[0, 0, 0, 0]] });
  store.maybeUpdate('monaco', { nick: 'Charles', time: 70000, path: [[0, 0, 0, 0]] });
  assert.equal(store.get('monza').nick, 'Max');
  assert.equal(store.get('monaco').nick, 'Charles');
});

test('records persist to disk and survive reloading a fresh store from the same file', () => {
  const filePath = tmpPath();
  const first = new GhostStore({ filePath });
  first.maybeUpdate('suzuka', { nick: 'Max', time: 85000, path: [[0, 10, 20, 0.5], [100, 11, 21, 0.5]] });
  first.maybeUpdate('suzuka', { nick: 'Lewis', time: 86000, path: [[0, 10, 20, 0.5]] });

  const second = new GhostStore({ filePath });
  assert.deepEqual(second.get('suzuka'), { nick: 'Max', time: 85000, path: [[0, 10, 20, 0.5], [100, 11, 21, 0.5]] });
  assert.deepEqual(second.top5('suzuka'), [{ nick: 'Max', time: 85000 }, { nick: 'Lewis', time: 86000 }]);
});

test('a missing file is treated as empty, not a crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-ghosts-'));
  assert.doesNotThrow(() => new GhostStore({ filePath: path.join(dir, 'nope', 'ghosts.json') }));
});

test('a corrupt file is treated as empty, not a crash', () => {
  const filePath = tmpPath();
  fs.writeFileSync(filePath, '{ not valid json');
  let store;
  assert.doesNotThrow(() => { store = new GhostStore({ filePath }); });
  assert.equal(store.get('monza'), undefined);
});

test('malformed records in an otherwise valid file are skipped', () => {
  const filePath = tmpPath();
  fs.writeFileSync(filePath, JSON.stringify({
    monza: { nick: 'Max', time: 80000, path: [[0, 0, 0, 0]] },
    broken: { nick: 'NoTime' },
    alsoBroken: 'not an object',
  }));
  const store = new GhostStore({ filePath });
  assert.ok(store.get('monza'));
  assert.equal(store.get('broken'), undefined);
  assert.equal(store.get('alsoBroken'), undefined);
});

test('a legacy file (one record object per track, not yet a list) migrates cleanly on load', () => {
  const filePath = tmpPath();
  // The shape this project's data/ghosts.json actually had before the top-5 leaderboard existed.
  fs.writeFileSync(filePath, JSON.stringify({
    interlagos: { nick: '천식맨', time: 17963, path: [[13, 6739, 3422, -13.78], [113, 6769, 3323, -13.88]] },
  }));
  const store = new GhostStore({ filePath });
  assert.deepEqual(store.get('interlagos'), {
    nick: '천식맨', time: 17963, path: [[13, 6739, 3422, -13.78], [113, 6769, 3323, -13.88]],
  });
  assert.deepEqual(store.top5('interlagos'), [{ nick: '천식맨', time: 17963 }]);

  // And the store keeps working normally (top-5, dedup) for that track from here on.
  store.maybeUpdate('interlagos', { nick: 'Newcomer', time: 15000, path: [[0, 0, 0, 0]] });
  assert.equal(store.get('interlagos').nick, 'Newcomer');
  assert.equal(store.top5('interlagos').length, 2);
});

test('a legacy single record with a broken path is still rejected after migration', () => {
  const filePath = tmpPath();
  fs.writeFileSync(filePath, JSON.stringify({ monza: { nick: 'Max', time: 80000, path: 'not-an-array' } }));
  const store = new GhostStore({ filePath });
  assert.equal(store.get('monza'), undefined);
});
