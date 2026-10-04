import test from 'node:test';
import assert from 'node:assert/strict';
import { GhostStore } from '../server/ghosts.js';

// A minimal fake standing in for the @upstash/redis client (just get/set on one key), so these tests
// never touch a real Upstash account or the network.
function fakeRedis() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async set(key, value) { store.set(key, value); return 'OK'; },
  };
}

async function freshStore(redis = fakeRedis()) {
  const store = new GhostStore({ redis });
  await store.load();
  return store;
}

test('starts empty when there is nothing in Redis yet', async () => {
  const store = await freshStore();
  assert.equal(store.get('monza'), undefined);
  assert.deepEqual(store.top5('monza'), []);
});

test('the first record for a track is always kept, as the sole (fastest) entry', async () => {
  const store = await freshStore();
  const replaced = await store.maybeUpdate('monza', { nick: 'Max', time: 80000, path: [[0, 0, 0, 0]] });
  assert.equal(replaced, true);
  assert.deepEqual(store.get('monza'), { nick: 'Max', time: 80000, path: [[0, 0, 0, 0]] });
  assert.deepEqual(store.top5('monza'), [{ nick: 'Max', time: 80000 }]);
});

test('a faster lap from a different driver takes over as the fastest (ghost) entry', async () => {
  const store = await freshStore();
  await store.maybeUpdate('monza', { nick: 'Max', time: 80000, path: [[0, 0, 0, 0]] });
  const replaced = await store.maybeUpdate('monza', { nick: 'Lewis', time: 79000, path: [[0, 2, 2, 0]] });
  assert.equal(replaced, true);
  assert.equal(store.get('monza').nick, 'Lewis');
  assert.equal(store.get('monza').time, 79000);
});

test('a slower lap from a different driver still joins the leaderboard, without dethroning the leader', async () => {
  const store = await freshStore();
  await store.maybeUpdate('monza', { nick: 'Max', time: 80000, path: [[0, 0, 0, 0]] });
  const replaced = await store.maybeUpdate('monza', { nick: 'Slow', time: 90000, path: [[0, 1, 1, 0]] });
  assert.equal(replaced, true, 'the leaderboard itself changed (a new row), even though #1 did not');
  assert.equal(store.get('monza').nick, 'Max', 'the ghost car still replays the faster lap');
  assert.deepEqual(store.top5('monza'), [{ nick: 'Max', time: 80000 }, { nick: 'Slow', time: 90000 }]);
});

test('a slower lap from the SAME driver does not replace their own leaderboard entry', async () => {
  const store = await freshStore();
  await store.maybeUpdate('monza', { nick: 'Max', time: 80000, path: [[0, 0, 0, 0]] });
  const replaced = await store.maybeUpdate('monza', { nick: 'Max', time: 85000, path: [[0, 9, 9, 0]] });
  assert.equal(replaced, false);
  assert.equal(store.get('monza').time, 80000);
  assert.deepEqual(store.top5('monza'), [{ nick: 'Max', time: 80000 }]);
});

test('a faster lap from the SAME driver improves their own entry rather than adding a second one', async () => {
  const store = await freshStore();
  await store.maybeUpdate('monza', { nick: 'Max', time: 80000, path: [[0, 0, 0, 0]] });
  await store.maybeUpdate('monza', { nick: 'Max', time: 75000, path: [[0, 1, 1, 0]] });
  assert.deepEqual(store.top5('monza'), [{ nick: 'Max', time: 75000 }]);
});

test('one leaderboard slot per nickname: the same person never occupies two rows', async () => {
  const store = await freshStore();
  await store.maybeUpdate('monza', { nick: 'Max', time: 80000, path: [[0, 0, 0, 0]] });
  await store.maybeUpdate('monza', { nick: 'Lewis', time: 82000, path: [[0, 1, 1, 0]] });
  await store.maybeUpdate('monza', { nick: 'Max', time: 78000, path: [[0, 2, 2, 0]] }); // Max improves
  const rows = store.top5('monza');
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((r) => r.nick === 'Max').length, 1);
  assert.deepEqual(rows, [{ nick: 'Max', time: 78000 }, { nick: 'Lewis', time: 82000 }]);
});

test('the leaderboard caps at 5, dropping the slowest when a 6th, faster driver arrives', async () => {
  const store = await freshStore();
  const names = ['A', 'B', 'C', 'D', 'E'];
  for (const [i, nick] of names.entries()) {
    await store.maybeUpdate('monza', { nick, time: 80000 + i * 1000, path: [[0, 0, 0, 0]] });
  }
  assert.equal(store.top5('monza').length, 5);

  await store.maybeUpdate('monza', { nick: 'F', time: 80500, path: [[0, 0, 0, 0]] }); // faster than D and E
  const rows = store.top5('monza');
  assert.equal(rows.length, 5);
  assert.equal(rows.some((r) => r.nick === 'F'), true, 'the new, faster driver made the cut');
  assert.equal(rows.some((r) => r.nick === 'E'), false, 'the slowest of the old five was dropped');
});

test('a 6th driver slower than everyone already on the board does not make the cut', async () => {
  const store = await freshStore();
  const names = ['A', 'B', 'C', 'D', 'E'];
  for (const [i, nick] of names.entries()) {
    await store.maybeUpdate('monza', { nick, time: 80000 + i * 1000, path: [[0, 0, 0, 0]] });
  }
  await store.maybeUpdate('monza', { nick: 'Z', time: 999000, path: [[0, 0, 0, 0]] });
  assert.equal(store.top5('monza').some((r) => r.nick === 'Z'), false);
  assert.equal(store.top5('monza').length, 5);
});

test('only the fastest entry carries a replay path; the rest are nick + time only', async () => {
  const store = await freshStore();
  await store.maybeUpdate('monza', { nick: 'Max', time: 80000, path: [[0, 0, 0, 0]] });
  await store.maybeUpdate('monza', { nick: 'Lewis', time: 82000, path: [[0, 1, 1, 0]] });
  const rows = store.top5('monza');
  assert.equal(rows.every((r) => !('path' in r)), true, 'top5() never exposes path data');
  assert.ok(Array.isArray(store.get('monza').path), 'but get() (the ghost car) still has the #1 path');
});

test('a record with an empty path is rejected', async () => {
  const store = await freshStore();
  const replaced = await store.maybeUpdate('monza', { nick: 'Max', time: 80000, path: [] });
  assert.equal(replaced, false);
  assert.equal(store.get('monza'), undefined);
});

test('tracks are independent of each other', async () => {
  const store = await freshStore();
  await store.maybeUpdate('monza', { nick: 'Max', time: 80000, path: [[0, 0, 0, 0]] });
  await store.maybeUpdate('monaco', { nick: 'Charles', time: 70000, path: [[0, 0, 0, 0]] });
  assert.equal(store.get('monza').nick, 'Max');
  assert.equal(store.get('monaco').nick, 'Charles');
});

test('records persist to Redis and survive loading a fresh store from the same backing store', async () => {
  const redis = fakeRedis();
  const first = await freshStore(redis);
  await first.maybeUpdate('suzuka', { nick: 'Max', time: 85000, path: [[0, 10, 20, 0.5], [100, 11, 21, 0.5]] });
  await first.maybeUpdate('suzuka', { nick: 'Lewis', time: 86000, path: [[0, 10, 20, 0.5]] });

  const second = await freshStore(redis); // same underlying fake Redis "database"
  assert.deepEqual(second.get('suzuka'), { nick: 'Max', time: 85000, path: [[0, 10, 20, 0.5], [100, 11, 21, 0.5]] });
  assert.deepEqual(second.top5('suzuka'), [{ nick: 'Max', time: 85000 }, { nick: 'Lewis', time: 86000 }]);
});

test('a Redis read failure at startup is treated as empty, not a crash', async () => {
  const redis = { get: async () => { throw new Error('network down'); }, set: fakeRedis().set };
  let store;
  await assert.doesNotReject(async () => { store = await freshStore(redis); });
  assert.equal(store.get('monza'), undefined);
});

test('a Redis write failure does not throw, and the in-memory state still updates', async () => {
  const redis = { get: async () => null, set: async () => { throw new Error('network down'); } };
  const store = await freshStore(redis);
  let replaced;
  await assert.doesNotReject(async () => {
    replaced = await store.maybeUpdate('monza', { nick: 'Max', time: 80000, path: [[0, 0, 0, 0]] });
  });
  assert.equal(replaced, true, 'the write to Redis failed, but the record still applied locally');
  assert.equal(store.get('monza').nick, 'Max');
});

test('a corrupt value in Redis is treated as empty, not a crash', async () => {
  const redis = fakeRedis();
  redis.store.set('f1rush:ghosts', '{ not valid json');
  let store;
  await assert.doesNotReject(async () => { store = await freshStore(redis); });
  assert.equal(store.get('monza'), undefined);
});

test('malformed records in an otherwise valid value are skipped', async () => {
  const redis = fakeRedis();
  redis.store.set('f1rush:ghosts', JSON.stringify({
    monza: [{ nick: 'Max', time: 80000, path: [[0, 0, 0, 0]] }],
    broken: [{ nick: 'NoTime' }],
    alsoBroken: 'not an array or object',
  }));
  const store = await freshStore(redis);
  assert.ok(store.get('monza'));
  assert.equal(store.get('broken'), undefined);
  assert.equal(store.get('alsoBroken'), undefined);
});

test('a legacy value (one record object per track, not yet a list) migrates cleanly on load', async () => {
  const redis = fakeRedis();
  // The shape this project's storage actually had before the top-5 leaderboard existed.
  redis.store.set('f1rush:ghosts', JSON.stringify({
    interlagos: { nick: '천식맨', time: 17963, path: [[13, 6739, 3422, -13.78], [113, 6769, 3323, -13.88]] },
  }));
  const store = await freshStore(redis);
  assert.deepEqual(store.get('interlagos'), {
    nick: '천식맨', time: 17963, path: [[13, 6739, 3422, -13.78], [113, 6769, 3323, -13.88]],
  });
  assert.deepEqual(store.top5('interlagos'), [{ nick: '천식맨', time: 17963 }]);

  // And the store keeps working normally (top-5, dedup) for that track from here on.
  await store.maybeUpdate('interlagos', { nick: 'Newcomer', time: 15000, path: [[0, 0, 0, 0]] });
  assert.equal(store.get('interlagos').nick, 'Newcomer');
  assert.equal(store.top5('interlagos').length, 2);
});

test('a legacy single record with a broken path is still rejected after migration', async () => {
  const redis = fakeRedis();
  redis.store.set('f1rush:ghosts', JSON.stringify({ monza: { nick: 'Max', time: 80000, path: 'not-an-array' } }));
  const store = await freshStore(redis);
  assert.equal(store.get('monza'), undefined);
});
