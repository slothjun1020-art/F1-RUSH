// Per-track best-lap records: up to the 5 fastest laps anyone has ever completed, one slot per nickname
// (a faster new lap replaces that person's old one rather than taking a second slot). Only the fastest
// entry carries a ~100ms-spaced position trail — it's the only one ever replayed as a ghost car; the rest
// are nickname + time for the lobby leaderboard (see server/rooms.js, which records candidate laps during
// a race and reads this back, and public/ghost.js, which replays the trail). Independent of the
// room/network layer, like rooms.js, so it can be unit-tested with a fake in-memory Redis client.
//
// Persisted to a single Upstash Redis key (one small JSON blob, not a key per track) rather than a local
// file: Render's free plan has no persistent disk, so anything written to the filesystem is gone on the
// next deploy or cold start. Reads (get/top5) stay synchronous off an in-memory cache — Room calls those
// many times a second (every broadcast), and a network round trip there would be both slow and pointless
// (the cache is always the latest state this process itself wrote). Only load() and the save triggered by
// maybeUpdate() touch the network.

const REDIS_KEY = 'f1rush:ghosts';
const TOP_N = 5;

export class GhostStore {
  constructor({ redis }) {
    this.redis = redis; // minimal interface: async get(key) and async set(key, value)
    this.records = new Map(); // trackId -> [{ nick, time, path? }, ...] sorted fastest-first, length <= TOP_N
  }

  // Must be awaited once (server/index.js does this at startup) before get()/top5() reflect anything
  // written in a previous run. Safe to call again later; it just re-populates the in-memory cache.
  async load() {
    let raw;
    try {
      raw = await this.redis.get(REDIS_KEY);
    } catch (err) {
      console.warn('ghost store: failed to load from Redis, starting empty:', err.message);
      return;
    }
    if (!raw) return; // key doesn't exist yet (first run ever)
    let parsed = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch { return; } // corrupt value: start empty, don't crash
    }
    if (!parsed || typeof parsed !== 'object') return;
    for (const [trackId, value] of Object.entries(parsed)) {
      // Older data stored one record per track directly (not yet wrapped in a list); treat that as a
      // one-entry top list rather than discarding it.
      const list = Array.isArray(value) ? value : [value];
      const valid = list.filter(isValidEntry).slice(0, TOP_N);
      if (valid.length) this.records.set(trackId, valid);
    }
  }

  // The fastest lap for this track (with its replay path), or undefined — what the ghost car replays.
  get(trackId) {
    return this.records.get(trackId)?.[0];
  }

  // Up to TOP_N { nick, time } rows for the lobby leaderboard, fastest first, no path.
  top5(trackId) {
    return (this.records.get(trackId) ?? []).map(({ nick, time }) => ({ nick, time }));
  }

  // Inserts or improves this nick's entry (one slot per nickname — the only "same person" signal this
  // app has, since there's no login), re-sorts, caps at TOP_N, and keeps the replay path only on whatever
  // ends up fastest. Persists to Redis on any change. Returns true if the stored data changed. Callers in
  // rooms.js don't await this (the readable-synchronously cache above is updated immediately either way)
  // — it's async only so the Redis write can be awaited by tests that need the write to have landed.
  async maybeUpdate(trackId, { nick, time, path: points }) {
    if (!points.length) return false;
    const list = this.records.get(trackId) ?? [];
    const existing = list.find((r) => r.nick === nick);
    if (existing && existing.time <= time) return false;
    const next = list.filter((r) => r.nick !== nick);
    next.push({ nick, time, path: points });
    next.sort((a, b) => a.time - b.time);
    next.length = Math.min(next.length, TOP_N);
    next.forEach((r, i) => { if (i > 0) delete r.path; });
    this.records.set(trackId, next);
    await this.save();
    return true;
  }

  async save() {
    const out = {};
    for (const [trackId, list] of this.records) out[trackId] = list;
    try {
      await this.redis.set(REDIS_KEY, JSON.stringify(out));
    } catch (err) {
      console.warn('ghost store: failed to save to Redis:', err.message);
    }
  }
}

// path is optional (only the fastest entry in a track's list carries one) but must be an array if present.
function isValidEntry(rec) {
  return !!rec && typeof rec.nick === 'string' && typeof rec.time === 'number'
    && (rec.path === undefined || Array.isArray(rec.path));
}
