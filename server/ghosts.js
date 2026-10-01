// Per-track best-lap records: up to the 5 fastest laps anyone has ever completed, one slot per nickname
// (a faster new lap replaces that person's old one rather than taking a second slot). Only the fastest
// entry carries a ~100ms-spaced position trail — it's the only one ever replayed as a ghost car; the rest
// are nickname + time for the lobby leaderboard (see server/rooms.js, which records candidate laps during
// a race and reads this back, and public/ghost.js, which replays the trail). Independent of the
// room/network layer, like rooms.js, so it can be unit-tested with a throwaway file.

import fs from 'node:fs';
import path from 'node:path';

const TOP_N = 5;

export class GhostStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.records = new Map(); // trackId -> [{ nick, time, path? }, ...] sorted fastest-first, length <= TOP_N
    this.load();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return; // no file yet (first run, or it was deleted) — start empty
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [trackId, value] of Object.entries(parsed)) {
          // Older files stored one record per track directly (not yet wrapped in a list); treat that as
          // a one-entry top list rather than discarding it.
          const list = Array.isArray(value) ? value : [value];
          const valid = list.filter(isValidEntry).slice(0, TOP_N);
          if (valid.length) this.records.set(trackId, valid);
        }
      }
    } catch {
      // Corrupt file: start empty rather than crash the server over stale data.
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
  // ends up fastest. Persists to disk on any change. Returns true if the stored data changed.
  maybeUpdate(trackId, { nick, time, path: points }) {
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
    this.save();
    return true;
  }

  save() {
    const out = {};
    for (const [trackId, list] of this.records) out[trackId] = list;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(out));
    } catch (err) {
      console.warn('ghost store: failed to save', err.message);
    }
  }
}

// path is optional (only the fastest entry in a track's list carries one) but must be an array if present.
function isValidEntry(rec) {
  return !!rec && typeof rec.nick === 'string' && typeof rec.time === 'number'
    && (rec.path === undefined || Array.isArray(rec.path));
}
